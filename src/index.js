import crypto from "crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { Octokit } from "@octokit/rest";
import { buildStateBootPacket } from "./stateBoot.js";
import {
  formatStateValidationResponse,
  prepareOuStateWrite,
} from "./ouStateWritePreflight.js";
import {
  buildProductionStatusPacket,
  observeProductionTarget,
  parseProductionTargets,
} from "./productionStatus.js";
import {
  createAuthorizationConsumer,
  issueActionAuthorization,
} from "./actionAuthorization.js";
import {
  assertAuthorizedRequestMatches,
  evaluateDeploymentObservation,
  evaluateDeploymentReadiness,
  evaluateMergeReadiness,
  parseDeploymentHooks,
  triggerExactCommitDeploy,
} from "./guardedExecution.js";

console.log("BRIDGE_BUILD", new Date().toISOString(), "COMMIT_MARK=bridge-guarded-execution-v1");

const app = express();
app.use(express.json({ limit: "10mb" }));

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 10000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";

const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const AUTH_MODE = (process.env.GITHUB_AUTH_MODE || "pat").toLowerCase();

// GitHub App (optional)
const APP_ID = process.env.GITHUB_APP_ID;
const PRIVATE_KEY_RAW = process.env.GITHUB_APP_PRIVATE_KEY;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;

// PAT fallback
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Read safety
const MAX_READ_FILE_BYTES = Number(process.env.MAX_READ_FILE_BYTES || 1024 * 1024);

// OU-State boot and validation safety
const OU_STATE_REPO = process.env.OU_STATE_REPO || "Optical-Underground/OU-State";
const OU_STATE_REF = process.env.OU_STATE_REF || "main";

// Read-only production verification targets. URLs can only come from server configuration.
const PRODUCTION_TARGETS = parseProductionTargets(process.env.PRODUCTION_TARGETS_JSON || "");
const MAX_DEPLOYMENT_RESPONSE_BYTES = Number(
  process.env.MAX_DEPLOYMENT_RESPONSE_BYTES || 256 * 1024
);
const DEPLOYMENT_PROBE_TIMEOUT_MS = Number(
  process.env.DEPLOYMENT_PROBE_TIMEOUT_MS || 10_000
);

// High-risk actions use a short-lived, signed, single-use authorization issued only after
// a fresh read-only preflight. Render deploy-hook URLs remain server-side secrets.
const ACTION_AUTHORIZATION_SECRET = process.env.ACTION_AUTHORIZATION_SECRET || BRIDGE_SECRET;
const ACTION_AUTHORIZATION_TTL_SECONDS = Number(
  process.env.ACTION_AUTHORIZATION_TTL_SECONDS || 300
);
const DEPLOYMENT_HOOKS = parseDeploymentHooks(process.env.DEPLOYMENT_HOOKS_JSON || "");
const consumeActionAuthorization = createAuthorizationConsumer({
  secret: ACTION_AUTHORIZATION_SECRET,
});

// --------------------
// Helpers
// --------------------
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireBridgeSecret(req, res) {
  if (!BRIDGE_SECRET) {
    res.status(500).json({ error: "Missing env: BRIDGE_SECRET" });
    return true;
  }

  const provided = req.header("x-bridge-secret") || "";
  if (!timingSafeEqualStr(provided, BRIDGE_SECRET)) {
    res.status(403).json({ error: "Forbidden" });
    return true;
  }

  return false;
}

function isRepoAllowed(fullRepo) {
  if (!ALLOWED_REPOS.length) return true;
  return ALLOWED_REPOS.includes(fullRepo);
}

function isRepoExplicitlyAllowedForExecution(fullRepo) {
  return ALLOWED_REPOS.includes(fullRepo);
}

function parseRepo(fullRepo) {
  const parts = String(fullRepo || "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid repo format. Use owner/repo.");
  }
  return { owner: parts[0], repo: parts[1] };
}

function slugifyBranch(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeBranchName(branch) {
  return String(branch || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^heads\//, "");
}

function normalizePrivateKey() {
  if (!PRIVATE_KEY_RAW) return null;
  return PRIVATE_KEY_RAW.includes("\\n")
    ? PRIVATE_KEY_RAW.replace(/\\n/g, "\n")
    : PRIVATE_KEY_RAW;
}

function createAppJwt() {
  const key = normalizePrivateKey();
  if (!key) throw new Error("Missing GitHub App private key");
  if (!APP_ID) throw new Error("Missing GitHub App ID");

  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iat: now - 60,
      exp: now + 9 * 60,
      iss: APP_ID,
    },
    key,
    { algorithm: "RS256" }
  );
}

async function getAppOctokit() {
  const appJwt = createAppJwt();
  return new Octokit({ auth: appJwt });
}

async function getInstallationIdForRepo(owner, repoName) {
  const appOctokit = await getAppOctokit();

  try {
    const installationResp = await appOctokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo: repoName }
    );
    return installationResp.data.id;
  } catch (err) {
    if (INSTALLATION_ID) {
      return Number(INSTALLATION_ID);
    }
    throw new Error(
      `Could not resolve GitHub App installation for ${owner}/${repoName}: ${err?.message || String(err)}`
    );
  }
}

async function getOctokitForRepo(owner, repoName) {
  if (AUTH_MODE === "app") {
    if (!APP_ID || !PRIVATE_KEY_RAW) {
      throw new Error("Missing GitHub App configuration");
    }

    const appOctokit = await getAppOctokit();
    const installationId = await getInstallationIdForRepo(owner, repoName);

    const tokenResp = await appOctokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: Number(installationId) }
    );

    return new Octokit({ auth: tokenResp.data.token });
  }

  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN");
  }

  return new Octokit({ auth: GITHUB_TOKEN });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRepoCommitAndTree({ octokit, owner, repoName, ref }) {
  const commitResp = await octokit.repos.getCommit({ owner, repo: repoName, ref });
  const commitSha = commitResp.data.sha;
  const treeSha = commitResp.data.commit?.tree?.sha;

  if (!treeSha) {
    throw new Error("Could not resolve tree sha");
  }

  const treeResp = await octokit.git.getTree({
    owner,
    repo: repoName,
    tree_sha: treeSha,
    recursive: "true",
  });

  const tree = (treeResp.data.tree || [])
    .filter((n) => n?.path && (n.type === "tree" || n.type === "blob"))
    .map((n) => ({
      path: n.path,
      type: n.type === "tree" ? "dir" : "file",
      size: n.size ?? 0,
    }));

  return {
    commit: commitSha,
    treeSha,
    tree,
  };
}

async function createPullRequestWithRetry({
  octokit,
  owner,
  repoName,
  base,
  head,
  title,
  body,
  draft,
}) {
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(
        `PR_CREATE_ATTEMPT attempt=${attempt} owner=${owner} repo=${repoName} base=${base} head=${head}`
      );

      const pr = await octokit.pulls.create({
        owner,
        repo: repoName,
        base,
        head,
        title,
        body,
        draft,
      });

      return pr;
    } catch (err) {
      const ghErrors = Array.isArray(err?.response?.data?.errors)
        ? err.response.data.errors
        : [];

      const headInvalid = ghErrors.some(
        (e) => e?.resource === "PullRequest" && e?.field === "head" && e?.code === "invalid"
      );

      console.log(
        `PR_CREATE_ERROR attempt=${attempt} status=${err?.status || ""} message=${err?.message || String(err)} headInvalid=${headInvalid}`
      );

      if (!headInvalid || attempt === maxAttempts) {
        throw err;
      }

      await sleep(800 * attempt);
    }
  }

  throw new Error("PR creation retry loop exited unexpectedly");
}

async function getTextFileFromRepo({ octokit, owner, repoName, path, ref }) {
  if (!path || typeof path !== "string") {
    throw new Error("path required");
  }

  const resp = await octokit.repos.getContent({
    owner,
    repo: repoName,
    path,
    ref,
  });

  if (Array.isArray(resp.data)) {
    throw new Error(`Path is a directory: ${path}`);
  }

  const file = resp.data;

  if (file.type !== "file") {
    throw new Error(`Path is not a file: ${path}`);
  }

  const size = Number(file.size || 0);
  if (size > MAX_READ_FILE_BYTES) {
    throw new Error(
      `File too large to return as text: ${path} (${size} bytes > ${MAX_READ_FILE_BYTES} bytes)`
    );
  }

  const base64 = String(file.content || "").replace(/\n/g, "");
  const buf = Buffer.from(base64, "base64");

  return {
    path,
    sha: file.sha,
    size,
    encoding: "utf-8",
    content: buf.toString("utf8"),
  };
}

async function fetchConfiguredDeploymentJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(DEPLOYMENT_PROBE_TIMEOUT_MS),
  });

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_DEPLOYMENT_RESPONSE_BYTES) {
    throw new Error("deployment_response_too_large");
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_DEPLOYMENT_RESPONSE_BYTES) {
    throw new Error("deployment_response_too_large");
  }

  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("deployment_response_not_json");
    }
  }

  return {
    ok: response.ok,
    http_status: response.status,
    body,
    error: response.ok ? null : `deployment_http_${response.status}`,
  };
}

async function getPullContext({ octokit, owner, repoName, prNumber }) {
  const pullResponse = await octokit.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNumber,
  });
  const pull = pullResponse.data;
  const [reviewsResponse, checkRunsResponse, combinedStatusResponse] = await Promise.all([
    octokit.pulls.listReviews({
      owner,
      repo: repoName,
      pull_number: prNumber,
      per_page: 100,
    }),
    octokit.checks.listForRef({
      owner,
      repo: repoName,
      ref: pull.head.sha,
      per_page: 100,
    }),
    octokit.repos.getCombinedStatusForRef({
      owner,
      repo: repoName,
      ref: pull.head.sha,
      per_page: 100,
    }),
  ]);

  return {
    pull,
    reviews: reviewsResponse.data || [],
    checkRuns: checkRunsResponse.data.check_runs || [],
    combinedStatus: {
      state: combinedStatusResponse.data.state || "none",
      total_count:
        combinedStatusResponse.data.total_count || combinedStatusResponse.data.statuses?.length || 0,
    },
  };
}

function parsePositivePrNumber(value) {
  const prNumber = Number(value);
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

function authorizationErrorStatus(err) {
  const message = err?.message || String(err);
  if (message.startsWith("authorization_token_")) return 400;
  if (err?.status === 404) return 404;
  if (err?.status === 405 || err?.status === 409 || err?.status === 422) return 409;
  return 500;
}

async function handleReposSnapshot(req, res) {
  if (requireBridgeSecret(req, res)) return;

  const { repo, ref = "main", paths = [], depth = 3 } = req.body || {};

  if (!repo || !ref) {
    return res.status(400).json({ error: "repo and ref required" });
  }

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "Repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);
    const snapshot = await getRepoCommitAndTree({ octokit, owner, repoName, ref });

    const maxDepth = Number.isFinite(Number(depth)) ? Number(depth) : 3;
    const tree = snapshot.tree.filter((n) => String(n.path).split("/").length <= maxDepth);

    const files = [];
    if (Array.isArray(paths) && paths.length) {
      for (const p of paths) {
        files.push(
          await getTextFileFromRepo({
            octokit,
            owner,
            repoName,
            path: p,
            ref,
          })
        );
      }
    }

    res.json({
      ok: true,
      repo,
      ref,
      commit: snapshot.commit,
      tree,
      files,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

async function handleReadFile(req, res) {
  if (requireBridgeSecret(req, res)) return;

  const { repo, ref = "main", path } = req.body || {};

  if (!repo || !path) {
    return res.status(400).json({ error: "repo and path required" });
  }

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "Repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);

    const file = await getTextFileFromRepo({
      octokit,
      owner,
      repoName,
      path,
      ref,
    });

    res.json({
      ok: true,
      repo,
      ref,
      ...file,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

async function handleStateBoot(req, res) {
  if (requireBridgeSecret(req, res)) return;

  const { front, project, ref = OU_STATE_REF } = req.body || {};
  const repo = OU_STATE_REPO;
  const requestedFront = front || project || null;

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "OU-State repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);

    const packet = await buildStateBootPacket({
      octokit,
      owner,
      repoName,
      repo,
      ref,
      requestedFront,
      getRepoCommitAndTree,
      readTextFile: (path, fileRef) =>
        getTextFileFromRepo({
          octokit,
          owner,
          repoName,
          path,
          ref: fileRef || ref,
        }),
    });

    res.json(packet);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
}

async function prepareLiveOuStateWrite({ octokit, owner, repoName, ref, baseCommit, edits }) {
  return prepareOuStateWrite({
    baseCommit,
    edits,
    resolveSnapshot: () => getRepoCommitAndTree({ octokit, owner, repoName, ref }),
    readTextFile: (path, immutableRef) =>
      getTextFileFromRepo({
        octokit,
        owner,
        repoName,
        path,
        ref: immutableRef,
      }),
  });
}

async function handleStateValidate(req, res) {
  if (requireBridgeSecret(req, res)) return;

  const { base_commit: baseCommit, edits = [], ref = OU_STATE_REF } = req.body || {};

  if (!Array.isArray(edits)) {
    return res.status(400).json({ error: "edits must be an array" });
  }

  if (!isRepoAllowed(OU_STATE_REPO)) {
    return res.status(403).json({ error: "OU-State repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(OU_STATE_REPO);
    const octokit = await getOctokitForRepo(owner, repoName);
    const { validation } = await prepareLiveOuStateWrite({
      octokit,
      owner,
      repoName,
      ref,
      baseCommit,
      edits,
    });

    res.status(200).json(formatStateValidationResponse(validation));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
}

async function handleProductionStatus(req, res) {
  if (requireBridgeSecret(req, res)) return;

  const repo = req.body?.repo;
  const prNumber = Number(req.body?.pr_number);

  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return res.status(400).json({ error: "repo and positive integer pr_number required" });
  }

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "Repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);

    const packet = await buildProductionStatusPacket({
      repo,
      prNumber,
      target: PRODUCTION_TARGETS[repo] || null,
      getPullRequest: async () => {
        const response = await octokit.pulls.get({
          owner,
          repo: repoName,
          pull_number: prNumber,
        });
        return response.data;
      },
      getReviews: async () => {
        const response = await octokit.pulls.listReviews({
          owner,
          repo: repoName,
          pull_number: prNumber,
          per_page: 100,
        });
        return response.data;
      },
      getCheckRuns: async (ref) => {
        const response = await octokit.checks.listForRef({
          owner,
          repo: repoName,
          ref,
          per_page: 100,
        });
        return response.data.check_runs || [];
      },
      getCombinedStatus: async (ref) => {
        const response = await octokit.repos.getCombinedStatusForRef({
          owner,
          repo: repoName,
          ref,
          per_page: 100,
        });
        return {
          state: response.data.state || "none",
          total_count: response.data.total_count || response.data.statuses?.length || 0,
        };
      },
      fetchDeploymentJson: fetchConfiguredDeploymentJson,
    });

    return res.status(200).json(packet);
  } catch (err) {
    const status = err?.status === 404 ? 404 : 500;
    return res.status(status).json({ error: err?.message || String(err) });
  }
}

async function handleMergePrepare(req, res) {
  if (requireBridgeSecret(req, res)) return;

  const repo = req.body?.repo;
  const prNumber = parsePositivePrNumber(req.body?.pr_number);
  const expectedHeadCommit = req.body?.expected_head_commit;

  if (!repo || !prNumber || !expectedHeadCommit) {
    return res.status(400).json({
      error: "repo, positive integer pr_number, and expected_head_commit required",
    });
  }
  if (!isRepoExplicitlyAllowedForExecution(repo)) {
    return res.status(403).json({ error: "Repo not explicitly allowed for guarded execution" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);
    const context = await getPullContext({ octokit, owner, repoName, prNumber });
    const readiness = evaluateMergeReadiness({
      pull: context.pull,
      expectedHeadCommit,
      expectedBaseCommit: context.pull.base.sha,
      reviews: context.reviews,
      checkRuns: context.checkRuns,
      combinedStatus: context.combinedStatus,
    });

    if (!readiness.ready) {
      return res.status(200).json({ ok: true, ready: false, ...readiness });
    }

    const authorization = issueActionAuthorization({
      secret: ACTION_AUTHORIZATION_SECRET,
      operation: "merge",
      details: {
        repo,
        pr_number: prNumber,
        expected_head_commit: expectedHeadCommit,
        expected_base_commit: context.pull.base.sha,
        merge_method: "merge",
      },
      ttlSeconds: ACTION_AUTHORIZATION_TTL_SECONDS,
    });

    return res.status(200).json({
      ok: true,
      ready: true,
      errors: [],
      snapshot: readiness.snapshot,
      authorization_token: authorization.token,
      expires_at: authorization.payload.expires_at,
      expected_base_commit: context.pull.base.sha,
      approval_required: true,
    });
  } catch (err) {
    return res.status(err?.status === 404 ? 404 : 500).json({
      error: err?.message || String(err),
    });
  }
}

async function handleMergeExecute(req, res) {
  if (requireBridgeSecret(req, res)) return;

  try {
    const authorization = consumeActionAuthorization({
      token: req.body?.authorization_token,
      operation: "merge",
    });
    const {
      repo,
      pr_number: prNumber,
      expected_head_commit: expectedHeadCommit,
      expected_base_commit: expectedBaseCommit,
    } = authorization.details || {};
    assertAuthorizedRequestMatches({
      authorizationDetails: authorization.details,
      requestDetails: {
        repo: req.body?.repo,
        pr_number: req.body?.pr_number,
        expected_head_commit: req.body?.expected_head_commit,
        expected_base_commit: req.body?.expected_base_commit,
      },
      fields: ["repo", "pr_number", "expected_head_commit", "expected_base_commit"],
    });

    if (!repo || !parsePositivePrNumber(prNumber) || !expectedHeadCommit || !expectedBaseCommit) {
      throw new Error("authorization_token_scope_mismatch");
    }
    if (!isRepoExplicitlyAllowedForExecution(repo)) {
      return res.status(403).json({ error: "Repo not explicitly allowed for guarded execution" });
    }

    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);
    const context = await getPullContext({ octokit, owner, repoName, prNumber });
    const readiness = evaluateMergeReadiness({
      pull: context.pull,
      expectedHeadCommit,
      expectedBaseCommit,
      reviews: context.reviews,
      checkRuns: context.checkRuns,
      combinedStatus: context.combinedStatus,
    });

    if (!readiness.ready) {
      return res.status(200).json({
        ok: true,
        executed: false,
        valid: false,
        ...readiness,
      });
    }

    const response = await octokit.pulls.merge({
      owner,
      repo: repoName,
      pull_number: prNumber,
      merge_method: "merge",
      sha: expectedHeadCommit,
    });

    return res.status(200).json({
      ok: true,
      executed: Boolean(response.data.merged),
      merged: Boolean(response.data.merged),
      merge_commit: response.data.sha || null,
      message: response.data.message || null,
      repo,
      pr_number: prNumber,
      expected_head_commit: expectedHeadCommit,
      expected_base_commit: expectedBaseCommit,
      rollback: {
        pre_merge_base_commit: expectedBaseCommit,
        merged_head_commit: expectedHeadCommit,
      },
    });
  } catch (err) {
    return res.status(authorizationErrorStatus(err)).json({
      error: err?.message || String(err),
    });
  }
}

async function handleDeploymentPrepare(req, res) {
  if (requireBridgeSecret(req, res)) return;

  const repo = req.body?.repo;
  const prNumber = parsePositivePrNumber(req.body?.pr_number);
  const expectedMergeCommit = req.body?.expected_merge_commit;

  if (!repo || !prNumber || !expectedMergeCommit) {
    return res.status(400).json({
      error: "repo, positive integer pr_number, and expected_merge_commit required",
    });
  }
  if (!isRepoExplicitlyAllowedForExecution(repo)) {
    return res.status(403).json({ error: "Repo not explicitly allowed for guarded execution" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);
    const response = await octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });
    const readiness = evaluateDeploymentReadiness({
      pull: response.data,
      expectedMergeCommit,
      target: PRODUCTION_TARGETS[repo] || null,
      hook: DEPLOYMENT_HOOKS[repo] || null,
    });

    if (!readiness.ready) {
      return res.status(200).json({ ok: true, ready: false, ...readiness });
    }

    const target = PRODUCTION_TARGETS[repo];
    const observation = await observeProductionTarget({
      target,
      fetchDeploymentJson: fetchConfiguredDeploymentJson,
    });
    const deploymentState = evaluateDeploymentObservation({
      observation,
      expectedMergeCommit,
    });
    if (!deploymentState.ready) {
      return res.status(200).json({
        ok: true,
        ready: false,
        ...deploymentState,
        snapshot: readiness.snapshot,
      });
    }

    const authorization = issueActionAuthorization({
      secret: ACTION_AUTHORIZATION_SECRET,
      operation: "deploy",
      details: {
        repo,
        pr_number: prNumber,
        expected_merge_commit: expectedMergeCommit,
        expected_previous_commit: deploymentState.observed_commit,
      },
      ttlSeconds: ACTION_AUTHORIZATION_TTL_SECONDS,
    });

    return res.status(200).json({
      ok: true,
      ready: true,
      errors: [],
      snapshot: readiness.snapshot,
      authorization_token: authorization.token,
      expires_at: authorization.payload.expires_at,
      expected_previous_commit: deploymentState.observed_commit,
      rollback_commit: deploymentState.rollback_commit,
      approval_required: true,
    });
  } catch (err) {
    return res.status(err?.status === 404 ? 404 : 500).json({
      error: err?.message || String(err),
    });
  }
}

async function handleDeploymentExecute(req, res) {
  if (requireBridgeSecret(req, res)) return;

  try {
    const authorization = consumeActionAuthorization({
      token: req.body?.authorization_token,
      operation: "deploy",
    });
    const {
      repo,
      pr_number: prNumber,
      expected_merge_commit: expectedMergeCommit,
      expected_previous_commit: expectedPreviousCommit,
    } = authorization.details || {};
    assertAuthorizedRequestMatches({
      authorizationDetails: authorization.details,
      requestDetails: {
        repo: req.body?.repo,
        pr_number: req.body?.pr_number,
        expected_merge_commit: req.body?.expected_merge_commit,
        expected_previous_commit: req.body?.expected_previous_commit,
      },
      fields: ["repo", "pr_number", "expected_merge_commit", "expected_previous_commit"],
    });

    if (!repo || !parsePositivePrNumber(prNumber) || !expectedMergeCommit || !expectedPreviousCommit) {
      throw new Error("authorization_token_scope_mismatch");
    }
    if (!isRepoExplicitlyAllowedForExecution(repo)) {
      return res.status(403).json({ error: "Repo not explicitly allowed for guarded execution" });
    }

    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);
    const response = await octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });
    const target = PRODUCTION_TARGETS[repo] || null;
    const hook = DEPLOYMENT_HOOKS[repo] || null;
    const readiness = evaluateDeploymentReadiness({
      pull: response.data,
      expectedMergeCommit,
      target,
      hook,
    });

    if (!readiness.ready) {
      return res.status(200).json({
        ok: true,
        executed: false,
        valid: false,
        ...readiness,
      });
    }

    const observation = await observeProductionTarget({
      target,
      fetchDeploymentJson: fetchConfiguredDeploymentJson,
    });
    const deploymentState = evaluateDeploymentObservation({
      observation,
      expectedMergeCommit,
      expectedPreviousCommit,
    });
    if (deploymentState.already_deployed) {
      return res.status(200).json({
        ok: true,
        executed: false,
        already_deployed: true,
        repo,
        pr_number: prNumber,
        commit: expectedMergeCommit,
      });
    }
    if (!deploymentState.ready) {
      return res.status(200).json({
        ok: true,
        executed: false,
        valid: false,
        ...deploymentState,
      });
    }

    const deployment = await triggerExactCommitDeploy({
      hookUrl: hook.hookUrl,
      commit: expectedMergeCommit,
    });
    return res.status(200).json({
      ok: true,
      executed: true,
      already_deployed: false,
      repo,
      pr_number: prNumber,
      ...deployment,
      previous_observed_commit: deploymentState.observed_commit,
      rollback_commit: deploymentState.rollback_commit,
    });
  } catch (err) {
    return res.status(authorizationErrorStatus(err)).json({
      error: err?.message || String(err),
    });
  }
}

// --------------------
// Health / Capabilities / Version
// --------------------
app.get("/", (_req, res) => res.status(200).send("ok"));

app.get("/health", (_req, res) =>
  res.status(200).json({
    ok: true,
    status: "ok",
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
  })
);

app.get("/capabilities", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  res.json({
    ok: true,
    services: {
      repos_snapshot: true,
      read_file: true,
      prs_create: true,
      state_boot: true,
      state_validate: true,
      production_status: true,
      merge_prepare: true,
      merge_execute: true,
      deployment_prepare: true,
      deployment_execute: true,
    },
    auth_mode: AUTH_MODE,
    allowed_repos: ALLOWED_REPOS,
    max_read_file_bytes: MAX_READ_FILE_BYTES,
    ou_state_repo: OU_STATE_REPO,
    ou_state_ref: OU_STATE_REF,
    production_status_repos: Object.keys(PRODUCTION_TARGETS),
    deployment_hook_repos: Object.keys(DEPLOYMENT_HOOKS),
    guarded_execution_requires_explicit_allowlist: true,
  });
});

app.get("/version", (_req, res) => {
  res.json({
    ok: true,
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
    node: process.version,
    allowed_repos: ALLOWED_REPOS,
    auth_mode: AUTH_MODE,
    max_read_file_bytes: MAX_READ_FILE_BYTES,
    ou_state_repo: OU_STATE_REPO,
    ou_state_ref: OU_STATE_REF,
    production_status_repos: Object.keys(PRODUCTION_TARGETS),
    deployment_hook_repos: Object.keys(DEPLOYMENT_HOOKS),
    guarded_execution_requires_explicit_allowlist: true,
    commit_mark: "bridge-guarded-execution-v1",
  });
});

// --------------------
// State
// --------------------
app.post("/state/boot", handleStateBoot);
app.post("/state/validate", handleStateValidate);

// --------------------
// Production continuation (read-only)
// --------------------
app.post("/production/status", handleProductionStatus);

// --------------------
// Guarded high-risk execution
// --------------------
app.post("/pr/merge-prepare", handleMergePrepare);
app.post("/pr/merge-execute", handleMergeExecute);
app.post("/deployment/prepare", handleDeploymentPrepare);
app.post("/deployment/execute", handleDeploymentExecute);

// --------------------
// Read / Snapshot
// --------------------
app.post("/repos/snapshot", handleReposSnapshot);
app.post("/snapshot", handleReposSnapshot);

app.post("/repos/read-file", handleReadFile);
app.post("/read-file", handleReadFile);

// --------------------
// PR create -> /pr
// --------------------
app.post("/pr", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  const repo = req.body?.repo;
  const base = req.body?.base_ref ?? req.body?.base ?? "main";
  const baseCommit = req.body?.base_commit ?? null;
  const branch = normalizeBranchName(
    req.body?.branch_name ??
      req.body?.branch ??
      `ougpt/${slugifyBranch(req.body?.title || "change")}-${Date.now()}`
  );
  const title = req.body?.title;
  const body = req.body?.body ?? "";
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
  const draft = Boolean(req.body?.draft);

  if (!repo || !title || !Array.isArray(edits) || edits.length === 0) {
    return res.status(400).json({ error: "Missing required fields: repo, title, edits[]" });
  }

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "Repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokitForRepo(owner, repoName);

    let baseCommitSha;
    let baseTreeSha;

    if (repo === OU_STATE_REPO) {
      const { snapshot, validation } = await prepareLiveOuStateWrite({
        octokit,
        owner,
        repoName,
        ref: base,
        baseCommit,
        edits,
      });

      if (!validation.ok) {
        return res.status(409).json({
          error: "OU-State validation failed",
          validation,
        });
      }

      baseCommitSha = snapshot.commit;
      baseTreeSha = snapshot.treeSha;
    } else {
      const baseRef = await octokit.git.getRef({
        owner,
        repo: repoName,
        ref: `heads/${base}`,
      });
      baseCommitSha = baseRef.data.object.sha;

      const baseCommitData = await octokit.git.getCommit({
        owner,
        repo: repoName,
        commit_sha: baseCommitSha,
      });
      baseTreeSha = baseCommitData.data.tree.sha;
    }

    const treeItems = [];

    for (const e of edits) {
      if (!e?.path || !e?.action) continue;

      if (e.action === "delete") {
        treeItems.push({
          path: e.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
        continue;
      }

      const content = e.content ?? "";
      const blob = await octokit.git.createBlob({
        owner,
        repo: repoName,
        content,
        encoding: "utf-8",
      });

      treeItems.push({
        path: e.path,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      });
    }

    const newTree = await octokit.git.createTree({
      owner,
      repo: repoName,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    const commit = await octokit.git.createCommit({
      owner,
      repo: repoName,
      message: title,
      tree: newTree.data.sha,
      parents: [baseCommitSha],
    });

    try {
      await octokit.git.createRef({
        owner,
        repo: repoName,
        ref: `refs/heads/${branch}`,
        sha: commit.data.sha,
      });
      console.log(`REF_CREATE_OK repo=${owner}/${repoName} branch=${branch} sha=${commit.data.sha}`);
    } catch (createErr) {
      try {
        await octokit.git.updateRef({
          owner,
          repo: repoName,
          ref: `heads/${branch}`,
          sha: commit.data.sha,
          force: true,
        });
        console.log(`REF_UPDATE_OK repo=${owner}/${repoName} branch=${branch} sha=${commit.data.sha}`);
      } catch (updateErr) {
        throw new Error(
          `Failed to create or update branch ${branch}. createRef: ${createErr?.message || String(createErr)} | updateRef: ${updateErr?.message || String(updateErr)}`
        );
      }
    }

    try {
      await octokit.git.getRef({
        owner,
        repo: repoName,
        ref: `heads/${branch}`,
      });
      console.log(`REF_VERIFY_OK repo=${owner}/${repoName} branch=${branch}`);
    } catch (verifyErr) {
      throw new Error(
        `Branch ref heads/${branch} was not visible after create/update: ${verifyErr?.message || String(verifyErr)}`
      );
    }

    const pr = await createPullRequestWithRetry({
      octokit,
      owner,
      repoName,
      base,
      head: branch,
      title,
      body,
      draft,
    });

    res.json({
      ok: true,
      pr_url: pr.data.html_url,
      pr_number: pr.data.number,
      branch,
      base,
      commit_sha: commit.data.sha,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --------------------
// Start
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub Read/Write Bridge listening on ${PORT}`);
});
