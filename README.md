# @chunyoupeng/pi-antigravity-acp-provider

A [Pi](https://github.com/earendil-works/pi) provider for **Google Antigravity** through its official ACP server, in which Pi runs the tools.

This is a fork of [zacbemis/pi-antigravity-acp-provider](https://github.com/zacbemis/pi-antigravity-acp-provider) and keeps its runtime installer, signed runtime catalog, authentication and turn recovery. It differs from upstream in these ways:

- Antigravity's file and shell built-ins are disabled per session, so the model works through Pi's tools over the MCP bridge and Pi's permissions, hooks and tool cards apply. Upstream lets Antigravity run them natively and shows a text line per tool update.
- Native tools that remain are rendered with Pi's shell/file renderers and real diffs, and survive session restore.
- About 3k prompt tokens per turn are saved by disabling `schedule`, `ask_question` and `generate_image`, and subagent tools are disabled.
- Images from Pi tools reach the model inside the tool result, and Pi tool calls still running near Antigravity's 3-minute MCP deadline are handed back and answered in the next prompt.
- Idle Antigravity conversation history that no Pi session can resume is pruned.

The provider ID, commands and config directory are the same as upstream, so remove the upstream package before installing this one.

> **Important:** this package no longer uses `@google/gemini-cli`. The Gemini CLI individual Code Assist login path was retired and is not a supported authentication route. Antigravity/`agy` is the target runtime.

## Features

- Registers `antigravity-acp/*` models backed by Google Antigravity.
- Uses ACP protocol v1 and the official TypeScript SDK.
- Collapses Antigravity's effort-qualified IDs into one entry per model; Pi's Shift+Tab reasoning control selects low/medium/high dynamically.
- Supports Pi streaming, cancellation, usage/quota metadata, lifecycle cleanup, and persisted ACP session restoration across Pi restarts.
- Reports Antigravity's `usage_update` context fill as Pi usage, so Pi's context meter and auto-compaction work even though the server returns no token counts.
- Routes compatible Pi tools from transcript system messages through an authenticated loopback MCP bridge, using Pi's standard tool-call/result lifecycle; doctor/status names omitted tools and their reasons.
- Each session sets `_meta.antigravity.mcpMaxOutputBytes` to 1 MiB, so Pi tool results, including images up to Pi's 512 KiB / 1536px cap, reach the model inline instead of as an offloaded file path. The harness still cuts any text result over 48 KiB, so for Antigravity `pi_read` pages text at 45 KiB (2000 lines) with Pi's `Use offset=N to continue` note, and `pi_bash` keeps the last 45 KiB of output and names a file holding all of it. Text from any other Pi tool over 46 KiB keeps its head inline and is saved in full to a temp file. Other providers keep Pi's original behavior.
- By default Pi owns file and shell work: Antigravity's built-in `view_file`, `run_command`, `create_file`, `edit_file`, `list_directory`, `search_directory`, `find_file`, and `start_subagent` (which removes all subagent tools) are disabled per session (`_meta.antigravity.disabledTools`), so the model reads, runs and edits only through Pi's tools and Pi's hooks and rendering apply. Pi skill instructions route skill files through `pi_read`, because Antigravity's native skill loader may reject skill paths outside its workspace. Antigravity's permission prompt for bridged calls is approved once automatically. Web search and URL fetch stay native. `schedule`, `ask_question`, and `generate_image` are disabled in both tool modes to keep about 3k tokens out of every prompt.
- Displays Antigravity-native tools with Pi's built-in shell/file renderers, status bullets, output previews, and colored diffs. Updates for the same invocation share one live row; expanding shows output and ACP details. Display-only entries retain every raw update for JSON/RPC clients (`entry_appended`) and session restore. Native `view_file` text results are recovered read-only from the current session's Antigravity conversation database, matching the original tool ID, path, range, and timestamps. Recorded content confirms success; explicit response errors confirm failure even if the step is `DONE`. Confirmed results survive unrelated later ACP failures, without altering the raw notifications or model context. Native actions are not executed again by Pi.
- Read-result recovery requires Node's optional `node:sqlite` module and the current upstream protobuf layout. It uses `$GEMINI_HOME/antigravity-acp/conversations/<session-id>.db` (default `~/.gemini`), checks immediately on tool notifications, and retries every 300 ms while the agent is active. It also backfills saved rows on session restore. Missing/locked/corrupt databases, unknown layouts, and ambiguous matches leave ACP data unchanged; a generic `Tool execution failed` with no verified result remains an unconfirmed warning. Scans are bounded to 4096 recent completed native steps and 64 MiB, with a 16 MiB per-step limit. Recovered display output is capped at 64k characters; the full original response stays in Antigravity.
- Preserves Pi project instructions (including `AGENTS.md` and named prompt sections) separately from truncated conversation history.
- Supports persisted `default`, `auto-edit`, and `yolo` Antigravity permission modes. The requested default is `yolo`; switching to a prompting mode retains the single-use, fail-closed Pi permission broker.
- With `tools native`, keeps Antigravity's built-ins but advertises ACP `fs`, so its file reads and writes go through the provider, confined to the workspace, `GEMINI_HOME`, and the temp directory. ACP terminal is never advertised; the server does not use it.
- On the first session start of each Pi process, removes Antigravity conversations (`$GEMINI_HOME/antigravity-acp/conversations/<id>.*` and `brain/<id>/`) that no saved Pi session references and that have not changed for 7 days. Credentials, settings and non-session files are left alone.
- Provides setup, auth-health, logout/account-switching, qualification, quota, and runtime-update commands.
- Automatically checks for newer managed ACP runtimes once per day, with `automatic`, `notify`, and `manual` update modes.
- Uses an Ed25519-signed runtime catalog with exact Google artifact URLs, archive hashes and sizes, strict two-file extraction, pre-activation ACP identity/version validation, immutable releases, rollback retention, musl rejection, macOS quarantine cleanup, and Windows process-tree handling.

## New-user setup

Install from GitHub:

```bash
pi remove npm:pi-antigravity-acp-provider   # if the upstream package is installed
pi install git:github.com/chunyoupeng/pi-antigravity-acp-provider
pi
```

To run from source instead:

```bash
git clone https://github.com/chunyoupeng/pi-antigravity-acp-provider.git
cd pi-antigravity-acp-provider
npm install
pi --no-extensions -e ./extensions/index.ts
```

To replace an existing installation with a persistent local development package:

```bash
pi remove git:github.com/chunyoupeng/pi-antigravity-acp-provider
pi install "$PWD"
```

Pi loads the local directory without copying it. Restart Pi or run `/reload` after switching. Full ACP notifications are also forwarded to Pi's `provider_stream_event` hook before conversion; native tool records never enter the model transcript.

In Pi:

1. Optionally run `/antigravity-acp setup` for a runtime/auth preflight.
2. Run `/login`.
3. Choose **Sign in with an account**.
4. Choose **Google Antigravity (ACP)**.
5. If needed, wait for the official ACP server download and extraction. Progress is shown; the Linux build observed during development expands to about 1.8 GB.
6. Complete the Google login in the browser.
7. Run `/antigravity-acp setup` again to perform a network auth probe and model discovery.
8. Run `/model` and select one of the `antigravity-acp` models.
9. Press **Shift+Tab** to choose the reasoning effort. Only tiers advertised by Antigravity are exposed. A model with a single tier (for example Argon Medium during rollout) remains a reasoning model with that tier; the provider does not invent Low/High variants.
10. Send a prompt. The default permission mode is `yolo`, so Antigravity-native commands and edits can run without confirmation.

The provider first looks at `AGY_ACP_BIN`, then its verified managed `~/.local/opt/agy-acp/current/` release, `~/.local/bin/agy_acp_server.par`, and `PATH`. Set `AGY_ACP_BIN` to explicitly prefer an externally managed runtime. If absent, it installs the platform build published in the ACP registry. A global `agy` or `gemini` command is not required.

Loopback MCP traffic is exempted from proxies in the ACP child environment. Explicit `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase variants) are preserved. On macOS, when none are explicitly set, the provider probes enabled system HTTP proxy settings to avoid automatic SOCKS selection unsupported by the bundled Python runtime. Set `PI_ANTIGRAVITY_ACP_PROXY` to an absolute HTTP/HTTPS proxy URL to explicitly override child proxy settings; the provider does not log the override or change its parent environment. Existing `NO_PROXY` lists and TLS certificate overrides are retained.

Standalone Pi builds also need Node.js to run the ACP supervisor. The provider looks for `node` or `nodejs` on `PATH`; set `NODE` to the executable path if neither is available. On NixOS with Home Manager, `programs.pi-coding-agent.extraPackages = [ pkgs.nodejs ];` adds Node to Pi's `PATH`. An explicit `SSL_CERT_FILE` is preserved; otherwise the provider uses `NIX_SSL_CERT_FILE` or a readable system CA bundle when available.

### SSH and headless Google login

When Pi is running over SSH, or on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, `/login` automatically uses a manual browser relay:

1. Pi prints the Google authorization URL instead of trying to launch a browser on the server.
2. Open that URL in a browser on your local machine and finish Google sign-in.
3. Google redirects to an Antigravity loopback URL. The page may show a connection error because `127.0.0.1` refers to your local machine; copy the **complete final URL** from the browser address bar.
4. Paste that URL into Pi. The provider validates its host, port, path, and OAuth state, then relays it to Antigravity's loopback listener on the server. An SSH port-forward is not required.

Set `PI_ANTIGRAVITY_ACP_OAUTH_MODE=manual` to force this flow, or `PI_ANTIGRAVITY_ACP_OAUTH_MODE=browser` to force normal browser launch. OAuth URLs and callback codes are kept in a private temporary directory only for the duration of login and are never logged or persisted by this package.

For API-key authentication, choose **Enter an API key** and then **Antigravity Gemini API key** in `/login`, or set `GEMINI_API_KEY` before starting Pi.

Antigravity owns OAuth tokens under `~/.gemini/antigravity-acp/` (on macOS, in the Keychain under service `gemini`); Pi stores only a non-secret configured marker. Existing `agy` CLI credentials and Gemini CLI credentials should not be assumed to authenticate this separate ACP server.

### Model availability

The model catalog comes from the official ACP server. A successful model listing or selection is not an inference/access probe: newly listed models can still fail because of plan eligibility, staged rollout, or backend availability. As of October 13, 2026, Google's [Argon announcement](https://www.antigravity.google/blog/gemini-4-argon-in-google-antigravity) and [model availability table](https://www.antigravity.google/docs/models/) list Gemini 4 Argon for Google AI Ultra and eligible Enterprise subscriptions, not AI Pro. If it returns `Requested entity was not found`, check access in the official Antigravity app/CLI with the same account; do not guess alternate model IDs or assume the listing proves access. Use another advertised model while investigating.

### macOS credential storage

On macOS the Antigravity server prefers the login keychain (service `gemini`, accounts `antigravity-acp` / `antigravity-acp-business`), but decides that at every process start with a set/get/delete probe bounded to 3 seconds. Under load -- for example many concurrent Pi sessions, each spawning its own server -- the probe can time out; the server then silently falls back to the empty secure file, reports `Credentials missing or invalid`, and opens interactive Google consent although a valid login exists. This provider therefore pins every spawned server to the secure-file backend by default (`AGY_ACP_FORCE_FILE_STORAGE=1`, the server's documented switch and its default off macOS): credentials live in the 0600 files `~/.gemini/antigravity-acp/acp_token.json` and `acp_business_token.json`. Before spawning, a login that exists only in the keychain is copied once into the matching absent file, so switching backends never forces a new login; an existing file is never overwritten. Logout clears both the files and the keychain entries so the old account cannot be migrated back. Set `AGY_ACP_FORCE_FILE_STORAGE` yourself (for example `0` to return to the keychain) to take full control of the choice. `doctor`/`status` reports the expected backend as `Credential storage (preflight):`. An explicit `GEMINI_HOME` relocates the whole tree, including the token files, and is honored by setup, health checks, logout, migration, and the credential-storage decision.

The server's stderr is appended, redacted and tagged with its pid, to `$PI_CODING_AGENT_DIR/antigravity-acp-provider/logs/acp-server.log` (rotated once to `.1` past 5 MB). Search it for `Launching browser login flow`, `Failed to refresh token` or `Wiping credentials` when a saved login stops being reused.

The provider's own session decisions go to `logs/bindings.jsonl` in the same directory (also rotated past 5 MB): one line each time a Pi session binds to an Antigravity session (new, resume or load), sends a prompt (fresh history or delta, message range, bytes), ends a turn, drops a binding (with the reason) or sees the server process exit. From a checkout, `node scripts/diagnose-session.mjs [session.jsonl | session id | cwd]` lines a Pi session up with that log and the Antigravity transcripts it used, in local time, and flags context jumps, Pi history replayed into a non-empty session, harness checkpoints and backend errors.

## Commands

```text
/antigravity-acp setup
/antigravity-acp doctor
/antigravity-acp doctor --verbose
/antigravity-acp status
/antigravity-acp usage
/antigravity-acp quota
/antigravity-acp update
/antigravity-acp updates [automatic|notify|manual]
/antigravity-acp qualify
/antigravity-acp logout
/antigravity-acp account
/antigravity-acp permissions
/antigravity-acp permissions default
/antigravity-acp permissions auto-edit
/antigravity-acp permissions yolo
/antigravity-acp tools [pi|native]
/antigravity-acp sessions
/antigravity-acp plan <task>
```

Permission and runtime-update modes are saved in `$PI_CODING_AGENT_DIR/antigravity-acp-provider/config.json` (where `PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`). Runtime updates default to `automatic`; only provider-managed installations are replaced. ACP session bindings are saved beside the config in `sessions.json`.

On first use of a custom profile without a config, existing permission/update settings are copied from the default agent directory (or the legacy Gemini-provider config). Existing custom configs are never overwritten, and saved sessions are not copied. **Custom Pi profiles do not isolate Antigravity accounts or managed runtimes:** Antigravity's OAuth credentials and runtime installation remain in their shared locations.

`tools` switches who runs file and shell operations; it applies from the next prompt. `sessions` lists Antigravity sessions for the current directory and attaches one to the current Pi session; the next prompt resumes it. `plan` sends Antigravity's built-in `/plan`.

`logout`/`account` signs out through the server's ACP `logout` method, which also clears OAuth tokens kept in the macOS Keychain (service `gemini`), then clears local state and saved ACP sessions. Run Pi's `/logout` afterward to remove the Pi credential marker, then `/login` for the new account. `update` checks the official registry and installs its newest release only after matching it to the provider's signed runtime catalog. See [`docs/RUNTIME-UPDATES.md`](docs/RUNTIME-UPDATES.md).

## Development

```bash
npm run check
npm run test:real-acp  # initializes the installed Antigravity ACP server
npm run test:live      # sends a real authenticated prompt
npm run test:qualify   # live cancel, restore, MCP, model, and permission qualification
npm run test:packed
npm audit --audit-level=moderate

# Maintainer-only runtime catalog refresh/signing
npm run refresh:runtime-manifest
ACP_RUNTIME_MANIFEST_PRIVATE_KEY_PATH=/secure/key.pem npm run sign:runtime-manifest
```

CI checks Node 22.19.0 and 24, including typechecking, unit tests, packed installation and the full dependency audit. Live authenticated tests are opt-in and are not part of PR CI. See [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) for update and release policy.

### Turn progress and recovery

Prompts are bounded by inactivity, not total turn duration: streaming progress resets a 10-minute idle window. An outstanding native tool, parked Pi tool, or permission request gets a **finite 60-minute no-progress window** instead, so long work survives the former two-minute Pi-tool deadline without making stuck tools wait forever. Cancellation still sends `session/cancel`, answers parked requests, and closes an unresponsive agent after its 1.5-second grace period. The interactive permission broker retains its two-minute response limit. Integrations can override `promptIdleTimeoutMs` and `promptWorkIdleTimeoutMs` in connection options with positive finite durations; initialize/auth/session-setup deadlines are unchanged.

After 90 seconds without ACP updates, Pi warns and gives an idle prompt another 90 seconds before aborting; outstanding tool/permission work keeps its longer window. Both the warning and timeout report the latest recognized inference error observed in this prompt's server/relay stderr (for example HTTP 503 model capacity unavailable, HTTP 500, or EOF), including the relay attempt when available. Silence alone reports an unknown cause, not a guessed 502 or outage. Error response bodies are never copied into the warning; only fixed diagnostic categories are displayed. Relay logs retain recognized capacity/unreachable reasons even while retrying. Errors from previous prompts and model-catalog polling are excluded.

System instructions are kept outside truncated conversation history. Instructions larger than 256 KiB UTF-8 fail clearly rather than being silently shortened. ACP has no mid-prompt system-update RPC: an instruction change received with tool/permission results finishes the existing prompt under its original instructions, then forces reconstruction before the next prompt. Such a stale binding is not persisted for restoration.

## Security boundary

This launches a full coding agent with the user's OS privileges. **The default `yolo` mode permits Antigravity-native commands and edits without confirmation.** Use `/antigravity-acp permissions default` for confirmation prompts. Pi hooks govern tools routed through the `pi_` MCP namespace; with the default `tools pi` these replace Antigravity's file and shell built-ins. The remaining native tools (web search, URL fetch) and everything under `tools native` stay governed by Antigravity policy and ACP permission requests. ACP fs confinement in `tools native` covers only file reads and writes; native shell commands are not sandboxed by Pi. New/restored sessions must advertise and confirm the requested permission mode. Unsupported or failed mode changes close affected sessions; an executing turn is stopped before changing its policy. Unexpected mode-change notifications also invalidate the session. Doctor/status distinguishes requested policy from each live binding's confirmed mode. This protocol enforcement is not a sandbox.

## Compatibility

This release requires Pi 1.1.x and Node.js 22.19.0 or newer; development is pinned to Pi 1.1.0, ACP SDK 1.8.0, and ACP protocol 1. The provider supports stable session configuration options and retains compatibility with older Antigravity model-selection metadata; it does not enable experimental ACP v2. Upgrade Pi before upgrading from provider 0.1.12. Pi supplies the host packages at runtime, so their peer ranges remain `*` as required by Pi's package contract; this is not a promise of compatibility with every Pi version. Transcript system instructions and tool additions/removals are replayed into ACP checkpoints, replacing stale warm sessions when that state changes. The bundled signed catalog bootstraps Antigravity ACP 1.1.1 and can accept newer signed catalog releases without an npm update. ACP session setup allows up to two minutes for slow first-run initialization, while transport shutdown rejects pending requests immediately. The current official registry and signed catalog provide Linux x64/ARM64, Windows x64/ARM64, and macOS Intel/ARM64 artifacts. Intel macOS artifacts exist, but the proposed local re-signing workaround is not enabled or qualified by this package. Alpine/musl is rejected because Google's Linux build targets glibc.

During browser authentication, Chromium may write `Opening in existing browser session.` to the ACP process's inherited stdout. The transport ignores only that exact known compatibility line and reports its count in `doctor`; all other non-JSON stdout remains a fatal protocol error.

Managed installations also repair executable permissions for both the ACP server and its `localharness_external` helper. This repairs installations created by 0.1.3 and earlier, where OAuth could succeed but session creation failed with an opaque ACP `Internal error` because the extracted helper was not executable.

Earlier repository documents analyzing `@google/gemini-cli@0.58.0` describe the superseded implementation and are retained only as historical research. See [`docs/ANTIGRAVITY-MIGRATION.md`](docs/ANTIGRAVITY-MIGRATION.md).

## License

MIT. The original work is by Zac Bemis and the upstream contributors; see [LICENSE](LICENSE).
