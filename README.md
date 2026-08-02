\# OUGPT GitHub Write Bridge



Tiny HTTP service that creates/updates branches and opens GitHub PRs from a signed request.



\## Env vars (required)

\- `GITHUB\_TOKEN` = Fine-grained PAT with access to the target repos (Contents: Read/Write, Pull Requests: Read/Write)

\- `BRIDGE\_SECRET` = shared secret required in `x-bridge-secret`



\## Env vars (recommended)

\- `ALLOWED\_REPOS` = comma-separated allowlist, e.g. `Optical-Underground/pos-for-optical,Optical-Underground/onhand-sold-by-vendor`

\- `OU\_STATE\_REPO` = authoritative state repo for `/state/boot` (defaults to `Optical-Underground/OU-State`)

\- `OU\_STATE\_REF` = authoritative state ref for `/state/boot` (defaults to `main`)



\## Diagnostics (optional)

\- `DIAG\_PROBE\_ENABLED=true`

\- `PROBE\_SECRET=...`

Then call `GET /diag/probe` with header `x-probe-secret`.



\## State boot

`POST /state/boot` with header `x-bridge-secret: <secret>`

Optional payload:

```json

{

&nbsp; "front": "pos-for-optical"

}

```

The endpoint is read-only. It reads OU-State, records the exact source commit, preserves the configured active-front list, reports missing mappings or unreadable front files explicitly, summarizes current-work and coordination files, and reports newest relevant recaps without mutating GitHub or deployment state.



\## Create PR

`POST /pr` with header `x-bridge-secret: <secret>`



Example payload:

```json

{

&nbsp; "repo": "Optical-Underground/pos-for-optical",

&nbsp; "base": "main",

&nbsp; "branch": "ougpt/test-1",

&nbsp; "title": "test PR",

&nbsp; "body": "hello",

&nbsp; "draft": false,

&nbsp; "edits": \[

&nbsp;   { "path": ".ougpt/hello.txt", "action": "create", "content": "hi\\n" }

&nbsp; ]

}



