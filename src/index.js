import express from "express";
import { Octokit } from "@octokit/rest";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- Config ----
const PORT = process.env.PORT || 10000;

// ---- Always-on health (Render-safe) ----
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// ---- Start server FIRST (critical for Render) ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub Write Bridge listening on ${PORT}`);
});

// ---- Validate env vars AFTER listen ----
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!BRIDGE_SECRET) {
  console.error("CONFIG ERROR: BRIDGE_SECRET is missing");
}
if (!GITHUB_TOKEN) {
  console.error("CONFIG ERROR: GITHUB_TOKEN is missing");
}

const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const DIAG_PROBE_ENABLED =
  String(process.env.DIAG_PROBE_ENABLED || "").toLowerCase() === "true";
const PROBE_SECRET = process.env.PROBE_SECRET || "";

// ---- Helpers ----
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
  if (!owner || !repo) throw new Error("Invalid repo format");
  return { owner, repo };
}

// ---- Version ----
app.get("/version", (_req, res) => {
  res.json({
    ok: true,
    render_git_commit: process.env.RENDER_GIT_COMMIT || null,
    node: process.version,
    allowed_repos_count: ALLOWED_REPOS.length,
    allowed_repos: ALLOWED_REPOS,
    diag_probe_enabled: DIAG_PROBE_ENABLED,
    read_endpoint: "/snapshot",
  });
});

// ---- Snapshot (read) ----
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
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    const files = [];
    for (const path of paths) {
      const r = await octokit.repos.getContent({ owner, repo: repoName, path, ref });
      if (Array.isArray(r.data)) {
        throw new Error(`Path is a directory: ${path}`);
      }
      const buf = Buffer.from(r.data.content.replace(/\n/g, ""), "base64");
      files.push({
        path,
        encoding: "utf-8",
        content: buf.toString("utf8"),
      });
    }

    res.json({ ok: true, repo, ref, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
