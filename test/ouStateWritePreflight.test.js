import assert from "node:assert/strict";
import test from "node:test";
import {
  formatStateValidationResponse,
  prepareOuStateWrite,
} from "../src/ouStateWritePreflight.js";

function makeFixture(baseCommit) {
  const calls = {
    resolveSnapshot: 0,
    readTextFile: [],
    createBlob: 0,
    createTree: 0,
    createCommit: 0,
    createRef: 0,
    updateRef: 0,
    createPullRequest: 0,
  };

  const currentState = {
    active_fronts: ["pos-for-optical", "seg-ht-pd-measurement-app"],
    current_work_model: {
      root_index_file: "current_work.md",
      coordination_file: "current_work/_coordination.md",
      per_front_files: {
        "pos-for-optical": "current_work/pos-for-optical.md",
        "seg-ht-pd-measurement-app": "current_work/seg-ht-pd-measurement-app.md",
      },
    },
  };

  const snapshot = {
    commit: "commit-current",
    treeSha: "tree-current",
    tree: [
      { path: "ou_state.json", type: "file" },
      { path: "current_work.md", type: "file" },
      { path: "current_work/_coordination.md", type: "file" },
      { path: "current_work/pos-for-optical.md", type: "file" },
      { path: "current_work/seg-ht-pd-measurement-app.md", type: "file" },
    ],
  };

  const mutations = {
    createBlob: async () => { calls.createBlob += 1; },
    createTree: async () => { calls.createTree += 1; },
    createCommit: async () => { calls.createCommit += 1; },
    createRef: async () => { calls.createRef += 1; },
    updateRef: async () => { calls.updateRef += 1; },
    createPullRequest: async () => { calls.createPullRequest += 1; },
  };

  return {
    calls,
    mutations,
    input: {
      baseCommit,
      edits: [
        {
          path: "current_work/pos-for-optical.md",
          action: "update",
          content: "# Updated current work",
        },
      ],
      resolveSnapshot: async () => {
        calls.resolveSnapshot += 1;
        return snapshot;
      },
      readTextFile: async (path, ref) => {
        calls.readTextFile.push({ path, ref });
        return {
          path,
          sha: "ou-state-file-sha",
          content: JSON.stringify(currentState),
        };
      },
    },
  };
}

async function runGuardedMutation(fixture) {
  const result = await prepareOuStateWrite(fixture.input);

  if (result.validation.ok) {
    await fixture.mutations.createBlob();
    await fixture.mutations.createTree();
    await fixture.mutations.createCommit();
    await fixture.mutations.createRef();
    await fixture.mutations.createPullRequest();
  }

  return result;
}

function assertZeroMutations(calls) {
  assert.equal(calls.createBlob, 0);
  assert.equal(calls.createTree, 0);
  assert.equal(calls.createCommit, 0);
  assert.equal(calls.createRef, 0);
  assert.equal(calls.updateRef, 0);
  assert.equal(calls.createPullRequest, 0);
}

test("missing base_commit resolves once and causes zero GitHub mutations", async () => {
  const fixture = makeFixture(null);
  const result = await runGuardedMutation(fixture);

  assert.equal(result.validation.ok, false);
  assert.ok(result.validation.errors.some((error) => error.code === "base_commit_required"));
  assert.equal(fixture.calls.resolveSnapshot, 1);
  assert.deepEqual(fixture.calls.readTextFile, [
    { path: "ou_state.json", ref: "commit-current" },
  ]);
  assertZeroMutations(fixture.calls);
});

test("stale base_commit resolves once and causes zero GitHub mutations", async () => {
  const fixture = makeFixture("commit-stale");
  const result = await runGuardedMutation(fixture);

  assert.equal(result.validation.ok, false);
  assert.ok(result.validation.errors.some((error) => error.code === "stale_base_commit"));
  assert.equal(fixture.calls.resolveSnapshot, 1);
  assert.deepEqual(fixture.calls.readTextFile, [
    { path: "ou_state.json", ref: "commit-current" },
  ]);
  assertZeroMutations(fixture.calls);
});

test("valid base_commit returns the immutable commit and tree for the write phase", async () => {
  const fixture = makeFixture("commit-current");
  const result = await prepareOuStateWrite(fixture.input);

  assert.equal(result.validation.ok, true);
  assert.equal(result.snapshot.commit, "commit-current");
  assert.equal(result.snapshot.treeSha, "tree-current");
  assert.equal(fixture.calls.resolveSnapshot, 1);
  assert.deepEqual(fixture.calls.readTextFile, [
    { path: "ou_state.json", ref: "commit-current" },
  ]);
  assertZeroMutations(fixture.calls);
});

test("formats a completed invalid validation as a successful transport response", () => {
  const validation = {
    ok: false,
    errors: [{ code: "stale_base_commit", message: "stale" }],
    warnings: [],
    current_commit: "commit-current",
    base_commit: "commit-stale",
  };

  const response = formatStateValidationResponse(validation);

  assert.equal(response.ok, true);
  assert.equal(response.valid, false);
  assert.deepEqual(response.errors, validation.errors);
  assert.equal(validation.ok, false);
});

test("transport wrapping does not weaken the invalid write guard", async () => {
  const fixture = makeFixture("commit-stale");
  const result = await runGuardedMutation(fixture);
  const response = formatStateValidationResponse(result.validation);

  assert.equal(response.ok, true);
  assert.equal(response.valid, false);
  assert.equal(result.validation.ok, false);
  assertZeroMutations(fixture.calls);
});
