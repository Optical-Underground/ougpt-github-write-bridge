// src/index.js
import express from "express";
import { Octokit } from "@octokit/rest";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- Config ----
const PORT = process.env.PORT || 10000;

const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
if (!BRIDGE_SECRET) {
  console.error("Missing required env var: BRIDGE_SECRET");
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("Missing required env var: GITHUB_TOKEN");
  process.exit(1);
}

const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DIAG_PROBE_ENABLED = String(process.env.DIAG_PROBE_ENABLED || "").toLowerCase() === "true";
const PROBE_SECRET = process.env.PROBE_SECRET || "";

// ---- Helpers ----
function requireBridgeSecret(req, res) {
  const got = req.header("x-bridge-secret");
  if (!got || got !== BRIDGE_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return null;
}

function isRepoAllowed(fullRepo) {
  if (!ALLOWED_REPOS.length) return true;
  return ALLOWED_REPOS.includes(fullRepo);
}

function parseRepo(fullRepo) {
  if (typeof fullRepo !== "string" || !fullRepo.includes("/")) {
    throw new Error(`Invalid repo. Expected "owner/name", got: ${String(fullRepo)}`);
  }
  const [owner, repo] = fullRepo.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo. Expected "owner/name", got: ${String(fullRepo)}`);
  return { owner, repo };
}

function toBase64Utf8(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

async function ensureBranchFromBase({ octokit, owner, repo, base, branch }) {
  // Get base branch ref -> sha
  const baseRef = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  const baseSha = baseRef.data.object.sha;

  // If branch exists, do nothing; else create it at base sha
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return { baseSha, branchSha: null, created: false };
  } catch (e) {
    if (e?.status !== 404) throw e;
  }

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });

  return { baseSha, branchSha: baseSha, created: true };
}

async function getHeadCommitAndTree({ octokit, owner, repo, branch }) {
  const ref = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  const headSha = ref.data.object.sha;

  const commit = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: headSha,
  });

  const treeSha = commit.data.tree.sha;
  return { headSha, treeSha };
}

async function createTreeWithEdits({ octokit, owner, repo, baseTreeSha, edits }) {
  // Build tree entries
  const tree = [];

  for (const edit of edits || []) {
    const path = edit?.path;
    const action = edit?.action;
    const content = edit?.content;

    if (!path || typeof path !== "string") {
      throw new Error("Each edit must include a string 'path'.");
    }
    if (!action || typeof action !== "string") {
      throw new Error("Each edit must include an 'action' (create|update|delete).");
    }

    if (action === "delete") {
      tree.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }

    if (action !== "create" && action !== "update") {
      throw new Error(`Invalid edit action: ${action}. Use create|update|delete.`);
    }

    if (typeof content !== "string") {
      throw new Error(`Edit ${action} for ${path} requires string 'content'.`);
    }

    const blob = await octokit.git.createBlob({
      owner,
      repo,
      content: toBase64Utf8(content),
      encoding: "base64",
    });

    tree.push({
      path,
      mode: "100644",
      type: "blob",
      sha: blob.data.sha,
    });
  }

  const newTree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree,
  });

  return newTree.data.sha;
}

async function commitAndMoveBranch({ octokit, owner, repo, branch, parentSha, treeSha, message }) {
  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: treeSha,
    parents: [parentSha],
  });

  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: false,
  });

  return commit.data.sha;
}

async function openPullRequest({ octokit, owner, repo, base, head, title, body, draft }) {
  // If an open PR already exists for head->base, reuse it (idempotent-ish)
  const prs = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${owner}:${head}`,
    base,
    per_page: 10,
  });

  if (prs.data?.length) return prs.data[0];

  const pr = await octokit.pulls.create({
    owner,
    repo,
    base,
    head,
    title,
    body,
    draft: Boolean(draft),
  });

  return pr.data;
}

// ---- Routes ----

// Public health endpoint (no secret) so we can tell "up" vs "auth blocked"
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Optional diagnostics probe
app.get("/diag/probe", (req, res) => {
  if (!DIAG_PROBE_ENABLED) return res.status(404).json({ error: "Not found" });
  const got = req.header("x-probe-secret");
  if (!got || got !== PROBE_SECRET) return res.status(403).json({ error: "Forbidden" });

  res.status(200).json({
    ok: true,
    diag: {
      allowedReposCount: ALLOWED_REPOS.length,
      diagProbeEnabled: DIAG_PROBE_ENABLED,
    },
  });
});

// Create PR endpoint
app.post("/pr", async (req, res) => {
  const authErr = requireBridgeSecret(req, res);
  if (authErr) return authErr;

  const {
    repo,       // "Owner/name"
    base,       // base branch, e.g. "main"
    branch,     // head branch, e.g. "ougpt/test-1"
    title,
    body: pr_body,
    draft,
    edits,
  } = req.body || {};

  try {
    if (!repo || !base || !branch || !title) {
      return res.status(400).json({
        error: "Missing required fields. Need: repo, base, branch, title",
      });
    }

    if (!isRepoAllowed(repo)) {
      return res.status(403).json({ error: "Repo not allowed" });
    }

    const { owner, repo: repoName } = parseRepo(repo);

    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    // Ensure branch exists at base
    await ensureBranchFromBase({ octokit, owner, repo: repoName, base, branch });

    // Apply edits by committing to branch
    const { headSha, treeSha } = await getHeadCommitAndTree({ octokit, owner, repo: repoName, branch });

    const newTreeSha = await createTreeWithEdits({
      octokit,
      owner,
      repo: repoName,
      baseTreeSha: treeSha,
      edits: Array.isArray(edits) ? edits : [],
    });

    // Commit message: keep it deterministic-ish
    const commitMessage = `ougpt: apply edits for PR "${title}"`;

    const commitSha = await commitAndMoveBranch({
      octokit,
      owner,
      repo: repoName,
      branch,
      parentSha: headSha,
      treeSha: newTreeSha,
      message: commitMessage,
    });

    // Open PR
    const pr = await openPullRequest({
      octokit,
      owner,
      repo: repoName,
      base,
      head: branch,
      title,
      body: pr_body || "",
      draft: Boolean(draft),
    });

    return res.json({
      ok: true,
      pr_url: pr.html_url,
      pr_number: pr.number,
      branch,
      base,
      commit_sha: commitSha,
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "Unknown error",
      status,
    });
  }
});

// ---- Start ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub Write Bridge listening on ${PORT}`);
});

