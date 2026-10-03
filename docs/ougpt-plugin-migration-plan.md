# OUgpt Custom GPT → Plugin Migration Plan

Date: 2026-09-19
Status: Proposed / planning only

## Objective

Move OUgpt from its Custom GPT container to an installable plugin without losing its operating behavior, OU-State continuity, GitHub write controls, guarded merge/deploy workflow, or project-management conventions.

The migration must not depend on ChatGPT conversation history for continuity. `Optical-Underground/OU-State` remains the authoritative persistent state source.

## External deadline and migration facts

OpenAI has announced that Custom GPTs are scheduled to retire on 2026-12-11. Migration availability varies by account/workspace. The migration workflow uses the latest published GPT version; drafts do not transfer. After migration, the original GPT remains usable until retirement but becomes read-only.

Planned migration behavior:

- GPT instructions become a plugin skill.
- GPT knowledge files become plugin reference files.
- Connected apps can be included as plugin apps.
- GPT custom actions do **not** transfer automatically.
- Existing GPT conversations do **not** transfer.
- The GPT-selected model does **not** transfer.

Official references:

- https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq
- https://help.openai.com/en/articles/20001256/
- https://developers.openai.com/plugins/concepts/skills
- https://developers.openai.com/plugins/build/plugins

## Architecture decision

Do not replace the current bridge backend.

Add the plugin layer and MCP transport around the existing bridge service so the current HTTP/GPT Action contract can continue operating during the migration window.

```text
ChatGPT / Codex
    |
    v
OUgpt plugin
    |
    +-- ougpt-core skill
    |
    +-- MCP connection
            |
            v
OUGPT GitHub Write Bridge
            |
            +-- OU-State
            +-- allowed GitHub repositories
            +-- guarded PR / merge / deployment execution
            +-- server-stored Render deployment hooks
```

Initial plugin package should live in this repository under a dedicated `plugin/` directory. This keeps the skill, MCP connection metadata, and server implementation versioned together and avoids a second repository during the highest-risk part of the transition.

Proposed layout:

```text
plugin/
  plugin.json
  skills/
    ougpt-core/
      SKILL.md
  mcp.json                 # or OpenAI registered-server mapping, as required
  assets/                  # optional later
src/
  ...existing bridge code...
  mcp/                     # new MCP transport/tool adapters
```

No UI is required for migration v1.

## Preserve first, refactor later

The first plugin release should preserve the current GPT instructions as one broad `ougpt-core` skill. Do not split the behavior into many skills until parity is proven.

After parity, the skill can be decomposed if useful into recognizable workflows such as Build Mode, Incident Mode, Deploy Mode, and OU-State maintenance.

## Feature-parity inventory

| Current OUgpt capability | Plugin target | Migration risk |
| --- | --- | --- |
| Pragmatic OUgpt operating style | `ougpt-core` skill | Low |
| Startup OU-State rehydration | Skill requires `stateBoot` as first step for OU work | Medium |
| `current_work` / recap precedence | Skill + existing `stateBoot` result | Low |
| GitHub repo read access | MCP tools wrapping existing bridge functions | Medium |
| PR-only write path | MCP tool + existing server enforcement | Medium |
| OU-State validation before write | MCP tool + existing validation code | Low |
| Guarded merge prepare/execute | MCP tools wrapping current guarded execution | High |
| Guarded deploy prepare/execute | MCP tools wrapping current guarded execution | High |
| Production status verification | MCP tool wrapping current production status | Medium |
| Allowed-repository enforcement | Existing server-side allowlist | Low |
| Secrets remain server-side | Existing deployment configuration; never plugin resources | Low |
| Build / Incident / Deploy modes | Skill instructions | Low |
| Shopify-focused operating rules | Skill instructions | Low |
| Session recap behavior | Skill + OU-State PR workflow | Medium |
| Reset phrase behavior | Skill instructions | Low |
| Reference/knowledge files | Plugin reference files | Low |
| Conversation continuity | OU-State, not conversation migration | Low |
| GPT custom action | Replace with MCP connection | **Critical** |
| GPT model choice | Host/user model; no parity assumption | Medium |
| File/image/web/artifact capabilities | Host capabilities where available; not owned by plugin | Medium |

## Important behavioral difference

Plugin skills may be selected automatically when their description matches a task, but automatic selection is not guaranteed for every request. Explicitly invoking `@OUgpt` is the deterministic entry path when the user wants OUgpt behavior.

The core skill description therefore needs broad but precise trigger language covering Optical Underground repository work, OU-State continuity, deployments, incidents, Shopify development, and session recaps.

## MCP transition strategy

### Keep the current Action API alive

Do not remove or rewrite `openapi.yaml` during the first migration phases. The Custom GPT must continue functioning while the plugin is tested.

### Add an MCP facade, not duplicate business logic

The MCP server should expose tools that call the same internal functions already used by the HTTP endpoints. Do not implement a second copy of state validation, merge authorization, deployment authorization, or GitHub mutation logic.

Expected MCP tools map closely to existing bridge capabilities:

- `state_boot`
- `state_validate`
- `production_status`
- `repos_snapshot`
- `read_file`
- `create_pull_request`
- `merge_prepare`
- `merge_execute`
- `deployment_prepare`
- `deployment_execute`

### Authentication

Because this server exposes private repository data and write operations, the production MCP connection must authenticate the user and enforce authorization server-side on every request.

OpenAI's current plugin/MCP guidance calls for MCP-compatible OAuth 2.1 for authenticated servers. The existing `x-bridge-secret` can remain for the legacy GPT Action during the overlap period, but it should not become the long-term distributed plugin authentication mechanism.

Authentication work is a separate release gate from tool parity.

## Migration phases

### Phase 0 — Freeze and capture

Before using the built-in migration control:

- publish the final Custom GPT version intended for migration;
- archive the exact GPT instructions;
- inventory every GPT knowledge/reference file;
- inventory every connected app and custom action;
- record representative prompts and expected behavior;
- record current bridge/OpenAPI functionality;
- confirm the current GPT still works before any migration.

Do not migrate while important changes are only present as unpublished drafts.

### Phase 1 — Plugin shell

Create the plugin package with:

- `plugin.json`;
- one `ougpt-core` skill preserving current behavior;
- reference files that are genuinely static knowledge;
- no production cutover.

OU-State and repo state must continue to be retrieved live rather than copied into plugin reference files.

### Phase 2 — MCP bridge adapter

Add a remote MCP endpoint to the existing bridge service.

Requirements:

- reuse current internal authorization and GitHub logic;
- preserve the repo allowlist;
- preserve OU-State validation;
- preserve signed prepare/execute semantics;
- preserve current Render deployment controls;
- keep the legacy GPT Action endpoints operational;
- add authenticated MCP request handling.

### Phase 3 — Parity tests

Test a private plugin against a regression suite covering at least:

1. new-session OU-State rehydration;
2. active-front precedence;
3. parked-work handling;
4. repository read and snapshot operations;
5. safe PR creation;
6. invalid OU-State write rejection;
7. merge prepare with stale-head rejection;
8. guarded merge execution;
9. deployment prepare with live-commit capture;
10. stale-deployment rejection;
11. session recap preparation;
12. reset phrase behavior;
13. incident-mode recovery guidance;
14. Build Mode workflow;
15. Shopify-specific guidance;
16. missing credential handling;
17. attempts to bypass `main` protection;
18. representative file/artifact workflows on supported ChatGPT surfaces.

Run at least one harder multi-step case in addition to familiar prompts.

### Phase 4 — Dual-run canary

Run the Custom GPT and private plugin in parallel.

For each representative task, compare:

- startup state selected;
- tools called;
- write target;
- confirmation gates;
- output completeness;
- state recap behavior;
- error/recovery behavior.

Do not switch primary use until all critical and high-risk rows in the parity inventory pass.

### Phase 5 — Cutover

When the plugin passes parity:

- make OUgpt plugin the normal entry point;
- keep the Custom GPT available as fallback until retirement;
- update OU-State to record the plugin as the active OUgpt interface;
- document the new deterministic startup convention (`@OUgpt` where explicit invocation is required);
- verify the intended account/workspace can install and use the replacement.

### Phase 6 — Retirement cleanup

Only after plugin stability is proven:

- remove dependency on the legacy GPT Action contract;
- retire `openapi.yaml` only when it is no longer needed;
- remove the legacy bridge shared-secret path if nothing else uses it;
- retain rollback-capable bridge releases;
- update OU-State and repository docs to describe the plugin architecture.

## Parity gates

Cutover is blocked until all of the following are true:

- [ ] `stateBoot` works from the plugin in a new conversation.
- [ ] OU-State remains authoritative over stale reference material.
- [ ] No direct push to `main` is possible through the plugin.
- [ ] OU-State mutations require exact-base validation.
- [ ] Merge and deployment execute operations preserve prepare/execute anti-staleness checks.
- [ ] Production deploy targets and hooks remain server-controlled.
- [ ] Secrets do not appear in plugin resources, tool results, logs returned to the model, or OU-State.
- [ ] Private repo reads require valid authorization.
- [ ] Representative Build, Incident, and Deploy workflows match current behavior.
- [ ] Session recap workflow is usable.
- [ ] Plugin behavior has been tested in a fresh conversation, not only in a continuation chat.
- [ ] An intended user/account can install and invoke the plugin.

## Rollback strategy

Before 2026-12-11, the Custom GPT is the functional rollback path as long as it remains available under OpenAI's retirement timeline.

The MCP work must therefore be additive until cutover: do not remove the Action API while the GPT is still serving as fallback.

For backend regressions, retain the existing bridge deployment rollback behavior and exact-commit production verification.

After Custom GPT retirement, rollback means:

1. revert the plugin package to the last known-good version;
2. roll the bridge/MCP deployment back to the last known-good commit;
3. verify `stateBoot`, repository reads, and guarded execution before resuming writes.

## Current open decisions

These do not block Phase 0 or the plugin shell:

1. Which account/workspace will own the production plugin and whether the built-in `Migrate to plugin` control is already available there.
2. Private-only, workspace-shared, or eventual public distribution.
3. OAuth provider/authorization-server implementation for the MCP connection.
4. Whether Codex support is a day-one requirement or a follow-on gate.

## Immediate next implementation step

Create the plugin shell under `plugin/` on a review branch while leaving runtime behavior unchanged. In parallel, capture the exact latest published GPT instructions/reference inventory so the first `ougpt-core` skill can be compared byte-for-byte/section-for-section before we optimize it.
