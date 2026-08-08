const FAILED_CHECK_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

const PENDING_CHECK_STATUSES = new Set(["queued", "in_progress", "pending", "requested", "waiting"]);

function assertHttpsUrl(value, field, repo) {
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${field} for ${repo}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${field} must use https for ${repo}`);
  }

  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}
export function parseProductionTargets(raw) {
  if (!raw || !String(raw).trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid PRODUCTION_TARGETS_JSON: ${err?.message || String(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PRODUCTION_TARGETS_JSON must be a JSON object keyed by owner/repo");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([repo, target]) => {
      if (!repo.includes("/") || !target || typeof target !== "object" || Array.isArray(target)) {
        throw new Error(`Invalid production target for ${repo}`);
      }

      const healthUrl = assertHttpsUrl(target.health_url, "health_url", repo);
      const versionUrl = assertHttpsUrl(target.version_url, "version_url", repo);
      if (!healthUrl && !versionUrl) {
        throw new Error(`Production target for ${repo} requires health_url or version_url`);
      }

      const maxPendingMinutes = Number(target.max_pending_minutes ?? 20);
      if (!Number.isFinite(maxPendingMinutes) || maxPendingMinutes < 0) {
        throw new Error(`Invalid max_pending_minutes for ${repo}`);
      }

      return [
        repo,
        {
          name: String(target.name || repo),
          healthUrl,
          versionUrl,
          commitField: String(target.commit_field || "render_git_commit"),
          maxPendingMinutes,
        },
      ];
    })
  );
}

export function summarizeReviews(reviews = []) {
  const latestByReviewer = new Map();

  for (const review of reviews) {
    const reviewer = review?.user?.login;
    const state = String(review?.state || "").toUpperCase();
    if (!reviewer || !state || state === "COMMENTED" || state === "PENDING") continue;
    latestByReviewer.set(reviewer, state);
  }

  const approvals = [];
  const changesRequested = [];
  for (const [reviewer, state] of latestByReviewer) {
    if (state === "APPROVED") approvals.push(reviewer);
    if (state === "CHANGES_REQUESTED") changesRequested.push(reviewer);
  }

  return {
    approvals: approvals.sort(),
    changes_requested: changesRequested.sort(),
  };
}

export function summarizeChecks(checkRuns = [], combinedStatus = null) {
  const counts = {
    total: checkRuns.length,
    passed: 0,
    pending: 0,
    failed: 0,
  };

  for (const run of checkRuns) {
    const status = String(run?.status || "").toLowerCase();
    const conclusion = String(run?.conclusion || "").toLowerCase();
    if (FAILED_CHECK_CONCLUSIONS.has(conclusion)) counts.failed += 1;
    else if (PENDING_CHECK_STATUSES.has(status) || !conclusion) counts.pending += 1;
    else counts.passed += 1;
  }

  const commitStatus = String(combinedStatus || "").toLowerCase() || "none";
  let state = "none";
  if (counts.failed > 0 || commitStatus === "failure" || commitStatus === "error") state = "failed";
  else if (counts.pending > 0 || commitStatus === "pending") state = "pending";
  else if (counts.total > 0 || commitStatus === "success") state = "passing";

  return {
    state,
    commit_status: commitStatus,
    ...counts,
  };
}

function readCommit(body, field) {
  const value = body && typeof body === "object" ? body[field] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function minutesSince(timestamp, now) {
  const then = Date.parse(timestamp || "");
  if (!Number.isFinite(then)) return null;
  return Math.max(0, (now.getTime() - then) / 60000);
}

export async function buildProductionStatusPacket({
  repo,
  prNumber,
  target = null,
  getPullRequest,
  getReviews,
  getCheckRuns,
  getCombinedStatus,
  fetchDeploymentJson,
  now = new Date(),
}) {
  const pull = await getPullRequest();
  const [reviews, checkRuns, combinedStatus] = await Promise.all([
    getReviews(),
    getCheckRuns(pull.head.sha),
    getCombinedStatus(pull.head.sha),
  ]);

  const reviewSummary = summarizeReviews(reviews);
  const checkSummary = summarizeChecks(checkRuns, combinedStatus);
  const merged = Boolean(pull.merged);
  const expectedCommit = merged ? pull.merge_commit_sha || null : null;

  const packet = {
    ok: true,
    repo,
    pr_number: prNumber,
    source: {
      state: pull.state,
      draft: Boolean(pull.draft),
      merged,
      mergeable: pull.mergeable ?? null,
      mergeable_state: pull.mergeable_state ?? null,
      head_ref: pull.head.ref,
      head_commit: pull.head.sha,
      base_ref: pull.base.ref,
      base_commit_at_open: pull.base.sha,
      merge_commit: pull.merge_commit_sha || null,
      merged_at: pull.merged_at || null,
      reviews: reviewSummary,
      checks: checkSummary,
    },
    deployment: {
      configured: Boolean(target),
      target: target?.name || null,
      expected_commit: expectedCommit,
      observed_commit: null,
      status: merged ? "not_configured" : "not_merged",
      health: null,
      version: null,
    },
    next_action: null,
  };

  if (!merged) {
    if (pull.draft) packet.next_action = "prepare_pr_for_review";
    else if (reviewSummary.changes_requested.length) packet.next_action = "address_review_changes";
    else if (checkSummary.state === "failed") packet.next_action = "fix_failing_checks";
    else if (checkSummary.state === "pending") packet.next_action = "wait_for_checks";
    else if (pull.mergeable === false || pull.mergeable_state === "dirty") {
      packet.next_action = "resolve_merge_conflicts";
    } else packet.next_action = "await_high_risk_merge_approval";
    return packet;
  }

  if (!target) {
    packet.next_action = "configure_deployment_target";
    return packet;
  }

  const probe = async (url) => {
    if (!url) return null;
    try {
      return await fetchDeploymentJson(url);
    } catch (err) {
      return {
        ok: false,
        http_status: null,
        body: null,
        error: err?.message || String(err),
      };
    }
  };

  const [health, version] = await Promise.all([
    probe(target.healthUrl),
    probe(target.versionUrl),
  ]);
  packet.deployment.health = health;
  packet.deployment.version = version;

  const observedCommit =
    readCommit(version?.body, target.commitField) || readCommit(health?.body, target.commitField);
  packet.deployment.observed_commit = observedCommit;

  if ((health && !health.ok) || (version && !version.ok)) {
    packet.deployment.status = "probe_failed";
    packet.next_action = "investigate_deployment_probe";
    return packet;
  }

  if (!observedCommit) {
    packet.deployment.status = "unverifiable";
    packet.next_action = "add_deployed_commit_evidence";
    return packet;
  }

  if (expectedCommit && observedCommit === expectedCommit) {
    packet.deployment.status = "deployed";
    packet.next_action = "record_live_verification";
    return packet;
  }

  const elapsedMinutes = minutesSince(pull.merged_at, now);
  packet.deployment.status =
    elapsedMinutes !== null && elapsedMinutes > target.maxPendingMinutes
      ? "deployment_mismatch"
      : "pending";
  packet.next_action =
    packet.deployment.status === "pending"
      ? "wait_for_deployment"
      : "investigate_deployment_mismatch";
  return packet;
}
