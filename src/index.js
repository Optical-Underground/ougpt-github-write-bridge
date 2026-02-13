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
  .map((s) => s.trim())
  .filter(Boolean);

const AUTH_MODE = process.env.GITHUB_AUTH_MODE || "pat";

// GitHub App (OuGPT Agent)
const APP_ID = process.env.GITHUB_APP_ID;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;

// PAT fallback
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// --------------------
// Health (Render-safe)
// --------------------
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) =>
  res.status(200).json({ status: "ok" })
);

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
  const [owner, repo] = fullRepo.split("/");
  if (!owner || !repo) {
    throw new Error("Invalid repo format. Use owner/repo.");
  }
  return { owner, repo };
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

    const appOctokit = new Octokit({
      auth: appJwt,
    });

    const tokenResp = await appOctokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: INSTALLATION_ID }
    );

    return new Octokit({
      auth: tokenResp.data.token,
    });
  }

  // PAT fallback
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
    allowed_repos_count: ALLOWED_REPOS.length,
    allowed_repos: ALLOWED_REPOS,
    auth_mode: AUTH_MODE,
    read_endpoint: "/snapshot",
  });
});

// --------------------
// Snapshot (read)
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

    for (const pa
