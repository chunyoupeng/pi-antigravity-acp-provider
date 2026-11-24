# Implementation status

Status as of 2026-11-23.

The provider targets native `agy acp` directly. Earlier `@google/gemini-cli` and `agy_acp_server.par` managed-runtime implementations have been superseded and removed; see [ANTIGRAVITY-MIGRATION.md](ANTIGRAVITY-MIGRATION.md).

## Implemented

- Pi provider registration (`antigravity-acp`) and package metadata for `@chunyoupeng/pi-antigravity-acp-provider`.
- Native `agy acp` launcher (`AGY_ACP_BIN`, `~/.local/bin/agy`, `PATH`) with auto-provisioned `pi-acp-bridge` custom agent (`$GEMINI_HOME/antigravity-cli/agents/pi-acp-bridge/agent.md`).
- Automatic private-copy 544K checkpoint patcher (`src/acp/agy-patch.ts`) for macOS ARM64 `agy` binaries, with `patch-state.json` caching, automatic cleanup if upstream lifts the 256K cap, and `PI_ANTIGRAVITY_PATCH_AGY=0` opt-out.
- Official ACP SDK 1.8.0 transport using stable protocol v1, bounded NDJSON framing, two-minute session-operation deadlines, cancellation, redacted errors, bounded stderr, and Chromium `Opening in existing browser session.` stdout noise filtering.
- Packaged parent-death supervisor (`src/acp/supervisor.mjs`) with TERM/KILL escalation, POSIX process-group cleanup, Windows `taskkill /T` cleanup, and embedded HTTP/2 CCPA relay (`src/acp/ccpa-relay.mjs`) with direct/HTTP/SOCKS5 proxy support and HTTP/1.1 fallback.
- Antigravity Google OAuth and Gemini API-key `/login`, automatic SSH/headless OAuth URL capture and validated loopback callback relay, macOS Keychain auth health check, setup wizard, `/antigravity-acp usage` (via `agy -p "/usage"`), `/antigravity-acp quota`, and ACP `logout`.
- Fallback model catalog, authenticated ACP model discovery, 6h catalog TTL caching, and effort-tier collapsing (`low` / `medium` / `high` / `xhigh`) mapped via `session/set_config_option` (falling back to `session/set_model`/`session/set_mode`).
- Pi-to-ACP text/image/context conversion, separate system-instruction preservation (up to 256 KiB UTF-8), transcript-based context usage accounting (`512_000` context window), idle binding hibernation (6h default), idle compaction, and bounded fresh-session reconstruction.
- Hybrid tool ownership: native `agy` tools (`read_file`, `write_file`, `edit_file`, `run_command`) replace Pi's `read`, `write`, `edit`, `bash`; all other compatible Pi/extension tools are bridged through an authenticated loopback Streamable HTTP MCP server (`pi-bridge`) with schema sanitization, original-schema validation, 46 KiB inline text cap + temp-file overflow, inline image support, and 150s long-tool handoff.
- Compact native tool activity rendering (`extensions/tool-activity.ts`) using Pi's shell/file/diff renderers with ingestion-time compact diffs, cached row renders, uncollapsed edit diffs, stripped command timestamps, and `Read N lines` summaries.
- Persistent ACP session bindings (`sessions.json`), decision logging (`logs/bindings.jsonl`), redacted server stderr logging (`logs/acp-server.log`), `session/list` attachment (`/antigravity-acp sessions`), `/antigravity-acp plan <task>`, and 7-day unreferenced history cleanup.
- Persisted Antigravity permission modes (`default`, `auto_edit`, `yolo`, defaulting to `yolo`) with single-use, fail-closed Pi permission continuation in prompting modes.
- Unit, fake-subprocess, patcher, HTTP/2 relay, cancellation, supervisor, packed-install, real-CLI initialize, live authenticated prompt, and live qualification test suites.

## Remaining qualification areas

- Cross-platform live qualification on Linux and Windows (native `agy` binary behavior, Windows `taskkill /T` cleanup, non-macOS OAuth health checks).
- Live re-qualification whenever upstream `agy` updates its checkpoint threshold, transcript schema, or ACP model/config options.
