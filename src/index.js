console.log("BRIDGE_BUILD", new Date().toISOString(), "COMMIT_MARK=pr-head-normalize-v1");

import express from "express";
import jwt from "jsonwebtoken";
import { Octokit } from "@octokit/rest";

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

const AUTH_MODE = process.env.GITHUB_AUTH_MODE || "pat";

// GitHub App (OuGPT Agent)
const APP_ID = process.env.GITHUB_APP_ID;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const PRIVATE_KEY_RAW = process.env.GITHUB_APP_PRIVATE_KEY;

// PAT fallback
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// --------------------
// Helpers
// --------------------
function requireBridgeSecret(req, res) {
  if (!BRIDGE_SECRET) {
    res.status(500).json({ error: "Missing env: BRIDGE_SECRET" });
    return true;
  }
  if ((req.header("x-bridge-secret") || "") !== BRIDGE_SECRET) {
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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// --------------------
// GitHub Auth
// --------------------
function normalizePrivateKey() {
  if (!PRIVATE_KEY_RAW) return null;
  // Render/env sometimes stores newlines escaped
  return PRIVATE_KEY_RAW.includes("\\n") ? PRIVATE_KEY_RAW.replace(/\\n/g, "\n") : PRIVATE_KEY_RAW;
}

function createAppJwt() {
  const key = normalizePrivateKey();
  if (!key) throw new Error("Missing GitHub App private key");
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

async function getOctokit() {
  if (AUTH_MODE === "app") {
    if (!APP_ID || !INSTALLATION_ID || !PRIVATE_KEY_RAW) {
      throw new Error("Missing GitHub App configuration");
    }

    const appJwt = createAppJwt();
    const appOctokit = new Octokit({ auth: appJwt });

    const tokenResp = await appOctokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: Number(INSTALLATION_ID) }
    );

    return new Octokit({ auth: tokenResp.data.token });
  }

  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN");
  }

  return new Octokit({ auth: GITHUB_TOKEN });
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

app.get("/capabilities", (req, res) => {
  if (requireBridgeSecret(req, res)) return;
  res.json({
    ok: true,
    services: {
      repos_snapshot: true,
      prs_create: true,
    },
    auth_mode: AUTH_MODE,
    allowed_repos: ALLOWED_REPOS,
  });
});

app.get("/version", (_req, res) => {
  res.json({
    ok: true,
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
    node: process.version,
    allowed_repos: ALLOWED_REPOS,
    auth_mode: AUTH_MODE,
  });
});

// --------------------
// Repos Snapshot (NEW)  -> /repos/snapshot
// (keeps backward compat via /snapshot alias below)
// --------------------
app.post("/repos/snapshot", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  const { repo, ref = "main", paths = [], depth = 3 } = req.body || {};
  if (!repo || !ref) return res.status(400).json({ error: "repo and ref required" });

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "Repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokit();

    // resolve ref -> commit + tree sha
    const commitResp = await octokit.repos.getCommit({ owner, repo: repoName, ref });
    const commitSha = commitResp.data.sha;
    const treeSha = commitResp.data.commit?.tree?.sha;
    if (!treeSha) throw new Error("Could not resolve tree sha");

    // tree listing (recursive then filter by depth)
    const treeResp = await octokit.git.getTree({
      owner,
      repo: repoName,
      tree_sha: treeSha,
      recursive: "true",
    });

    const maxDepth = Number.isFinite(Number(depth)) ? Number(depth) : 3;

    const tree = (treeResp.data.tree || [])
      .filter((n) => n?.path && (n.type === "tree" || n.type === "blob"))
      .filter((n) => String(n.path).split("/").length <= maxDepth)
      .map((n) => ({
        path: n.path,
        type: n.type === "tree" ? "dir" : "file",
        size: n.size ?? 0,
      }));

    const files = [];
    if (Array.isArray(paths) && paths.length) {
      for (const p of paths) {
        const r = await octokit.repos.getContent({ owner, repo: repoName, path: p, ref });
        if (Array.isArray(r.data)) throw new Error(`Path is a directory: ${p}`);

        const buf = Buffer.from(String(r.data.content || "").replace(/\n/g, ""), "base64");
        files.push({ path: p, encoding: "utf-8", content: buf.toString("utf8") });
      }
    }

    res.json({ repo, ref, commit: commitSha, tree, files });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Backward compat alias for older callers
app.post("/snapshot", async (req, res) => {
  // Accept old body shape: { repo, ref="main", paths: [...] }
  // Delegate to /repos/snapshot with default depth.
  req.body = { ...(req.body || {}), depth: (req.body || {}).depth ?? 3 };
  return app._router.handle(req, res, () => {});
});

// --------------------
// PR create -> /pr
// Accepts BOTH payload styles:
//  - legacy: { repo, base, branch, title, body, edits[], draft }
//  - orchestrator: { repo, base_ref, branch_name, title, body, edits[], idempotency_key }
// --------------------
app.post("/pr", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  const repo = req.body?.repo;
  const base = req.body?.base_ref ?? req.body?.base ?? "main";
  const branch =
    req.body?.branch_name ??
    req.body?.branch ??
    `ougpt/${slugifyBranch(req.body?.title || "change")}-${Date.now()}`;
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
    const octokit = await getOctokit();

    // base ref -> commit sha
    const baseRef = await octokit.git.getRef({ owner, repo: repoName, ref: `heads/${base}` });
    const baseCommitSha = baseRef.data.object.sha;

    // commit sha -> tree sha
    const baseCommit = await octokit.git.getCommit({ owner, repo: repoName, commit_sha: baseCommitSha });
    const baseTreeSha = baseCommit.data.tree.sha;

    const treeItems = [];

    for (const e of edits) {
      if (!e?.path || !e?.action) continue;

      if (e.action === "delete") {
        treeItems.push({ path: e.path, sha: null });
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

    // create or update branch ref
    try {
      await octokit.git.createRef({
        owner,
        repo: repoName,
        ref: `refs/heads/${branch}`,
        sha: commit.data.sha,
      });
    } catch (e) {
      // if already exists, update it
      await octokit.git.updateRef({
        owner,
        repo: repoName,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
        force: true,
      });
    }

    const pr = await octokit.pulls.create({
      owner,
      repo: repoName,
      base,
      head: `${owner}:${branch}`,
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
  console.log(`GitHub Write Bridge listening on ${PORT}`);
});