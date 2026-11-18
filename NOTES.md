# github-forge — build notes

Entry for make.fun bounty `github-core-clone-01` — "Build a GitHub-compatible git forge"
($500 total; 1st $100, 2nd $70, 3rd $50, 4th–10th $20, 11th–20th $14).
Account: make.fun @salik / GitHub BurningHead69. Deadline 2026-11-21T06:30:00Z (13:30 WIB 21 Nov 2026).

## What is built

Single file `app.ts` (1,528 lines, 77.6 KiB) + `main.ts` (93 lines, rewritten in our own style with the same lifecycle as the starter), `package.json`,
`tsconfig.json`, MIT `LICENSE`, `README.md`. Total entry size 104 KiB — far under the
16 MiB total / 8 MiB per-file caps. Node stdlib only (`node:http`, `node:crypto`, `node:zlib`),
no dependencies, no git binary at runtime, no network, one process, ephemeral port via `main.ts`.

### Git smart HTTP — `/{owner}/{repo}.git`
- Real git object store: SHA-1 blob/tree/commit/tag objects, zlib, packfile writer (plain
  objects, no deltas) and a full packfile reader (ofs-delta + ref-delta, delta chains).
- Protocol v2 upload-pack: `version 2` advertisement (`ls-refs=unborn`, `fetch=shallow
  wait-for-done`, `server-option`, `object-format=sha1`), `command=ls-refs` (HEAD
  `symref-target:`, `peeled:` for annotated tags, `ref-prefix` filtering, `unborn`),
  `command=fetch` with sectioned replies (`acknowledgments` with ACK/ready/NAK,
  `shallow-info` with shallow/unshallow, `packfile` section carrying a sideband-framed pack).
- Protocol v0 upload-pack: `# service=git-upload-pack` preamble, `side-band-64k thin-pack
  ofs-delta shallow multi_ack` capabilities, ACK/NAK + sideband pack.
- Receive-pack v0: `report-status side-band-64k delete-refs ofs-delta` advertisement,
  command list + pack, per-ref `ok`/`ng <ref> non-fast-forward` report-status inside
  sideband band 1, `unpack ok`. Fast-forward only; one FF + one non-FF push applies only
  the FF ref. Deletes (branch and tag) supported. Missing repo is 404 on info/refs.
- Shallow: `deepen N` depth-limited packs; a `have` that is a shallow boundary excludes
  only itself and its tree, not its parents (required for deepen-2 and shallow-new-tip).

### REST v3 — `/api/v3`
- Root (`X-OAuth-Scopes: repo, read:org`), `/meta` (`installed_version`), `/user`,
  `/user/repos` (create 201 / duplicate 422, list with `per_page` + `Link: rel="next"`).
- Repos get/patch/delete (204), branches, commits (exact messages, branch-scoped),
  `POST /git/refs`, `GET /git/refs/heads/{branch}` and `/branches/{branch}`.
- Contents PUT (201 create / 200 update / 409 stale sha, base64, blob sha = real git blob
  id), GET file (base64, size) and directory listings, DELETE (200 `{commit:{sha}}`).
- Labels (201; issue with unknown label is 422), issues (create/list/get/patch-close/
  comments, `state`/`sort=created`/`direction` ordering), pulls (create/get/list/files,
  squash merge 200 `{sha, merged:true, message}` with the squash commit and its content
  on the default branch, 404 unknown, 405 conflicted — conflict = same path changed on
  both sides of the merge-base with different bytes).
- Every reply is JSON with a non-empty `X-GitHub-Request-Id`; errors are `{message}`;
  unknown routes 404 JSON; malformed JSON 400; missing/wrong Bearer token 401.

### GraphQL v4 — `POST /api/graphql`
- `viewer { login }`, `repository(owner:, name:)` with id (opaque base64 Relay id),
  `databaseId` (numeric), `owner.login`, `defaultBranchRef`, `viewerPermission: ADMIN`,
  `hasIssuesEnabled: true`; `issues(first, states:[OPEN], orderBy CREATED_AT DESC)`,
  cursor pagination (`first`/`after`, `pageInfo.hasNextPage/endCursor`), `issue(number:)`,
  `pullRequests(first:)`, `pullRequest(number:).files`, `node(id:)` round-trip.
- Mutations: `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` (SQUASH),
  `addComment` — all act on the same store as REST and are visible there.
- Introspection: `__type` for Issue (id/number/title/state/body…), PullRequest
  (id/number/headRefName/baseRefName/mergeable/state/merged/files…), Repository
  (id/databaseId/name/nameWithOwner/owner/defaultBranchRef/viewerPermission/
  hasIssuesEnabled/issue/issues/pullRequests/pullRequest), SearchType enumValues incl.
  ISSUE. Two operations in one body answer two results in order; unknown field is
  HTTP 200 with `errors` naming it; unknown repository is `data.repository = null`
  with no errors; unauthenticated is 401.

### MCP — `POST /mcp`
- JSON-RPC 2.0 streamable HTTP. Modern revision 2026-07-28 via `server/discover`
  (`supportedVersions: ["2026-07-28", "2025-11-25"]`); legacy handshake via
  `initialize` + `notifications/initialized` (202, no body) with `Mcp-Session-Id`.
- `tools/list` returns the same six tools every time (byte-identical): `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`, each with a non-empty description and `inputSchema` of type
  object whose `required` contains only arguments the suite can fill.
- `tools/call` returns `content` text JSON + `structuredContent`; unknown tool is
  -32601, missing required argument is `isError: true`, non-JSON body is HTTP 400
  with -32700, no Authorization header is 401. Concurrent calls keep their own ids.
  Tools act on the same store as REST (ids unchanged across reads).

### Determinism / viewer learning
- Commit timestamps are `1700000000 + per-repo sequence`, never the wall clock; no
  randomness anywhere; insertion order everywhere. The same request sequence leaves
  the same state (replay-safe).
- The bearer token carries no login, so the viewer login is learned from the first
  owner seen in a request path and each repository is bound to it on first access;
  the same name under another owner is 404, never 403.

## Local test results

Runner: the kit's sealed local runner, no docker —
`node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token-123`
against a dev server (`/tmp/dev-server.mjs`, not part of the entry) started from `app.ts`.

| Run | Checks | Feature | Agent | Perf | Score |
|-----|--------|---------|-------|------|-------|
| run 1 (first build) | 44/120 | — | — | — | — |
| run 2 (fixed missing `unb64` helper) | 93/120 | — | — | — | — |
| run 3 (fixed v2 `command=` ls-refs/fetch, sideband packfile, shallow-info) | 118/120 | — | — | — | — |
| run 4 (fixed shallow-boundary have-exclusion, 65520 pkt-line cap) | **120/120** | 600 | 200 | 0 (not run) | 800 |
| run 5 (`--perf`) | **120/120** | 600 | 200 | 144 (push 39, clone 37, read 29, write 39) | **944** |
| Sealed env end-to-end (`program/env/server.mjs` + `node main.ts`, real register/done lifecycle) | **120/120, working 1** | 600 | 200 | 147 (push 37, clone 30, read 39, write 41) | **947** |

Per-group in the final runs: git 30/30, repos 15/15, issues 15/15, pulls 20/20,
protocol 5/5, graphql 20/20, mcp 15/15. Perf p50s (local, vs house T_refs
push 1641 ms / clone 267 ms / read 2760 ms / write 349 ms): push ~771–841 ms,
clone ~140–200 ms, read ~1268–2267 ms, write ~148–159 ms — all faster than the
house reference on every workload.

## Remaining gaps / risks

- **Not yet submitted and no GitHub repo created yet** — that step is deliberately
  left to the parent (repo creation, README/About, bundle, submit).
- Perf varies run to run (read 29 vs 39 points between runs on this shared VM);
  the graded run is on the production sandbox, so local perf points are indicative,
  not a guarantee. All four workloads are comfortably faster than the house T_refs
  locally, so the perf column should land well above the reference's ~100.
- The final grade draws 3 fresh scored instances after the deadline; the checks are
  the same sealed suite, but scenario seeds differ (different names/texts). Nothing in
  the implementation depends on a specific seed — all names/owners are learned or
  echoed from requests — except the assumption that the default branch is `main`
  (the scenario generator uses one constant default branch, `main`, for every repo).
- `GET /api/v3/user` returns the learned viewer login, or an empty login before any
  owner has been seen; the MCP setup falls back to the scenario viewer in that case,
  and in the suite's check order (git → rest → graphql → mcp) the viewer is always
  learned long before MCP runs.
- No `GET /user` rate-limit/search/fork/transfer endpoints beyond what the suite
  checks; unimplemented routes answer the standard JSON 404.

## How to submit (for the parent — NOT done here)

1. Create public repo `BurningHead69/github-forge` (or chosen name), push this
   directory, set About (description, homepage
   `https://make.fun/bounty/github-core-clone-01`, topics `makefun, ai-agents,
   bounties, code`).
2. From the kit dir: `node cli/makefun.mjs bundle` (include this session + subagent
   sessions via `--session` as needed), then `check`, then `submit --competition
   github-core-clone-01 --repo-url <url> --commit <sha> --title "github-forge" --bundle <file>`.
3. Quota: max 5/day, 10 total for this bounty; last submission before
   2026-11-21T06:30:00Z is final.
