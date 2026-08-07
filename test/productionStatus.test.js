import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProductionStatusPacket,
  parseProductionTargets,
  summarizeChecks,
  summarizeReviews,
} from "../src/productionStatus.js";

function fixture(overrides = {}) {
  const pull = {
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    head: { ref: "feature", sha: "head-sha" },
    base: { ref: "main", sha: "base-sha" },
    merge_commit_sha: null,
    merged_at: null,
  };

  return {
    repo: "Optical-Underground/example",
    prNumber: 12,
    target: null,
    getPullRequest: async () => pull,
    getReviews: async () => [],
    getCheckRuns: async () => [],
    getCombinedStatus: async () => "success",
    fetchDeploymentJson: async () => {
      throw new Error("deployment probe should not run");
    },
    now: new Date("2026-08-06T20:00:00Z"),
    ...overrides,
  };
}

test("parses only server-configured HTTPS deployment targets", () => {
  const targets = parseProductionTargets(
    JSON.stringify({
      "Optical-Underground/example": {
        name: "Example production",
        health_url: "https://example.com/health",
        version_url: "https://example.com/version",
      },
    })
  );

  assert.equal(targets["Optical-Underground/example"].name, "Example production");
  assert.equal(targets["Optical-Underground/example"].commitField, "render_git_commit");
  assert.throws(
    () =>
      parseProductionTargets(
        JSON.stringify({
          "Optical-Underground/example": { health_url: "http://localhost/health" },
        })
      ),
    /must use https/
  );
});

test("summarizes the latest substantive review per reviewer", () => {
  const summary = summarizeReviews([
    { user: { login: "alex" }, state: "CHANGES_REQUESTED" },
    { user: { login: "alex" }, state: "APPROVED" },
    { user: { login: "sam" }, state: "CHANGES_REQUESTED" },
    { user: { login: "lee" }, state: "COMMENTED" },
  ]);

  assert.deepEqual(summary.approvals, ["alex"]);
  assert.deepEqual(summary.changes_requested, ["sam"]);
});

test("summarizes failed, pending, and passing checks", () => {
  assert.equal(
    summarizeChecks([{ status: "completed", conclusion: "failure" }], "success").state,
    "failed"
  );
  assert.equal(
    summarizeChecks([{ status: "in_progress", conclusion: null }], "success").state,
    "pending"
  );
  assert.equal(
    summarizeChecks([{ status: "completed", conclusion: "success" }], "success").state,
    "passing"
  );
});

test("open clean PR awaits high-risk merge approval without probing deployment", async () => {
  const packet = await buildProductionStatusPacket(fixture());
  assert.equal(packet.deployment.status, "not_merged");
  assert.equal(packet.next_action, "await_high_risk_merge_approval");
});

test("merged PR without a configured target reports the configuration gap", async () => {
  const input = fixture();
  input.getPullRequest = async () => ({
    ...(await fixture().getPullRequest()),
    state: "closed",
    merged: true,
    merge_commit_sha: "merge-sha",
    merged_at: "2026-08-06T19:55:00Z",
  });

  const packet = await buildProductionStatusPacket(input);
  assert.equal(packet.deployment.status, "not_configured");
  assert.equal(packet.next_action, "configure_deployment_target");
});

test("merged PR is deployed only when the observed commit exactly matches", async () => {
  const input = fixture({
    target: {
      name: "Example production",
      healthUrl: "https://example.com/health",
      versionUrl: "https://example.com/version",
      commitField: "render_git_commit",
      maxPendingMinutes: 20,
    },
  });
  input.getPullRequest = async () => ({
    ...(await fixture().getPullRequest()),
    state: "closed",
    merged: true,
    merge_commit_sha: "merge-sha",
    merged_at: "2026-08-06T19:55:00Z",
  });
  input.fetchDeploymentJson = async (url) => ({
    ok: true,
    http_status: 200,
    body: url.endsWith("version") ? { render_git_commit: "merge-sha" } : { status: "ok" },
    error: null,
  });

  const packet = await buildProductionStatusPacket(input);
  assert.equal(packet.deployment.status, "deployed");
  assert.equal(packet.deployment.observed_commit, "merge-sha");
  assert.equal(packet.next_action, "record_live_verification");
});

test("recent differing deployment is pending", async () => {
  const input = fixture({
    target: {
      name: "Example production",
      healthUrl: "https://example.com/health",
      versionUrl: null,
      commitField: "render_git_commit",
      maxPendingMinutes: 20,
    },
  });
  input.getPullRequest = async () => ({
    ...(await fixture().getPullRequest()),
    state: "closed",
    merged: true,
    merge_commit_sha: "merge-sha",
    merged_at: "2026-08-06T19:55:00Z",
  });
  input.fetchDeploymentJson = async () => ({
    ok: true,
    http_status: 200,
    body: { render_git_commit: "older-sha" },
    error: null,
  });

  const packet = await buildProductionStatusPacket(input);
  assert.equal(packet.deployment.status, "pending");
  assert.equal(packet.next_action, "wait_for_deployment");
});

test("old differing deployment becomes a deployment mismatch", async () => {
  const input = fixture({
    target: {
      name: "Example production",
      healthUrl: "https://example.com/health",
      versionUrl: null,
      commitField: "render_git_commit",
      maxPendingMinutes: 20,
    },
  });
  input.getPullRequest = async () => ({
    ...(await fixture().getPullRequest()),
    state: "closed",
    merged: true,
    merge_commit_sha: "merge-sha",
    merged_at: "2026-08-06T18:00:00Z",
  });
  input.fetchDeploymentJson = async () => ({
    ok: true,
    http_status: 200,
    body: { render_git_commit: "older-sha" },
    error: null,
  });

  const packet = await buildProductionStatusPacket(input);
  assert.equal(packet.deployment.status, "deployment_mismatch");
  assert.equal(packet.next_action, "investigate_deployment_mismatch");
});

test("successful probes without commit evidence remain unverifiable", async () => {
  const input = fixture({
    target: {
      name: "Example production",
      healthUrl: "https://example.com/health",
      versionUrl: null,
      commitField: "render_git_commit",
      maxPendingMinutes: 20,
    },
  });
  input.getPullRequest = async () => ({
    ...(await fixture().getPullRequest()),
    state: "closed",
    merged: true,
    merge_commit_sha: "merge-sha",
    merged_at: "2026-08-06T19:55:00Z",
  });
  input.fetchDeploymentJson = async () => ({
    ok: true,
    http_status: 200,
    body: { status: "ok" },
    error: null,
  });

  const packet = await buildProductionStatusPacket(input);
  assert.equal(packet.deployment.status, "unverifiable");
  assert.equal(packet.next_action, "add_deployed_commit_evidence");
});
