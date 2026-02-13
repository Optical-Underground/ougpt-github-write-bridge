import express from "express";
import jwt from "jsonwebtoken";
import { Octokit } from "@octokit/rest";

const app = express();
app.use(express.json({ limit: "2mb" }));

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 10000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";

const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const AUTH_MODE = process.env.GITHUB_AUTH_MODE || "pat";

// GitHub App (OuGPT Agent)
const APP_ID = process.env.GITHUB_APP_ID;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;

// PAT fallback
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// --------------------
// Health
// --------------------
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub Write Bridge listening on ${PORT}`);
});

// --------------------
// Helpers
// --------------------
function requireBridgeSecret(req, res) {
  if (req.header("x-bridge-secret") !== BRIDGE_SECRET) {
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
  const parts = fullRepo.split("/");
  if (parts.length !== 2) {
    throw new Error("Invalid repo format. Use owner/repo.");
  }
  return { owner: parts[0], repo: parts[1] };
}

// --------------------
// GitHub Auth
// --------------------
function createAppJwt() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60,
      exp: now + 9 * 60,
      iss: APP_ID,
    },
    PRIVATE_KEY,
    { algorithm: "RS256" }
  );
}

async function getOctokit() {
  if (AUTH_MODE === "app") {
    if (!APP_ID || !INSTALLATION_ID || !PRIVATE_KEY) {
      throw new Error("Missing GitHub App configuration");
    }

    const appJwt = createAppJwt();
    const appOctokit = new Octokit({ auth: appJwt });

    const tokenResp = await appOctokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: INSTALLATION_ID }
    );

    return new Octokit({ auth: tokenResp.data.token });
  }

  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN");
  }

  return new Octokit({ auth: GITHUB_TOKEN });
}

// --------------------
// Version
// --------------------
app.get("/version", (_req, res) => {
  res.json({
    ok: true,
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
    node: process.version,
    allowed_repos: ALLOWED_REPOS,
    auth_mode: AUTH_MODE
  });
});

// --------------------
// Snapshot
// --------------------
app.post("/snapshot", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  const { repo, ref = "main", paths } = req.body || {};

  if (!repo || !Array.isArray(paths)) {
    return res.status(400).json({ error: "repo and paths[] required" });
  }

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "Repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokit();

    const files = [];

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];

      const r = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path,
        ref
      });

      if (Array.isArray(r.data)) {
        throw new Error(`Path is a directory: ${path}`);
      }

      const buf = Buffer.from(
        r.data.content.replace(/\n/g, ""),
        "base64"
      );

      files.push({
        path,
        encoding: "utf-8",
        content: buf.toString("utf8")
      });
    }

    res.json({ ok: true, repo, ref, files });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// PR
// --------------------
app.post("/pr", async (req, res) => {
  if (requireBridgeSecret(req, res)) return;

  const {
    repo,
    base = "main",
    branch,
    title,
    body,
    edits = [],
    draft = false
  } = req.body || {};

  if (!repo || !branch || !title || !Array.isArray(edits)) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!isRepoAllowed(repo)) {
    return res.status(403).json({ error: "Repo not allowed" });
  }

  try {
    const { owner, repo: repoName } = parseRepo(repo);
    const octokit = await getOctokit();

    const baseRef = await octokit.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${base}`
    });

    const baseSha = baseRef.data.object.sha;

    const treeItems = [];

    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];

      if (e.action === "delete") {
        treeItems.push({ path: e.path, sha: null });
      } else {
        const blob = await octokit.git.createBlob({
          owner,
          repo: repoName,
          content: e.content,
          encoding: "utf-8"
        });

        treeItems.push({
          path: e.path,
          mode: "100644",
          type: "blob",
          sha: blob.data.sha
        });
      }
    }

    const newTree = await octokit.git.createTree({
      owner,
      repo: repoName,
      base_tree: baseSha,
      tree: treeItems
    });

    const commit = await octokit.git.createCommit({
      owner,
      repo: repoName,
      message: title,
      tree: newTree.data.sha,
      parents: [baseSha]
    });

    await octokit.git.createRef({
      owner,
      repo: repoName,
      ref: `refs/heads/${branch}`,
      sha: commit.data.sha
    });

    const pr = await octokit.pulls.create({
      owner,
      repo: repoName,
      base,
      head: branch,
      title,
      body: body || "",
      draft: Boolean(draft)
    });

    res.json({
      ok: true,
      pr_url: pr.data.html_url,
      pr_number: pr.data.number,
      branch,
      commit_sha: commit.data.sha
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
