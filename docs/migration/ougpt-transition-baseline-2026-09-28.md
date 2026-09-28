# OUgpt Transition Baseline

Captured: 2026-09-28
Status: Migration baseline; documentation only

## Purpose

This file records the source-backed behavior that the future OUgpt plugin must preserve. It is a functional baseline, not a replacement for the published Custom GPT configuration.

## Capture points

- Bridge repo: `Optical-Underground/ougpt-github-write-bridge`
- Bridge `main` commit at capture: `173172c9ccd82b7f1796284a2d10e4009b2ee0c0`
- OU-State repo: `Optical-Underground/OU-State`
- OU-State `main` commit at capture: `7d740dd0c27a0f2db12710b55c3993385de35c02`
- Bridge OpenAPI version: `2.0.0`
- Current bridge auth mode reported by capabilities: `pat`
- Guarded execution explicit allowlist: required

## Current OU-State posture

At capture time:

- state version: `2`
- primary workstream: `pos-for-optical`
- active fronts:
  - `pos-for-optical`
  - `seg-ht-pd-measurement-app`
- parked work:
  - `onhand-sold-by-vendor`
  - `ougpt-github-write-bridge`
- signature enforcement: enabled
- external GPT writes: blocked
- state warnings: none
- state conflicts: none

Parallel-front rule:

- `current_work.md` is an index when multiple fronts are active.
- front-specific files under `current_work/` are authoritative for each active front.
- `current_work/_coordination.md` carries cross-front rules and integration boundaries.
- work on one front must not erase state for another front.

## Current bridge capabilities

The bridge currently exposes these source-backed operations:

1. health check
2. deployed version read
3. capability/allowlist read
4. OU-State boot
5. OU-State validation without mutation
6. production status verification
7. repository snapshot
8. repository text-file read
9. branch + edits + pull-request creation
10. guarded merge preparation
11. guarded merge execution
12. guarded deployment preparation
13. guarded deployment execution

Current allowed repositories at capture:

- `Optical-Underground/ougpt-github-write-bridge`
- `Optical-Underground/OU-State`
- `Optical-Underground/onhand-sold-by-vendor`
- `Optical-Underground/pos-for-optical`
- `Optical-Underground/seg-ht-pd-measurement-app`

Production-status/deployment configuration currently covers the bridge and POS repos.

## Behavior the plugin must preserve

### Startup / continuity

For Optical Underground work, OUgpt must rehydrate from live OU-State before relying on conversational continuity.

Effective precedence remains:

1. explicit current-chat user instruction
2. current front-specific work file / coordination state
3. newest relevant dated recap
4. `ou_state.json`
5. older recaps/history

A fresh conversation must be able to reconstruct active priority, repo, latest recap, parked work, and immediate next step without depending on an old chat transcript.

### Operating modes

OUgpt retains three operational modes:

- Build Mode — safe iteration and PR-ready work
- Incident Mode — shortest path to diagnosis/restoration; rollback over experimentation
- Deploy Mode — approved change verification, environment validation, rollout safety, rollback readiness

If work crosses modes, incident recovery takes priority before returning to build work.

### Write discipline

The following are invariants:

- never push directly to `main`;
- all repo mutations use the GitHub Write Bridge;
- create reviewable branch + PR changes;
- validate owner/repo, branch, and environment;
- OU-State writes require exact-base validation;
- secrets are never invented or stored in OU-State;
- destructive actions require clear warning and a rollback/recovery path.

### Guarded merge

The bridge's current merge contract is authoritative:

- preparation is read-only;
- expected reviewed head commit is required;
- preparation captures the current base commit;
- authorization is signed, short-lived, and operation-scoped;
- execution revalidates head, base, checks, reviews, and mergeability;
- stale head/base requires a new preparation;
- token replay must fail;
- the bridge does not force-merge or bypass branch protection.

### Guarded deployment

The bridge's current deployment contract is authoritative:

- preparation verifies the exact merged commit;
- production target and Render deploy hook are server-controlled;
- preparation captures the exact currently-live commit;
- authorization binds intended and previous production commits;
- execution rechecks merge/live state;
- changed production state causes rejection;
- deploy `ref` is fixed to the exact merge commit;
- secret hook URLs are never returned to the model.

### Project-management behavior

OUgpt should continue to:

- choose the most relevant active front from OU-State plus the user's current instruction;
- treat non-current projects as parked rather than deleted;
- preserve parallel workstreams;
- ask only for the smallest missing decision/credential;
- prefer reversible actions;
- provide production-usable code/config/PR contents;
- use PowerShell first for local setup/automation unless another shell is clearly better;
- prepare a structured OU-State recap for significant sessions;
- avoid claiming continuity that was not actually rehydrated from OU-State.

### Shopify posture

OUgpt continues to prefer current supported Shopify patterns and current API behavior, and to avoid architectures that fight platform constraints.

## Existing source-level regression protection

The bridge repository already contains automated tests covering:

- action authorization
- guarded execution
- OU-State write preflight
- production status
- state boot
- state validation

These tests should remain green during MCP work. MCP should adapt to the same internal logic rather than duplicate those implementations.

## Items intentionally not copied here

This baseline does **not** reproduce hidden/internal Custom GPT instruction text. For a byte-for-byte archive of the published GPT configuration, the owner must export or provide the published GPT Builder-visible instructions and any Builder-only settings/files directly.

The exact published-config capture should include:

- published instructions
- conversation starters
- Builder-visible knowledge/reference files
- current Action schema/configuration
- any connected apps
- current published version/date

The Action schema itself is already source-controlled as `openapi.yaml` and is therefore captured by Git.

## Freeze rule for the transition window

Until plugin parity is proven:

- business-project development continues normally;
- bug fixes to the bridge remain allowed;
- avoid changing established bridge semantics unless required for correctness/security;
- avoid building new major capabilities only inside the Custom GPT container;
- MCP work should be additive and reuse the same internal business logic;
- do not remove the existing Action/OpenAPI path while it is still the rollback path.

## Greenlight statement

As of this capture, the persistent-state model, PR-only write discipline, guarded merge/deploy design, repo allowlist, and source-controlled Action contract are suitable foundations for an additive Custom GPT -> plugin transition. The remaining transition work is primarily packaging, authenticated MCP exposure, and parity testing rather than a redesign of OUgpt's core operating model.
