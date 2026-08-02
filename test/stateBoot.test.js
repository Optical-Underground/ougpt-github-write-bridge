import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStateBootPacket,
  getRecapPaths,
  selectActiveFronts,
} from "../src/stateBoot.js";

test("selectActiveFronts retains configured active fronts even without mappings", () => {
  const ouState = {
    active_fronts: ["pos-for-optical", "seg-ht-pd-measurement-app", "missing"],
    current_work_model: {
      per_front_files: {
        "pos-for-optical": "current_work/pos-for-optical.md",
        "seg-ht-pd-measurement-app": "current_work/seg-ht-pd-measurement-app.md",
      },
    },
  };

  assert.deepEqual(selectActiveFronts(ouState), [
    "pos-for-optical",
    "seg-ht-pd-measurement-app",
    "missing",
  ]);
});

test("selectActiveFronts can narrow to one requested front", () => {
  const ouState = {
    current_work_model: {
      per_front_files: {
        "pos-for-optical": "current_work/pos-for-optical.md",
      },
    },
  };

  assert.deepEqual(selectActiveFronts(ouState, "pos-for-optical"), ["pos-for-optical"]);
});

test("selectActiveFronts rejects unknown requested front", () => {
  const ouState = {
    active_fronts: ["unmapped"],
    current_work_model: {
      per_front_files: {
        "pos-for-optical": "current_work/pos-for-optical.md",
      },
    },
  };

  assert.throws(() => selectActiveFronts(ouState, "unmapped"), /Unknown or unmapped front/);
});

test("getRecapPaths returns markdown recaps newest first", () => {
  const tree = [
    { path: "recaps/2026-05-01/a.md", type: "file" },
    { path: "recaps/2026-05-30/b.md", type: "file" },
    { path: "recaps/2026-05-30/a.md", type: "file" },
    { path: "recaps/not-a-date/c.md", type: "file" },
    { path: "current_work/pos-for-optical.md", type: "file" },
  ];

  assert.deepEqual(getRecapPaths(tree), [
    "recaps/2026-05-30/b.md",
    "recaps/2026-05-30/a.md",
    "recaps/2026-05-01/a.md",
  ]);
});

function makeBootFixture({ activeFronts, perFrontFiles, readFailures = [] }) {
  const files = new Map([
    [
      "ou_state.json",
      {
        path: "ou_state.json",
        sha: "state-sha",
        content: JSON.stringify({
          state_version: 2,
          active_fronts: activeFronts,
          current_work_model: {
            root_index_file: "current_work.md",
            coordination_file: "current_work/_coordination.md",
            per_front_files: perFrontFiles,
          },
        }),
      },
    ],
    [
      "current_work.md",
      { path: "current_work.md", sha: "root-sha", content: "# Current Work" },
    ],
    [
      "current_work/_coordination.md",
      {
        path: "current_work/_coordination.md",
        sha: "coord-sha",
        content: "# Coordination",
      },
    ],
  ]);

  for (const [front, path] of Object.entries(perFrontFiles)) {
    files.set(path, {
      path,
      sha: `${front}-sha`,
      content: `# ${front}\n\nNext action for ${front}`,
    });
  }

  return {
    getRepoCommitAndTree: async () => ({ commit: "commit-1", tree: [] }),
    readTextFile: async (path) => {
      if (readFailures.includes(path)) {
        throw new Error(`cannot read ${path}`);
      }
      const file = files.get(path);
      if (!file) throw new Error(`missing ${path}`);
      return file;
    },
  };
}

test("boot packet retains and warns for an active front with no mapping", async () => {
  const fixture = makeBootFixture({
    activeFronts: ["mapped", "unmapped"],
    perFrontFiles: {
      mapped: "current_work/mapped.md",
    },
  });

  const packet = await buildStateBootPacket({
    octokit: {},
    owner: "Optical-Underground",
    repoName: "OU-State",
    repo: "Optical-Underground/OU-State",
    ...fixture,
  });

  assert.deepEqual(packet.verified_current_facts.active_fronts, ["mapped", "unmapped"]);
  assert.deepEqual(packet.front_files.unmapped, {
    path: null,
    error: "missing_current_work_mapping",
  });
  assert.equal(packet.source_paths.front_files.unmapped, null);
  assert.ok(
    packet.warnings.some(
      (warning) =>
        warning.type === "active_front_missing_current_work_file" &&
        warning.front === "unmapped"
    )
  );
});

test("boot packet retains a mapped front when its current-work file cannot be read", async () => {
  const failedPath = "current_work/broken.md";
  const fixture = makeBootFixture({
    activeFronts: ["healthy", "broken"],
    perFrontFiles: {
      healthy: "current_work/healthy.md",
      broken: failedPath,
    },
    readFailures: [failedPath],
  });

  const packet = await buildStateBootPacket({
    octokit: {},
    owner: "Optical-Underground",
    repoName: "OU-State",
    repo: "Optical-Underground/OU-State",
    ...fixture,
  });

  assert.deepEqual(packet.verified_current_facts.active_fronts, ["healthy", "broken"]);
  assert.deepEqual(packet.front_files.broken, {
    path: failedPath,
    error: "missing_or_unreadable",
  });
  assert.equal(packet.source_paths.front_files.broken, failedPath);
  assert.ok(
    packet.warnings.some(
      (warning) =>
        warning.type === "missing_or_unreadable_file" &&
        warning.path === failedPath
    )
  );
});
