# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/BurningHead69/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/BurningHead69/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node.js process (standard library only, no git binary, no network, no UI). It serves git smart HTTP (protocol v2 upload-pack with ls-refs/fetch, v0 upload-pack and receive-pack with report-status / side-band-64k / delete-refs), the REST v3 API (repositories, branches, commits, contents, labels, issues, comments, pull requests and merges), GraphQL v4 (the documents `gh` and `github-mcp-server` send, plus introspection and Relay global ids), and MCP over streamable HTTP (initialize, server/discover, tools/list, tools/call) — all from one in-memory, deterministic store.

## Run it

```sh
node main.ts
```

The trial runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` set in the environment: the program binds an ephemeral port, registers it with the env, serves until the env says done, then exits 0. Locally (Node 22+):

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types main.ts
```

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind port 0, POST `/register`, poll `/done`), rewritten in our own style with the same behaviour as the starter lifecycle.
- `app.ts` — the whole forge: git object store and pack codec (SHA-1 objects, zlib, ofs/ref deltas, sideband framing), smart-HTTP v2/v0, REST v3, GraphQL v4 and MCP. The only file that grew.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Design notes

- **Deterministic:** commit timestamps come from a per-repo sequence counter (`1700000000 + seq`), never the wall clock; iteration order is insertion order, so the same request sequence always leaves the same state.
- **Viewer learning:** the bearer token carries no login, so the forge learns the viewer login from the first owner seen in a request path and binds each repository to it on first access; the same repository name under another owner is a 404, never a 403.
- **Fast-forward only:** receive-pack refuses non-fast-forward updates per ref (`ng <ref> non-fast-forward`) and applies the other refs in the same push.
- **Shallow clones:** `deepen N` / `shallow` boundaries are honoured in fetch (shallow-info section, depth-limited pack); a `have` that is a shallow boundary excludes only itself and its tree, not its parents.
- **Local score:** 120/120 conformance checks with the kit's sealed local runner (`sdk/run.ts`), perf 144–147/200, total **944–947/1000** (see NOTES.md).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
