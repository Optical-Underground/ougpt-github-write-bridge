import crypto from "crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { Octokit } from "@octokit/rest";
import { buildStateBootPacket } from "./stateBoot.js";

console.log("BRIDGE_BUILD", new Date().toISOString(), "COMMIT_MARK=bridge-state-boot-v1");

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

// OU-State boot safety
const OU_STATE_REPO = process.env.OU_STATE_REPO || "Optical-Underground/OU-State";
const OU_STATE_REF = process.env.OU_STATE_REF || "main";

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
    },
    auth_mode: AUTH_MODE,
    allowed_repos: ALLOWED_REPOS,
    max_read_file_bytes: MAX_READ_FILE_BYTES,
    ou_state_repo: OU_STATE_REPO,
    ou_state_ref: OU_STATE_REF,
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
    commit_mark: "bridge-state-boot-v1",
  });
});

// --------------------
// State
// --------------------
app.post("/state/boot", handleStateBoot);

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

    const baseRef = await octokit.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${base}`,
    });
    const baseCommitSha = baseRef.data.object.sha;

    const baseCommit = await octokit.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: baseCommitSha,
    });
    const baseTreeSha = baseCommit.data.tree.sha;

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