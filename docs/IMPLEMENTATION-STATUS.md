# Implementation status

Status as of 2026-09-06 for package version 0.1.8.

The bundled Gemini CLI implementation was superseded after its individual Code Assist authentication path was retired. See [ANTIGRAVITY-MIGRATION.md](ANTIGRAVITY-MIGRATION.md).

## Implemented

- Pi provider registration and marketplace package metadata.
- Google Antigravity ACP server resolution plus self-service installation based on `@estebanforge/pi-antigravity-bridge` 1.4.1.
- Official ACP SDK 0.19.1 transport using stable protocol v1, including upstream fixes that close failed transports, reject pending requests, and observe internal rejection paths.
- Strict bounded NDJSON framing, two-minute session-operation deadlines, cancellation, redacted errors, and bounded stderr. Process shutdown leaves stdin ownership with the Web Streams adapter to prevent `ERR_STREAM_WRITE_AFTER_END`. The exact Chromium `Opening in existing browser session.` compatibility line is filtered and counted without weakening rejection of other non-protocol stdout; genuine framing failures reject active operations without escaping through the SDK as uncaught exceptions.
- Packaged parent-death supervisor with TERM/KILL escalation and POSIX process-group cleanup.
- Antigravity Google/API-key `/login`, automatic SSH/headless OAuth URL capture and validated loopback-callback relay, structural local auth health (token file or macOS Keychain entry presence), network validation through setup/qualification, ACP `logout` with local fallback, and account-switch reset flow.
- Antigravity fallback models, authenticated ACP model discovery, catalog refresh, and model/mode switching through `session/set_config_option` (falling back to `session/set_model`/`session/set_mode`). Server-side `config_option_update` replacements set `responseModel`; Pi's selection is re-applied on the next turn.
- Pi-to-ACP text/image/context conversion with bounded fresh-session reconstruction.
- ACP text, thought, plan, and native-tool activity mapping to balanced Pi events.
- ACP usage/quota metadata mapping to Pi usage and `/antigravity-acp quota` process metrics. Antigravity 1.3 sends no prompt token counts, so `usage_update` context fill becomes Pi usage.
- Pi tool ownership (default): `_meta.agy.disabledTools` on `session/new`/`resume`/`load` disables Antigravity's file and shell built-ins so the model uses bridged Pi tools; Antigravity permission prompts for bridged calls are approved once, and their duplicate activity rows are hidden. `tools native` instead advertises ACP `fs` and serves `fs/read_text_file`/`fs/write_text_file` with realpath confinement.
- `session/list` with attach-to-Pi-session, and an `/antigravity-acp plan` shortcut for Antigravity's built-in `/plan`.
- Persistent ACP bindings keyed by Pi session ID, serialized turns, on-disk restoration through `session/resume`/`session/load`, reconstruction fallback, rewind detection, and cleanup.
- Persisted Antigravity permission modes (`default`, `auto_edit`, and `yolo`), with `yolo` as the requested default. Prompting modes retain single-use, fail-closed ACP permission continuation through a real Pi tool round trip.
- Authenticated loopback MCP exposure of active Pi tools with `pi_` namespacing, schema sanitization, original-schema revalidation, bounded catalogs/bodies, and genuine Pi tool-result continuation.
- Setup wizard and automatic/notify/manual runtime updates backed by a remotely refreshable Ed25519-signed catalog. Installation enforces exact Google URLs, archive hashes and decoded sizes, exact executable/helper names and sizes, strict two-file extraction, pre-activation ACP identity/version checks, immutable hash-addressed releases, a cross-process update lock, rollback retention, managed server/helper executable-permission repair, musl detection, macOS quarantine cleanup, and Windows `taskkill /T` process-tree cleanup.
- Unit, fake-subprocess, cancellation, supervisor, packed-install, real-server initialize, live authenticated prompt, and live cancellation/session-restore/MCP/permission/model qualification tests.
- Primary package/provider/command branding renamed to `pi-antigravity-acp-provider` / `antigravity-acp`; `/gemini-acp` remains a deprecated command alias.

## Live validation

Against `agy_acp_server` 1.3.0 on macOS ARM64 (2026-10-06): the tool filter removed the native built-ins and the model completed a file task through Pi's `read`; `tools native` served file reads through `fs/read_text_file`; `usage_update` produced non-zero Pi usage; `session/list` returned workspace sessions. `session/fork`/`session/close` return `{}` without advertising capabilities, and `additionalDirectories` is accepted but not enforced, so neither is used.

On Linux with authenticated `agy_acp_server_1.1.1`, ACP protocol 1 initialization, authenticated model discovery, session creation, model control, streaming, cancellation recovery, cross-process session resume, native permission requests, authenticated loopback MCP execution, and exact-response prompts completed successfully.

## Remaining before stable 1.0

- Run and record fresh Antigravity OAuth and API-key login tests on clean accounts.
- Run packed installation matrices on Debian/glibc, macOS ARM64, and Windows x64/ARM64, including the large ACP binary download; verify Alpine/musl rejection and the absence of an Intel macOS artifact.
- Run Windows-native process-tree lifecycle tests for the implemented `taskkill /T` cleanup.
- Expand chaos tests for parallel MCP calls, network disconnects, permission timeout races, and malformed ACP streams.
- Confirm transcript prefix fingerprints and unseen external-delta replay against real Pi branch/fork/compaction behavior.
- Complete public beta publishing and Pi marketplace installation verification.

Version 0.1.8 remains a beta implementation.
