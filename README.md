# OUGPT GitHub Write Bridge

HTTP bridge for approved GitHub repository reads, validated state writes, pull requests,
production verification, and guarded high-risk execution.

The source-controlled GPT Action contract is [`openapi.yaml`](openapi.yaml). Keep it synchronized
with GPT Builder so connector capabilities do not drift from the deployed bridge.

## Required environment variables

- `GITHUB_TOKEN`: fine-grained PAT with access to target repositories. Existing read/write
  features require Contents and Pull Requests permissions; guarded merges also require permission
  to merge pull requests.
- `BRIDGE_SECRET`: shared API key required in the `x-bridge-secret` header.

## Recommended environment variables

- `ALLOWED_REPOS`: comma-separated repository allowlist, such as
  `Optical-Underground/pos-for-optical,Optical-Underground/OU-State`.
- `OU_STATE_REPO`: authoritative state repository for `/state/boot` and `/state/validate`.
  Defaults to `Optical-Underground/OU-State`.
- `OU_STATE_REF`: authoritative state ref. Defaults to `main`.
- `PRODUCTION_TARGETS_JSON`: JSON object keyed by `owner/repo`. Each target may define `name`,
  HTTPS `health_url`, HTTPS `version_url`, `commit_field` (defaults to
  `render_git_commit`), and `max_pending_minutes` (defaults to 20). URLs come only from server
  configuration, so callers cannot probe arbitrary hosts.

## Guarded-execution environment variables

- `ACTION_AUTHORIZATION_SECRET`: optional HMAC signing secret for short-lived merge and deploy
  authorizations. Defaults to `BRIDGE_SECRET`. A distinct random secret is recommended.
- `ACTION_AUTHORIZATION_TTL_SECONDS`: optional authorization lifetime. Defaults to 300 seconds
  and cannot exceed 900 seconds.
- `DEPLOYMENT_HOOKS_JSON`: optional JSON object keyed by `owner/repo`. Each value is that
  service's secret Render deploy-hook URL, either as a string or as `{ "hook_url": "..." }`.
  Only HTTPS hooks on `api.render.com` with a `/deploy/` path and `key` query parameter are
  accepted. Never commit or return these URLs.

Example structure—use a real Render hook only in the deployment environment:

```json
{
  "Optical-Underground/example": {
    "hook_url": "https://api.render.com/deploy/srv-example?key=REDACTED"
  }
}
```

## State continuity

`POST /state/boot` returns a read-only, source-backed OU-State boot packet. It records the exact
source commit, preserves active fronts, reports missing mappings or unreadable files, and does not
mutate GitHub or deployment state.

`POST /state/validate` checks an exact `base_commit` and proposed OU-State edits without writing.
Completed validation returns HTTP 200 with `valid: true` or `valid: false`; malformed,
unauthorized, or internal failures use error statuses. The `/pr` write path independently enforces
the same validation before any mutation.

## Production status

`POST /production/status` accepts a server-allowed `repo` and positive integer `pr_number`. It
reports PR state, reviews, checks, head and merge commits, then compares the exact merge commit
with commit evidence from the server-configured production target. Caller-supplied probe URLs are
never accepted.

When GitHub reports a pending combined status with zero status contexts and zero check runs, the
packet reports `checks.state: "none"` rather than a false pending state.

## Guarded merge flow

1. `POST /pr/merge-prepare` with `repo`, `pr_number`, and `expected_head_commit` performs a
   read-only fresh check of the PR head, draft and mergeability state, reviews, and checks.
2. If ready, it captures the current base commit and returns a signed, operation-scoped
   authorization that expires within five minutes.
3. `POST /pr/merge-execute` accepts that authorization plus the same visible `repo`, `pr_number`,
   `expected_head_commit`, and `expected_base_commit`; consumes the token once; proves the
   displayed target matches the signed target; repeats the entire readiness check; and calls
   GitHub's normal merge operation with the exact expected head SHA. If either head or base moved,
   a new preparation and approval are required.

The bridge never force-merges, bypasses branch protection, deletes the branch, or accepts a merge
target from the execute request. All guarded execution endpoints fail closed unless the repository
is explicitly present in `ALLOWED_REPOS`, even though legacy read behavior permits an empty
allowlist.

## Guarded deployment flow

1. `POST /deployment/prepare` with `repo`, `pr_number`, and `expected_merge_commit` confirms the
   PR is merged at exactly that commit, verifies the exact commit currently live for rollback, and
   confirms that server-side production target and deploy-hook configuration exist.
2. If ready, it returns a signed, operation-scoped authorization bound to both the intended commit
   and the currently live commit. The authorization expires within five minutes.
3. `POST /deployment/execute` accepts that authorization plus the same visible `repo`, `pr_number`,
   `expected_merge_commit`, and `expected_previous_commit`; consumes the token once; proves the
   displayed target matches the signed target; repeats the merged-PR and live-commit checks; skips
   an already-deployed commit; and otherwise triggers the server-stored Render hook with `ref`
   fixed to the exact merge commit. If production changed after preparation, execution is rejected.

The GPT Action schema must mark both execute operations as consequential so ChatGPT always asks
the owner for confirmation. Prepare and status operations remain read-only.

## Pull-request creation

`POST /pr` creates or updates a branch, applies explicit file edits, and opens a pull request in an
allowed repository. OU-State requests require an exact current `base_commit` and pass validation
before GitHub mutation calls begin.
