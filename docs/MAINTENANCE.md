# Maintenance policy

## Supported versions

- Pi 1.6.x; development packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) are pinned together to 1.6.0.
- Node.js 22.19.0 and 24 are checked in CI. Node declarations track the 24.x line.
- ACP SDK 1.8.0 / stable protocol 1 (not experimental ACP v2). Both stable configuration selectors and legacy Antigravity model/mode APIs remain supported.
- Host-provided Pi packages remain wildcard peers and are not bundled, following Pi's package contract.

## Dependency updates

Dependabot runs weekly for npm and GitHub Actions. Pi updates are grouped to avoid mismatched `pi-ai` / `pi-coding-agent` / `pi-tui` versions. Compatible minor/patch updates are grouped; major updates require individual review.

Before releasing or merging major changes, verify:

- `npm run check` (`tsc --noEmit` and `vitest run`)
- `npm run pack:check` and `npm run test:packed`
- `npm audit --audit-level=moderate`
- Real Pi regression smoke test per [`AGENTS.md`](../AGENTS.md)

TypeScript 7.0.2 is supported. Multiprocess session-store tests bundle the implementation with explicitly declared `esbuild`.

## Profiles

`PI_CODING_AGENT_DIR` selects provider configuration (`config.json`), saved ACP bindings (`sessions.json`), diagnostic logs (`logs/`), and the private patched `agy` binary cache (`runtime/`). Initial configuration migration copies `config.json` from the default Pi agent directory if present, without overwriting existing custom configs or copying saved sessions. Antigravity's own OAuth credentials and `$GEMINI_HOME/antigravity-cli` remain shared across Pi profiles.

## GitHub Actions & release checklist

Both `.github/workflows/ci.yml` and `.github/workflows/publish.yml` are manually triggered (`workflow_dispatch`) to avoid unwanted automatic Actions runs on this fork.

1. Run `npm run check`, `npm run pack:check`, `npm run test:packed`, `npm audit --audit-level=moderate`, and the real Pi regression test.
2. Bump `package.json` and `package-lock.json` together and update release notes if needed.
3. Dispatch `ci.yml` on the target commit/branch if running remote Node 22.19.0 + 24 checks.
4. Create an annotated `v<version>` tag on `main`, push it, and dispatch `publish.yml` (which uses npm trusted publishing/OIDC for `chunyoupeng`).
5. Verify the published npm version and GitHub release. Live authenticated tests (`test:real-acp`, `test:live`, `test:qualify`) are opt-in and never run in CI.
