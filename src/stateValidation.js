const ALLOWED_TASK_STATUSES = new Set([
  "planned",
  "implementing",
  "pr_open",
  "checks_running",
  "changes_required",
  "ready_to_merge",
  "awaiting_high_risk_approval",
  "merged",
  "deploying",
  "live_verification",
  "awaiting_manual_test",
  "complete",
  "rolled_back",
  "blocked",
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{16,}/i,
];

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

export function findLikelySecrets(value, path = "$", findings = []) {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        findings.push(issue("likely_secret", `Likely secret detected at ${path}`, { path }));
        break;
      }
    }
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => findLikelySecrets(item, `${path}[${index}]`, findings));
    return findings;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      findLikelySecrets(item, `${path}.${key}`, findings);
    }
  }

  return findings;
}

function collectTaskRecords(value, path = "$", records = []) {
  if (!value || typeof value !== "object") return records;

  if (
    !Array.isArray(value) &&
    typeof value.status === "string" &&
    (value.task_id || value.taskId || value.acceptance_criteria || value.verification)
  ) {
    records.push({ path, record: value });
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTaskRecords(item, `${path}[${index}]`, records));
  } else {
    for (const [key, item] of Object.entries(value)) {
      collectTaskRecords(item, `${path}.${key}`, records);
    }
  }

  return records;
}

function hasVerificationEvidence(record) {
  const evidence =
    record.verification_evidence ??
    record.verification ??
    record.functional_verification ??
    record.live_verification;

  if (Array.isArray(evidence)) return evidence.length > 0;
  if (typeof evidence === "string") return evidence.trim().length > 0;
  if (evidence && typeof evidence === "object") return Object.keys(evidence).length > 0;
  return false;
}

function applyPathEdits(existingPaths, edits) {
  const paths = new Set(existingPaths || []);
  for (const edit of edits || []) {
    if (!edit?.path) continue;
    if (edit.action === "delete") paths.delete(edit.path);
    else paths.add(edit.path);
  }
  return paths;
}

export function getProposedOuState(edits, currentState) {
  const edit = (edits || []).find((item) => item?.path === "ou_state.json");
  if (!edit) return currentState;

  if (edit.action === "delete") {
    throw new Error("ou_state.json cannot be deleted");
  }

  try {
    return JSON.parse(edit.content);
  } catch (err) {
    throw new Error(`Invalid JSON in proposed ou_state.json: ${err?.message || String(err)}`);
  }
}

export function validateStateChange({
  currentCommit,
  baseCommit,
  currentState,
  proposedState,
  existingPaths,
  edits = [],
}) {
  const errors = [];
  const warnings = [];

  if (!baseCommit || typeof baseCommit !== "string") {
    errors.push(issue("base_commit_required", "base_commit is required for OU-State changes"));
  } else if (baseCommit !== currentCommit) {
    errors.push(
      issue("stale_base_commit", "OU-State main advanced; rehydrate and regenerate the change", {
        expected: currentCommit,
        received: baseCommit,
      })
    );
  }

  if (!proposedState || typeof proposedState !== "object" || Array.isArray(proposedState)) {
    errors.push(issue("invalid_state", "Proposed ou_state.json must be a JSON object"));
    return { ok: false, errors, warnings };
  }

  const activeFronts = Array.isArray(proposedState.active_fronts)
    ? proposedState.active_fronts
    : [];
  const currentActiveFronts = Array.isArray(currentState?.active_fronts)
    ? currentState.active_fronts
    : [];

  for (const front of currentActiveFronts) {
    if (!activeFronts.includes(front)) {
      errors.push(
        issue("active_front_removed", `Active front cannot disappear without explicit migration: ${front}`, {
          front,
        })
      );
    }
  }

  const model = proposedState.current_work_model;
  if (!model || typeof model !== "object") {
    errors.push(issue("current_work_model_required", "current_work_model is required"));
  }

  const perFrontFiles = model?.per_front_files;
  if (!perFrontFiles || typeof perFrontFiles !== "object" || Array.isArray(perFrontFiles)) {
    errors.push(issue("per_front_files_required", "current_work_model.per_front_files is required"));
  }

  const proposedPaths = applyPathEdits(existingPaths, edits);
  const requiredPaths = [
    model?.root_index_file,
    model?.coordination_file,
    ...activeFronts.map((front) => perFrontFiles?.[front]),
  ];

  activeFronts.forEach((front) => {
    if (!perFrontFiles?.[front]) {
      errors.push(
        issue("active_front_missing_mapping", `Active front lacks a current-work mapping: ${front}`, {
          front,
        })
      );
    }
  });

  for (const path of requiredPaths.filter(Boolean)) {
    if (!proposedPaths.has(path)) {
      errors.push(issue("referenced_file_missing", `Referenced state file does not exist: ${path}`, { path }));
    }
  }

  for (const edit of edits) {
    if (String(edit?.path || "").startsWith(".ougpt/memory/")) {
      errors.push(
        issue(
          "legacy_memory_authority_blocked",
          `Legacy memory path cannot be reintroduced as live authority: ${edit.path}`,
          { path: edit.path }
        )
      );
    }
  }

  errors.push(...findLikelySecrets({ proposedState, edits }));

  for (const { path, record } of collectTaskRecords(proposedState)) {
    if (!ALLOWED_TASK_STATUSES.has(record.status)) {
      errors.push(
        issue("invalid_task_status", `Invalid task status at ${path}: ${record.status}`, {
          path,
          status: record.status,
        })
      );
    }

    if (record.status === "complete" && !hasVerificationEvidence(record)) {
      errors.push(
        issue(
          "complete_without_verification",
          `Task cannot be complete without verification evidence at ${path}`,
          { path }
        )
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    current_commit: currentCommit,
    base_commit: baseCommit || null,
    active_fronts: activeFronts,
    checked_paths: [...new Set(requiredPaths.filter(Boolean))],
  };
}
