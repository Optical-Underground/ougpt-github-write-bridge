import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAuthorizedRequestMatches,
  evaluateDeploymentObservation,
  evaluateDeploymentReadiness,
  evaluateMergeReadiness,
  parseDeploymentHooks,
  triggerExactCommitDeploy,
} from "../src/guardedExecution.js";

function openPull(overrides = {}) {
  return {
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { ref: "feature", sha: "head-sha" },
    base: { ref: "main", sha: "base-sha" },
    ...overrides,
  };
}

test("execute request must repeat the signed target for an informed approval", () => {
  const authorizationDetails = {
    repo: "Optical-Underground/example",
    pr_number: 12,
    expected_head_commit: "head-sha",
    expected_base_commit: "base-sha",
  };
  assert.doesNotThrow(() =>
    assertAuthorizedRequestMatches({
      authorizationDetails,
      requestDetails: { ...authorizationDetails },
      fields: ["repo", "pr_number", "expected_head_commit", "expected_base_commit"],
    })
  );
  assert.throws(
    () =>
      assertAuthorizedRequestMatches({
        authorizationDetails,
        requestDetails: { ...authorizationDetails, pr_number: 13 },
        fields: ["repo", "pr_number", "expected_head_commit", "expected_base_commit"],
      }),
    /authorization_request_mismatch/
  );
});

test("clean exact-head PR with no configured checks is ready for explicit merge approval", () => {
  const result = evaluateMergeReadiness({
    pull: openPull(),
    expectedHeadCommit: "head-sha",
    expectedBaseCommit: "base-sha",
    combinedStatus: { state: "pending", total_count: 0 },
  });

  assert.equal(result.ready, true);
  assert.equal(result.snapshot.checks.state, "none");
});

test("merge readiness rejects stale head, draft, requested changes, and check failures", () => {
  const stale = evaluateMergeReadiness({
    pull: openPull(),
    expectedHeadCommit: "older-head",
    expectedBaseCommit: "base-sha",
  });
  assert.equal(stale.ready, false);
  assert.ok(stale.errors.some((error) => error.code === "head_commit_changed"));

  const blocked = evaluateMergeReadiness({
    pull: openPull({ draft: true }),
    expectedHeadCommit: "head-sha",
    expectedBaseCommit: "base-sha",
    reviews: [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED" }],
    checkRuns: [{ status: "completed", conclusion: "failure" }],
  });
  assert.deepEqual(
    blocked.errors.map((error) => error.code).sort(),
    ["checks_failed", "changes_requested", "pull_request_is_draft"].sort()
  );
});

test("merge readiness rejects pending checks", () => {
  const result = evaluateMergeReadiness({
    pull: openPull(),
    expectedHeadCommit: "head-sha",
    expectedBaseCommit: "base-sha",
    checkRuns: [{ status: "in_progress", conclusion: null }],
  });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.code === "checks_pending"));
});

test("merge readiness fails closed when GitHub mergeability is unknown", () => {
  const result = evaluateMergeReadiness({
    pull: openPull({ mergeable_state: "unknown" }),
    expectedHeadCommit: "head-sha",
    expectedBaseCommit: "base-sha",
  });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.code === "pull_request_not_mergeable"));
});

test("merge readiness rejects a base branch that advanced after preparation", () => {
  const result = evaluateMergeReadiness({
    pull: openPull({ base: { ref: "main", sha: "new-base" } }),
    expectedHeadCommit: "head-sha",
    expectedBaseCommit: "old-base",
  });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some((error) => error.code === "base_commit_changed"));
});

test("deployment readiness requires a merged PR, exact commit, target, and hook", () => {
  const pull = openPull({
    state: "closed",
    merged: true,
    merge_commit_sha: "merge-sha",
    merged_at: "2026-08-07T20:00:00Z",
  });
  const ready = evaluateDeploymentReadiness({
    pull,
    expectedMergeCommit: "merge-sha",
    target: { name: "Production" },
    hook: { hookUrl: "secret" },
  });
  assert.equal(ready.ready, true);

  const rejected = evaluateDeploymentReadiness({
    pull,
    expectedMergeCommit: "wrong-sha",
    target: null,
    hook: null,
  });
  assert.equal(rejected.ready, false);
  assert.deepEqual(
    rejected.errors.map((error) => error.code).sort(),
    ["deployment_hook_not_configured", "merge_commit_changed", "production_target_not_configured"].sort()
  );
});

test("deployment observation binds approval to the exact currently live commit", () => {
  const prepared = evaluateDeploymentObservation({
    observation: { observed_commit: "old-live", probe_failed: false },
    expectedMergeCommit: "new-merge",
  });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.rollback_commit, "old-live");

  const stale = evaluateDeploymentObservation({
    observation: { observed_commit: "unexpected-newer", probe_failed: false },
    expectedMergeCommit: "new-merge",
    expectedPreviousCommit: "old-live",
  });
  assert.equal(stale.ready, false);
  assert.ok(stale.errors.some((error) => error.code === "production_commit_changed"));

  const complete = evaluateDeploymentObservation({
    observation: { observed_commit: "new-merge", probe_failed: false },
    expectedMergeCommit: "new-merge",
    expectedPreviousCommit: "old-live",
  });
  assert.equal(complete.already_deployed, true);
  assert.equal(complete.ready, false);
});

test("deployment preparation fails closed without trustworthy live commit evidence", () => {
  const failedProbe = evaluateDeploymentObservation({
    observation: { observed_commit: null, probe_failed: true },
    expectedMergeCommit: "new-merge",
  });
  assert.equal(failedProbe.ready, false);
  assert.ok(failedProbe.errors.some((error) => error.code === "deployment_probe_failed"));

  const missingCommit = evaluateDeploymentObservation({
    observation: { observed_commit: null, probe_failed: false },
    expectedMergeCommit: "new-merge",
  });
  assert.equal(missingCommit.ready, false);
  assert.ok(
    missingCommit.errors.some((error) => error.code === "deployment_commit_unverifiable")
  );
});

test("deployment hooks accept only secret-bearing Render HTTPS hooks", () => {
  const parsed = parseDeploymentHooks(
    JSON.stringify({
      "Optical-Underground/example":
        "https://api.render.com/deploy/srv-example?key=super-secret",
    })
  );
  assert.ok(parsed["Optical-Underground/example"].hookUrl.includes("api.render.com/deploy/"));

  assert.throws(
    () =>
      parseDeploymentHooks(
        JSON.stringify({
          "Optical-Underground/example": "http://api.render.com/deploy/srv-example?key=secret",
        })
      ),
    /must use https/
  );
  assert.throws(
    () =>
      parseDeploymentHooks(
        JSON.stringify({
          "Optical-Underground/example": "https://example.com/deploy/srv-example?key=secret",
        })
      ),
    /must use https:\/\/api.render.com/
  );
  assert.throws(
    () =>
      parseDeploymentHooks(
        JSON.stringify({
          "Optical-Underground/example": "https://api.render.com/deploy/srv-example",
        })
      ),
    /path or key is invalid/
  );
  assert.throws(
    () =>
      parseDeploymentHooks(
        JSON.stringify({
          "Optical-Underground/example":
            "https://username:password@api.render.com/deploy/srv-example?key=secret",
        })
      ),
    /must use https:\/\/api.render.com/
  );
});

test("exact-commit deployment posts the ref without exposing the hook secret", async () => {
  let observedUrl = null;
  let observedOptions = null;
  const result = await triggerExactCommitDeploy({
    hookUrl: "https://api.render.com/deploy/srv-example?key=super-secret",
    commit: "merge-sha",
    fetchImpl: async (url, options) => {
      observedUrl = url;
      observedOptions = options;
      return new Response(JSON.stringify({ deploy: { id: "dep-123" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(observedUrl.searchParams.get("ref"), "merge-sha");
  assert.equal(observedUrl.searchParams.get("key"), "super-secret");
  assert.equal(observedOptions.method, "POST");
  assert.equal(result.deploy_id, "dep-123");
  assert.equal(result.commit, "merge-sha");
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
});
