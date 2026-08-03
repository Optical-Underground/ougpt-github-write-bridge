import assert from "node:assert/strict";
import test from "node:test";
import {
  findLikelySecrets,
  getProposedOuState,
  validateStateChange,
} from "../src/stateValidation.js";

function fixture(overrides = {}) {
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

  return {
    currentCommit: "commit-current",
    baseCommit: "commit-current",
    currentState,
    proposedState: structuredClone(currentState),
    existingPaths: [
      "ou_state.json",
      "current_work.md",
      "current_work/_coordination.md",
      "current_work/pos-for-optical.md",
      "current_work/seg-ht-pd-measurement-app.md",
    ],
    edits: [],
    ...overrides,
  };
}

test("accepts a valid state change based on current commit", () => {
  const result = validateStateChange(fixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("rejects a stale base commit", () => {
  const result = validateStateChange(fixture({ baseCommit: "old-commit" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === "stale_base_commit"));
});

test("requires a base commit", () => {
  const result = validateStateChange(fixture({ baseCommit: null }));
  assert.ok(result.errors.some((error) => error.code === "base_commit_required"));
});

test("rejects removal of an active front", () => {
  const input = fixture();
  input.proposedState.active_fronts = ["pos-for-optical"];
  const result = validateStateChange(input);
  assert.ok(result.errors.some((error) => error.code === "active_front_removed"));
});

test("rejects an active front without a mapping", () => {
  const input = fixture();
  delete input.proposedState.current_work_model.per_front_files["seg-ht-pd-measurement-app"];
  const result = validateStateChange(input);
  assert.ok(result.errors.some((error) => error.code === "active_front_missing_mapping"));
});

test("rejects a mapped file deleted by the proposed edits", () => {
  const input = fixture({
    edits: [
      {
        path: "current_work/pos-for-optical.md",
        action: "delete",
      },
    ],
  });
  const result = validateStateChange(input);
  assert.ok(result.errors.some((error) => error.code === "referenced_file_missing"));
});

test("rejects likely secrets", () => {
  const findings = findLikelySecrets({
    note: "github_pat_123456789012345678901234567890",
  });
  assert.equal(findings[0].code, "likely_secret");
});

test("rejects legacy memory authority edits", () => {
  const result = validateStateChange(
    fixture({
      edits: [
        {
          path: ".ougpt/memory/current.json",
          action: "create",
          content: "{}",
        },
      ],
    })
  );
  assert.ok(result.errors.some((error) => error.code === "legacy_memory_authority_blocked"));
});

test("rejects complete task without verification evidence", () => {
  const input = fixture();
  input.proposedState.tasks = {
    "task-1": {
      task_id: "task-1",
      status: "complete",
      acceptance_criteria: ["works"],
    },
  };
  const result = validateStateChange(input);
  assert.ok(result.errors.some((error) => error.code === "complete_without_verification"));
});

test("accepts complete task with verification evidence", () => {
  const input = fixture();
  input.proposedState.tasks = {
    "task-1": {
      task_id: "task-1",
      status: "complete",
      acceptance_criteria: ["works"],
      verification_evidence: ["production smoke test passed"],
    },
  };
  const result = validateStateChange(input);
  assert.equal(result.ok, true);
});

test("parses proposed ou_state.json from edits", () => {
  const currentState = { active_fronts: [] };
  const proposed = { active_fronts: ["pos-for-optical"] };
  assert.deepEqual(
    getProposedOuState(
      [
        {
          path: "ou_state.json",
          action: "update",
          content: JSON.stringify(proposed),
        },
      ],
      currentState
    ),
    proposed
  );
});

test("rejects deletion of ou_state.json", () => {
  assert.throws(
    () =>
      getProposedOuState(
        [{ path: "ou_state.json", action: "delete" }],
        { active_fronts: [] }
      ),
    /cannot be deleted/
  );
});
