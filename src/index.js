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

const DIAG_PROBE_ENABLED =
  String(process.env.DIAG_PROBE_ENABLED || "").toLowerCase() === "true";
const PROBE_SECRET = process.env.PROBE_SECRET || "";

// Read limits (keep responses sane)
const MAX_SNAPSHOT_PATHS = 20;
const MAX_FILE_BYTES = 512 * 1024; // 512 KB per file (decoded)

// ---- Helpers ----
function requireBridgeSecret(req, res) {
  const got = req.header("x-bridge-secret");
  if (!got || got !== BRIDGE_SECRET) {
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
  if (typeof fullRepo !== "string" || !fullRepo.includes("/")) {
    throw new Error(
      `Invalid repo. Expected "owner/name", got: ${String(fullRepo)}`
    );
  }
  const [owner, repo] = fullRepo.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid repo. Expected "owner/name", got: ${String(fullRepo)}`
    );
  }
  return { owner, repo };
}

function toBase64Utf8(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function fromBase64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

async function ensureBranchFromBase({ octokit, owner, repo, base, branch }) {
  const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseSha = baseRef.data.object.sha;

  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return { baseSha, created: false };
  } catch (e) {
    if (e?.status !== 404) throw e;
  }

  await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
  return { baseSha, created: true };
}

async function getHeadCommitAndTree({ octokit, owner, repo, branch }) {
  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const headSha = ref.data.object.sha;

  const commit = await octokit.git.getCommit({ owner, repo, commit_sha: headSha });
  const treeSha = commit.data.tree.sha;

  return { headSha, treeSha };
}

async function createTreeWithEdits({ octokit, owner, repo, baseTreeSha, edits }) {
  const tree = [];

  for (const edit of edits || []) {
    const path = edit?.path;
    const action = edit?.action;
    const content = edit?.content;

    if (!path || typeof path !== "string") {
      throw new Error("Each edit must include a string 'path'.");
    }
    if (!action || typeof action !== "string") {
      throw new Error("Each edit must include an 'action'.");
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

    tree.push({ path, mode: "100644", type: "blob", sha: blob.data.sha });
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

async function readFileViaContentsApi({ octokit, owner, repo, path, ref }) {
  // GitHub returns either a file object or an array for directories
  const resp = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });

  if (Array.isArray(resp.data)) {
    throw new Error(`Path is a directory (expected file): ${path}`);
  }

  // For files, GitHub returns base64 content (usually) and size
  const { type, encoding, content, size, name } = resp.data;

  if (type !== "file") {
    throw new Error(`Path is not a file: ${path} (type=${type || "unknown"})`);
  }
  if (encoding !== "base64") {
    throw new Error(`Unsupported encoding for ${path}: ${encoding}`);
  }
  if (typeof size === "number" && size > MAX_FILE_BYTES) {
    throw new Error(`File too large (${size} bytes) for ${path}; limit is ${MAX_FILE_BYTES} bytes`);
  }
  if (typeof content !== "string") {
    throw new Error(`No content returned for file: ${path}`);
  }

  // Remove any newlines GitHub includes in base64 content
  const b64 = content.replace(/\n/g, "");
  const buf = fromBase64ToBuffer(b64);
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`File too large after decode (${buf.length} bytes) for ${path}`);
  }

  return {
    path,
    name: name || path.split("/").pop(),
    encoding: "utf-8",
    content: buf.toString("utf8"),
    bytes: buf.length,
  };
}

// ---- Routes ----

// Make both "/" and "/health" return 200 so Render health checks always pass.
app.get("/version", (req, res) => {
  res.status(200).json({
    ok: true,
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
    node: process.version,
    allowed_repos_count: ALLOWED_REPOS.length,
    allowed_repos: ALLOWED_REPOS,   // ← ADD THIS LINE
    diag_probe_enabled: DIAG_PROBE_ENABLED,
    read_endpoint: "/snapshot",
  });
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

// READ: snapshot files (secret-protected)
app.post("/snapshot", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  const { repo, ref, paths } = req.body || {};

  try {
    if (!repo) return res.status(400).json({ error: "Missing required field: repo" });
    if (!isRepoAllowed(repo)) return res.status(403).json({ error: "Repo not allowed" });

    const refToUse = ref || "main";
    const list = Array.isArray(paths) ? paths : [];
    if (!list.length) return res.status(400).json({ error: "Missing required field: paths (non-empty array)" });
    if (list.length > MAX_SNAPSHOT_PATHS) {
      return res.status(400).json({ error: `Too many paths. Max is ${MAX_SNAPSHOT_PATHS}` });
    }

    for (const p of list) {
      if (typeof p !== "string" || !p.trim()) {
        return res.status(400).json({ error: "All paths must be non-empty strings" });
      }
      if (p.includes("..")) {
        return res.status(400).json({ error: `Invalid path (.. not allowed): ${p}` });
      }
    }

    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    const files = [];
    for (const p of list) {
      const file = await readFileViaContentsApi({
        octokit,
        owner,
        repo: repoName,
        path: p,
        ref: refToUse,
      });
      files.push(file);
    }

    return res.json({
      ok: true,
      repo,
      ref: refToUse,
      files,
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "Unknown error",
      status,
    });
  }
});

// WRITE: create PR endpoint
app.post("/pr", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  const { repo, base, branch, title, body: pr_body, draft, edits } = req.body || {};

  try {
    if (!repo || !base || !branch || !title) {
      return res.status(400).json({
        error: "Missing required fields. Need: repo, base, branch, title",
      });
    }
    if (!isRepoAllowed(repo)) return res.status(403).json({ error: "Repo not allowed" });

    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    await ensureBranchFromBase({ octokit, owner, repo: repoName, base, branch });

    const { headSha, treeSha } = await getHeadCommitAndTree({
      octokit,
      owner,
      repo: repoName,
      branch,
    });

    const newTreeSha = await createTreeWithEdits({
      octokit,
      owner,
      repo: repoName,
      baseTreeSha: treeSha,
      edits: Array.isArray(edits) ? edits : [],
    });

    const commitSha = await commitAndMoveBranch({
      octokit,
      owner,
      repo: repoName,
      branch,
      parentSha: headSha,
      treeSha: newTreeSha,
      message: `ougpt: apply edits for PR "${title}"`,
    });

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

