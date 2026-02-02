\# OUGPT GitHub Write Bridge



Tiny HTTP service that creates/updates branches and opens GitHub PRs from a signed request.



\## Env vars (required)

\- `GITHUB\_TOKEN` = Fine-grained PAT with access to the target repos (Contents: Read/Write, Pull Requests: Read/Write)

\- `BRIDGE\_SECRET` = shared secret required in `x-bridge-secret`



\## Env vars (recommended)

\- `ALLOWED\_REPOS` = comma-separated allowlist, e.g. `Optical-Underground/pos-for-optical,Optical-Underground/onhand-sold-by-vendor`



\## Diagnostics (optional)

\- `DIAG\_PROBE\_ENABLED=true`

\- `PROBE\_SECRET=...`

Then call `GET /diag/probe` with header `x-probe-secret`.



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



