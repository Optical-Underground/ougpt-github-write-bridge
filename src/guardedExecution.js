import { summarizeChecks, summarizeReviews } from "./productionStatus.js";

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

export function assertAuthorizedRequestMatches({ authorizationDetails, requestDetails, fields }) {
  for (const field of fields) {
    if (
      authorizationDetails?.[field] === undefined ||
      requestDetails?.[field] === undefined ||
      String(authorizationDetails[field]) !== String(requestDetails[field])
    ) {
      throw new Error("authorization_request_mismatch");
    }
  }
}

export function evaluateMergeReadiness({
  pull,
  expectedHeadCommit,
  expectedBaseCommit,
  reviews = [],
  checkRuns = [],
  combinedStatus = null,
}) {
  const errors = [];
  const reviewSummary = summarizeReviews(reviews);
  const checkSummary = summarizeChecks(checkRuns, combinedStatus);

  if (!expectedHeadCommit) {
    errors.push(issue("expected_head_commit_required", "expected_head_commit is required"));
  } else if (pull?.head?.sha !== expectedHeadCommit) {
    errors.push(
      issue("head_commit_changed", "Pull request head changed; review again before merging", {
        expected: expectedHeadCommit,
        current: pull?.head?.sha || null,
      })
    );
  }

  if (!expectedBaseCommit) {
    errors.push(issue("expected_base_commit_required", "expected_base_commit is required"));
  } else if (pull?.base?.sha !== expectedBaseCommit) {
    errors.push(
      issue("base_commit_changed", "Pull request base changed; review again before merging", {
        expected: expectedBaseCommit,
        current: pull?.base?.sha || null,
      })
    );
  }

  if (pull?.state !== "open" || pull?.merged) {
    errors.push(issue("pull_request_not_open", "Pull request must be open and unmerged"));
  }
  if (pull?.draft) errors.push(issue("pull_request_is_draft", "Draft pull request cannot be merged"));
  if (pull?.mergeable !== true || pull?.mergeable_state !== "clean") {
    errors.push(
      issue(
        "pull_request_not_mergeable",
        "GitHub must report the PR as cleanly mergeable before approval"
      )
    );
  }
  if (reviewSummary.changes_requested.length) {
    errors.push(
      issue("changes_requested", "Review changes must be resolved before merging", {
        reviewers: reviewSummary.changes_requested,
      })
    );
  }
  if (checkSummary.state === "failed") {
    errors.push(issue("checks_failed", "Observed checks are failing"));
  }
  if (checkSummary.state === "pending") {
    errors.push(issue("checks_pending", "Observed checks are still pending"));
  }

  return {
    ready: errors.length === 0,
    errors,
    snapshot: {
      state: pull?.state || null,
      draft: Boolean(pull?.draft),
      merged: Boolean(pull?.merged),
      mergeable: pull?.mergeable ?? null,
      mergeable_state: pull?.mergeable_state ?? null,
      head_ref: pull?.head?.ref || null,
      head_commit: pull?.head?.sha || null,
      base_ref: pull?.base?.ref || null,
      base_commit: pull?.base?.sha || null,
      reviews: reviewSummary,
      checks: checkSummary,
    },
  };
}

export function evaluateDeploymentReadiness({ pull, expectedMergeCommit, target, hook }) {
  const errors = [];

  if (!expectedMergeCommit) {
    errors.push(issue("expected_merge_commit_required", "expected_merge_commit is required"));
  } else if (pull?.merge_commit_sha !== expectedMergeCommit) {
    errors.push(
      issue("merge_commit_changed", "Pull request merge commit does not match", {
        expected: expectedMergeCommit,
        current: pull?.merge_commit_sha || null,
      })
    );
  }

  if (!pull?.merged || pull?.state !== "closed") {
    errors.push(issue("pull_request_not_merged", "Pull request must be merged before deployment"));
  }
  if (!target) errors.push(issue("production_target_not_configured", "Production target is not configured"));
  if (!hook) errors.push(issue("deployment_hook_not_configured", "Deployment hook is not configured"));

  return {
    ready: errors.length === 0,
    errors,
    snapshot: {
      merged: Boolean(pull?.merged),
      merge_commit: pull?.merge_commit_sha || null,
      merged_at: pull?.merged_at || null,
      production_target: target?.name || null,
      deployment_hook_configured: Boolean(hook),
    },
  };
}

export function evaluateDeploymentObservation({
  observation,
  expectedMergeCommit,
  expectedPreviousCommit = null,
}) {
  const errors = [];
  const observedCommit = observation?.observed_commit || null;

  if (observation?.probe_failed) {
    errors.push(
      issue("deployment_probe_failed", "Current production commit could not be verified")
    );
  } else if (!observedCommit) {
    errors.push(
      issue("deployment_commit_unverifiable", "Production did not report its current commit")
    );
  }

  const alreadyDeployed = Boolean(
    observedCommit && expectedMergeCommit && observedCommit === expectedMergeCommit
  );
  if (
    !alreadyDeployed &&
    expectedPreviousCommit &&
    observedCommit &&
    observedCommit !== expectedPreviousCommit
  ) {
    errors.push(
      issue(
        "production_commit_changed",
        "Production changed after deployment preparation; review again before deploying",
        { expected: expectedPreviousCommit, current: observedCommit }
      )
    );
  }

  return {
    ready: errors.length === 0 && !alreadyDeployed,
    already_deployed: alreadyDeployed,
    errors,
    observed_commit: observedCommit,
    rollback_commit: observedCommit,
  };
}

export function parseDeploymentHooks(raw) {
  if (!raw || !String(raw).trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid DEPLOYMENT_HOOKS_JSON: ${err?.message || String(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DEPLOYMENT_HOOKS_JSON must be a JSON object keyed by owner/repo");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([repo, value]) => {
      const hookValue = typeof value === "string" ? value : value?.hook_url;
      let url;
      try {
        url = new URL(hookValue);
      } catch {
        throw new Error(`Invalid deployment hook for ${repo}`);
      }

      if (
        url.protocol !== "https:" ||
        url.hostname !== "api.render.com" ||
        url.username ||
        url.password
      ) {
        throw new Error(`Deployment hook must use https://api.render.com for ${repo}`);
      }
      if (!url.pathname.startsWith("/deploy/") || !url.searchParams.get("key")) {
        throw new Error(`Deployment hook path or key is invalid for ${repo}`);
      }

      return [repo, { hookUrl: url.toString() }];
    })
  );
}

export async function triggerExactCommitDeploy({ hookUrl, commit, fetchImpl = fetch }) {
  const url = new URL(hookUrl);
  url.searchParams.set("ref", commit);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("render_deploy_hook_failed");
  }

  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`render_deploy_hook_http_${response.status}`);
  }

  let body = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return {
    accepted: true,
    http_status: response.status,
    queued: response.status === 202,
    deploy_id: body?.deploy?.id || body?.id || null,
    commit,
  };
}
