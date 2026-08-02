function splitPathDate(path) {
  const match = String(path || "").match(/^recaps\/(\d{4}-\d{2}-\d{2})\/(.+\.md)$/);
  if (!match) return null;
  return { date: match[1], path };
}

export function getRecapPaths(tree) {
  return (tree || [])
    .filter((node) => node?.type === "file")
    .map((node) => splitPathDate(node.path))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return b.path.localeCompare(a.path);
    })
    .map((item) => item.path);
}

export function selectActiveFronts(ouState, requestedFront = null) {
  const perFrontFiles = ouState?.current_work_model?.per_front_files || {};
  const configuredFronts = Array.isArray(ouState?.active_fronts)
    ? [...ouState.active_fronts]
    : Object.keys(perFrontFiles);

  if (!requestedFront) return configuredFronts;

  if (!perFrontFiles[requestedFront]) {
    throw new Error(`Unknown or unmapped front: ${requestedFront}`);
  }

  return [requestedFront];
}

function markdownSummary(content, maxChars = 900) {
  const text = String(content || "");
  const headings = text
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+\S/.test(line))
    .slice(0, 8)
    .map((line) => line.replace(/^#{1,3}\s+/, "").trim());

  const excerpt = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join("\n")
    .slice(0, maxChars);

  return {
    headings,
    excerpt,
  };
}

async function safeRead(readTextFile, path, ref, warnings) {
  try {
    return await readTextFile(path, ref);
  } catch (err) {
    warnings.push({
      type: "missing_or_unreadable_file",
      path,
      message: err?.message || String(err),
    });
    return null;
  }
}

function parseJson(content, path) {
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${err?.message || String(err)}`);
  }
}

function uniqueDefined(values) {
  return [...new Set(values.filter(Boolean))];
}

function parkedWorkFromState(ouState) {
  const parked = Array.isArray(ouState?.workstreams?.parked)
    ? ouState.workstreams.parked.map((item) => ({
        key: item.key,
        repo: item.repo || ouState?.projects?.[item.key]?.repo || null,
      }))
    : [];

  const projectParked = Object.entries(ouState?.projects || {})
    .filter(([, project]) => project?.status === "parked")
    .map(([key, project]) => ({ key, repo: project.repo || null }));

  return uniqueDefined([...parked, ...projectParked].map((item) => JSON.stringify(item))).map((item) =>
    JSON.parse(item)
  );
}

async function newestRelevantRecapForFront({
  front,
  recapPaths,
  readTextFile,
  sourceCommit,
  warnings,
  maxRecapsToScan,
}) {
  for (const path of recapPaths.slice(0, maxRecapsToScan)) {
    const file = await safeRead(readTextFile, path, sourceCommit, warnings);
    if (!file) continue;

    if (String(file.content || "").includes(front)) {
      return {
        path,
        sha: file.sha,
        summary: markdownSummary(file.content, 700),
      };
    }
  }

  return null;
}

export async function buildStateBootPacket({
  octokit,
  owner,
  repoName,
  repo,
  ref = "main",
  requestedFront = null,
  readTextFile,
  getRepoCommitAndTree,
  maxRecapsToScan = 20,
}) {
  const warnings = [];

  const repoSnapshot = await getRepoCommitAndTree({ octokit, owner, repoName, ref });
  const sourceCommit = repoSnapshot.commit;
  const tree = repoSnapshot.tree || [];

  const ouStateFile = await safeRead(readTextFile, "ou_state.json", sourceCommit, warnings);
  if (!ouStateFile) {
    throw new Error("Cannot boot without ou_state.json");
  }

  const ouState = parseJson(ouStateFile.content, "ou_state.json");
  const model = ouState.current_work_model || {};
  const perFrontFiles = model.per_front_files || {};
  const activeFronts = selectActiveFronts(ouState, requestedFront);

  const rootIndexPath = model.root_index_file || "current_work.md";
  const coordinationPath = model.coordination_file || null;

  const activeFrontsMissingFiles = activeFronts.filter((front) => !perFrontFiles[front]);
  for (const front of activeFrontsMissingFiles) {
    warnings.push({
      type: "active_front_missing_current_work_file",
      front,
    });
  }

  const rootIndex = await safeRead(readTextFile, rootIndexPath, sourceCommit, warnings);
  const coordination = coordinationPath
    ? await safeRead(readTextFile, coordinationPath, sourceCommit, warnings)
    : null;

  const frontFiles = {};
  for (const front of activeFronts) {
    const path = perFrontFiles[front];

    if (!path) {
      frontFiles[front] = {
        path: null,
        error: "missing_current_work_mapping",
      };
      continue;
    }

    const file = await safeRead(readTextFile, path, sourceCommit, warnings);
    frontFiles[front] = file
      ? {
          path,
          sha: file.sha,
          summary: markdownSummary(file.content),
        }
      : {
          path,
          error: "missing_or_unreadable",
        };
  }

  const recapPaths = getRecapPaths(tree);
  const latestRecapPath = recapPaths[0] || null;
  const latestRecap = latestRecapPath
    ? await safeRead(readTextFile, latestRecapPath, sourceCommit, warnings)
    : null;

  const newestRelevantRecaps = {};
  for (const front of activeFronts) {
    newestRelevantRecaps[front] = await newestRelevantRecapForFront({
      front,
      recapPaths,
      readTextFile,
      sourceCommit,
      warnings,
      maxRecapsToScan,
    });
  }

  const knownFronts = Object.keys(perFrontFiles);

  return {
    ok: true,
    operation: "state_boot",
    generated_at: new Date().toISOString(),
    source: {
      repo,
      ref,
      commit: sourceCommit,
    },
    request: {
      front: requestedFront || null,
    },
    verified_current_facts: {
      state_version: ouState.state_version ?? null,
      active_project: ouState.active_project ?? null,
      active_fronts: activeFronts,
      known_fronts: knownFronts,
      primary_workstream: ouState.workstreams?.primary ?? null,
      parked_work: parkedWorkFromState(ouState),
      security: {
        enforce_signature: ouState.security?.enforce_signature ?? null,
        block_external_gpts: ouState.security?.block_external_gpts ?? null,
      },
    },
    current_work_model: {
      version: model.version ?? null,
      root_index_file: rootIndexPath,
      coordination_file: coordinationPath,
      per_front_files: perFrontFiles,
      notes: model.notes || null,
    },
    source_paths: {
      ou_state: "ou_state.json",
      root_index: rootIndex ? rootIndex.path : rootIndexPath,
      coordination: coordination ? coordination.path : coordinationPath,
      front_files: Object.fromEntries(
        Object.entries(frontFiles).map(([front, file]) => [front, file.path])
      ),
      latest_recap: latestRecap ? latestRecap.path : latestRecapPath,
      newest_relevant_recaps: Object.fromEntries(
        Object.entries(newestRelevantRecaps).map(([front, recap]) => [front, recap?.path || null])
      ),
    },
    current_objective: {
      by_front: Object.fromEntries(
        Object.entries(frontFiles).map(([front, file]) => [front, file.summary || null])
      ),
      coordination: coordination ? markdownSummary(coordination.content) : null,
      root_index: rootIndex ? markdownSummary(rootIndex.content, 700) : null,
    },
    incomplete_work_and_exact_next_action: {
      by_front: Object.fromEntries(
        Object.entries(frontFiles).map(([front, file]) => [front, file.summary?.excerpt || null])
      ),
    },
    blockers: warnings.filter((warning) => warning.type === "missing_or_unreadable_file"),
    stale_or_conflicting_claims: warnings.filter(
      (warning) => warning.type !== "missing_or_unreadable_file"
    ),
    work_believed_complete_but_not_yet_verified: [],
    active_pr_deployment_references: [],
    locked_decisions: coordination ? markdownSummary(coordination.content, 700).headings : [],
    latest_recaps: {
      overall: latestRecap
        ? {
            path: latestRecap.path,
            sha: latestRecap.sha,
            summary: markdownSummary(latestRecap.content, 700),
          }
        : null,
      by_front: newestRelevantRecaps,
    },
    parked_work: parkedWorkFromState(ouState),
    front_files: frontFiles,
    warnings,
  };
}
