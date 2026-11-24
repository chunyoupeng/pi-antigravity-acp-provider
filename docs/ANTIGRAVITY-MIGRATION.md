# Antigravity migration

Status date: 2026-11-23

## Current runtime: native `agy acp`

The provider now runs directly on Google's native Antigravity CLI (`agy acp`), replacing both the retired `@google/gemini-cli` bundle and the intermediate `agy_acp_server.par` signed-manifest installer:

- **Launch command:** `agy acp --process-per-session --agent pi-acp-bridge --disable-telemetry` (plus `--dangerously-skip-permissions` when requested and `--cloud_code_endpoint` pointing to the local CCPA relay).
- **Custom agent definition:** auto-provisioned at `$GEMINI_HOME/antigravity-cli/agents/pi-acp-bridge/agent.md` with `excludeDefaultComponents: true`, keeping the CCPA-required `<identity>` block and native `read_file`, `write_file`, `edit_file`, and `run_command` tools.
- **Pi MCP bridge:** core file/shell tools (`read`, `write`, `edit`, `bash`) are superseded by native `agy` tools; remaining Pi and extension tools are exposed over the authenticated loopback HTTP MCP bridge (`pi-bridge`).
- **544K auto-patch (`src/acp/agy-patch.ts`):** on macOS ARM64, inspects `utils.GetCheckpointConfig` in the official `agy` binary without modifying it. If the binary still hard-caps checkpoints at 256K, a private ad-hoc codesigned copy is written to `$PI_CODING_AGENT_DIR/antigravity-acp-provider/runtime/` with a 544K limit so Pi can compact cleanly around 512K. When `agy` updates and natively lifts the cap, the stale copy is cleaned up automatically.
- **HTTP/2 CCPA relay (`src/acp/ccpa-relay.mjs`):** the supervisor starts a loopback relay that multiplexes upstream requests over a persistent HTTP/2 session (direct or via HTTP/HTTPS/SOCKS5 proxies) with transparent HTTP/1.1 fallback, 5xx retries, and streaming heartbeats.
- **Compact native tool UI (`extensions/tool-activity.ts`):** pre-computes compact diffs at ingestion time, caches row renders, shows full uncollapsed edit diffs, strips `agy` command timestamps, and displays `Read N lines` summaries.
- **Auth & profile storage:** OAuth credentials are owned by `agy` (macOS Keychain service `gemini`, account `antigravity`), or `GEMINI_API_KEY` for API-key auth. Conversation history and transcripts live under `$GEMINI_HOME/antigravity-cli/`.

## Historical transitions

1. **Superseded: `@google/gemini-cli@0.58.0`** — retired after Google ended the individual Code Assist login path.
2. **Superseded: `agy_acp_server.par` + signed `runtime-manifest.json`** — removed in commit `363cecf` along with `src/acp/setup.ts`, `src/acp/runtime-manifest.ts`, `src/acp/update-notice.ts`, `src/acp/credential-storage.ts`, `src/acp/client-fs.ts`, `src/acp/native-read-results.ts`, and `extensions/safe-read.ts` in favor of native `agy acp`.

Older design and research documents under `docs/` remain for historical context and should not be used as current setup instructions.
