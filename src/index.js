import express from "express";
import { Octokit } from "@octokit/rest";
import { validatePrRequest } from "./validate.js";
import { ensureBranch, applyEdits, openPullRequest } from "./github.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

function requireSecret(req, res, next) {
  const expected = process.env.BRIDGE_SECRET;
  if (!expected) return res.status(500).json({ error: "BRIDGE_SECRET not set" });

  const got = req.header("x-bridge-secret");
  if (!got || got !== expected) return res.status(401).json({ error: "Unauthorized" });

  return next();
}

function repoAllowed(fullName) {
  const allow = (process.env.ALLOWED_REPOS || "").trim();
  if (!allow) return true; // if unset, allow all (set this in prod)
  const set = new Set(allow.split(",").map(s => s.trim()).filter(Boolean));
  return set.has(fullName);
}

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Free-plan-friendly diagnostics route (guarded)
app.get("/diag/probe", async (req, res) => {
  if (process.env.DIAG_PROBE_ENABLED !== "true") {
    return res.status(404).json({ error: "not enabled" });
  }
  const expected = process.env.PROBE_SECRET;
  if (!expected) return res.status(500).json({ error: "PROBE_SECRET not set" });
  if (req.header("x-probe-secret") !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  return res.json({
    ok: true,
    node: process.version,
    has_github_token: Boolean(process.env.GITHUB_TOKEN),
    allowed_repos_set: Boolean((process.env.ALLOWED_REPOS || "").trim()),
    time: new Date().toISOString()
  });
});

app.post("/pr", requireSecret, async (req, res) => {
  const body = req.body;

  const v = validatePrRequest(body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const { repo, base, branch, title, pr_body, edits, draft } = v.data;

  if (!repoAllowed(repo)) {
    return res.status(403).json({ error: "repo not allowed" });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: "GITHUB_TOKEN not set" });

  const octokit = new Octokit({ auth: token });

  try {
    const [owner, repoName] = repo.split("/");
    await ensureBranch({ octokit, owner, repo: repoName, base, branch });
    await applyEdits({ octokit, owner, repo: repoName, branch, edits });

    const pr = await openPullRequest({
      octokit,
      owner,
      repo: repoName,
      base,
      head: branch,
      title,
      body: pr_body || "",
      draft: Boolean(draft)
    });

    return res.json({
      ok: true,
      pr_url: pr.html_url,
      pr_number: pr.number,
      branch
    });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      error: err?.message || "Unknown error",
      status
    });
  }
});

app.listen(PORT, () => {
  console.log(`GitHub Write Bridge listening on ${PORT}`);
});
