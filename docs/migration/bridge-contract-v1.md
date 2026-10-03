# OUgpt Bridge Contract v1 — Action to MCP Freeze

Captured: 2026-09-28
Purpose: Define the behavior that the future plugin/MCP layer must preserve while the legacy Custom GPT Action remains available.

## Principle

MCP is an adapter around the existing bridge core, not a second implementation of authorization, OU-State validation, merge safety, deployment safety, or GitHub mutation logic.

During the overlap window, both interfaces should call the same internal bridge logic:

```text
Legacy Custom GPT Action ----\
                              > existing bridge core -> GitHub / OU-State / Render
OUgpt Plugin MCP ------------/
```

## Operation mapping

| Legacy Action operation | HTTP path | Future MCP tool | Consequential | Required semantic parity |
| --- | --- | --- | --- | --- |
| `getHealth` | `GET /health` | `health` | No | service health only |
| `getVersion` | `GET /version` | `version` | No | deployed version/commit evidence |
| `getCapabilities` | `GET /capabilities` | `capabilities` | No | allowlist/capability facts |
| `stateBoot` | `POST /state/boot` | `state_boot` | No | source-backed OU-State packet; no writes |
| `stateValidate` | `POST /state/validate` | `state_validate` | No | exact-base validation; no writes |
| `productionStatus` | `POST /production/status` | `production_status` | No | exact PR/production comparison |
| `reposSnapshot` | `POST /repos/snapshot` | `repos_snapshot` | No | approved-repo tree/read packet |
| `readFile` | `POST /repos/read-file` | `read_file` | No | approved-repo text read |
| `createPullRequest` | `POST /pr` | `create_pull_request` | Reviewable mutation | branch + explicit edits + PR; no merge/deploy |
| `mergePrepare` | `POST /pr/merge-prepare` | `merge_prepare` | No | fresh readiness + signed short-lived auth |
| `mergeExecute` | `POST /pr/merge-execute` | `merge_execute` | **Yes** | exact signed target; revalidation; one-time token |
| `deploymentPrepare` | `POST /deployment/prepare` | `deployment_prepare` | No | exact merged commit + live commit + server target |
| `deploymentExecute` | `POST /deployment/execute` | `deployment_execute` | **Yes** | exact signed target; live-state recheck; exact ref |

Tool names may change before implementation, but semantics may not silently weaken.

## Authentication boundary

Legacy overlap path:

- GPT Action uses the current bridge API-key mechanism (`x-bridge-secret`).

Plugin target path:

- authenticated MCP must identify/authorize the caller server-side;
- private repository reads must not become anonymous;
- write/merge/deploy authorization remains enforced by the bridge, not by prompt instructions alone;
- MCP auth changes must not expose bridge secrets, GitHub tokens, Render hooks, or signing secrets to the model.

The long-term plugin auth mechanism can change independently of legacy Action auth as long as the server-side authorization guarantees remain equal or stronger.

## Exact-base OU-State rule

OU-State mutations require the exact current OU-State commit as `base_commit` and validation before any GitHub mutation begins.

Required failure cases:

- missing required base commit;
- stale base commit;
- invalid proposed state structure;
- unauthorized repository;
- any validation failure.

MCP must preserve fail-closed behavior.

## Pull-request rule

`create_pull_request` must remain the normal mutation primitive.

It may:

- create/update a working branch;
- apply explicit creates/updates/deletes;
- open a reviewable PR.

It may not:

- push directly to `main`;
- implicitly merge;
- implicitly deploy;
- bypass OU-State validation.

## Merge safety rule

Prepare and execute remain separate operations.

Prepare binds authorization to:

- repository;
- PR number;
- exact reviewed head commit;
- current base commit;
- short expiration.

Execute must:

- consume a valid one-time authorization;
- verify visible arguments match the signed target;
- re-run readiness checks;
- reject stale head/base;
- use GitHub's normal protected merge operation;
- never force-merge or bypass protection.

## Deployment safety rule

Prepare binds authorization to:

- repository;
- PR number;
- exact merged commit;
- exact currently-live commit;
- short expiration.

Execute must:

- consume a valid one-time authorization;
- verify visible arguments match the signed target;
- re-check merged PR state and live commit;
- reject if production changed after preparation;
- skip an already-live target;
- use only server-stored target/hook configuration;
- deploy only the exact approved merge commit.

## Contract-change policy during migration

A bridge change that modifies any behavior above must do all of the following before merge:

1. explain why the contract must change;
2. update this document;
3. update the acceptance suite;
4. add/update automated tests where applicable;
5. preserve or explicitly replace the rollback path.

Additive endpoints/tools that do not weaken existing guarantees are allowed.

## Retirement gate for legacy Action

Do not remove `openapi.yaml` or the legacy Action path until:

- the plugin/MCP route passes the migration acceptance suite;
- at least one intended user/account can install and invoke the plugin;
- a fresh conversation can rehydrate OU-State correctly;
- guarded PR/merge/deploy workflows pass parity;
- plugin auth is operating correctly;
- the plugin has been used successfully as primary for an agreed burn-in period.
