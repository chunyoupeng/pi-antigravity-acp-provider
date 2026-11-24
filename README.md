# @chunyoupeng/pi-antigravity-acp-provider

A [Pi](https://github.com/earendil-works/pi) provider for **Google Antigravity** backed by the native `agy acp` CLI, with automatic 544K context-window patching, an HTTP/2 multiplexed CCPA relay, compact native tool rendering, and an authenticated loopback MCP bridge for Pi extension tools.

This is a fork of [zacbemis/pi-antigravity-acp-provider](https://github.com/zacbemis/pi-antigravity-acp-provider). Compared to upstream:

- Launches native `agy acp` (`--process-per-session --agent pi-acp-bridge --disable-telemetry`) instead of downloading and maintaining a separate `agy_acp_server.par` runtime catalog.
- Auto-provisions a minimal `pi-acp-bridge` custom agent under `$GEMINI_HOME/antigravity-cli/agents/pi-acp-bridge/agent.md` (`excludeDefaultComponents: true`, keeping the CCPA-required `<identity>` header and native `read_file`, `write_file`, `edit_file`, `run_command` tools) while exposing non-core Pi and extension tools over an authenticated loopback MCP bridge (`pi-bridge`).
- On macOS ARM64, automatically patches a private copy of `agy` to raise `utils.GetCheckpointConfig` from 256K to 544K without ever modifying the official binary, so Pi can manage a 512K context window and compact cleanly before the harness checkpoints on its own.
- Runs a local HTTP/2 multiplexed CCPA relay (`src/acp/ccpa-relay.mjs`) with direct, HTTP, and SOCKS5 proxy support, transparent HTTP/1.1 fallback, retry handling, and streaming heartbeats.
- Renders native tool activity with Pi's shell/file/diff renderers, pre-computing compact diffs on ingestion, caching row renders, showing full uncollapsed edit diffs, stripping `agy` command timestamps, and summarizing reads as `Read N lines`.
- Prunes idle Antigravity CLI conversation history (`$GEMINI_HOME/antigravity-cli/{conversations,brain}/`) that no saved Pi session references.

The provider ID, command name, and config directory are the same as upstream, so remove the upstream package before installing this one.

> **Important:** this package requires the native Google Antigravity CLI (`agy`). `@google/gemini-cli` and the legacy `agy_acp_server.par` managed installer are no longer used.

## Features

- **Native `agy acp` runtime:** resolves `AGY_ACP_BIN`, `~/.local/bin/agy`, or `agy` on `PATH`, and automatically maintains the minimal `pi-acp-bridge` custom agent.
- **Automatic 544K context-window patcher (`src/acp/agy-patch.ts`):** inspects `utils.GetCheckpointConfig` on macOS ARM64 binaries, copies and ad-hoc codesigns a patched binary under `$PI_CODING_AGENT_DIR/antigravity-acp-provider/runtime/`, re-checks automatically when `agy` updates, and cleans up the private copy if upstream natively lifts the 256K cap. Exposes a 512K context window to Pi so Pi's context meter and auto-compaction stay ahead of harness checkpointing. Set `PI_ANTIGRAVITY_PATCH_AGY=0` to disable patching.
- **Persistent HTTP/2 CCPA relay (`src/acp/ccpa-relay.mjs`):** started by the ACP supervisor and passed via `--cloud_code_endpoint`, multiplexing upstream requests over HTTP/2 (direct or via HTTP/HTTPS/SOCKS5 proxies) with transparent HTTP/1.1 fallback, 5xx retries, and stall diagnostics.
- **Model & reasoning projection:** collapses Antigravity's effort-qualified ACP model IDs into one Pi model entry; Shift+Tab dynamically selects advertised `low` / `medium` / `high` / `xhigh` tiers via ACP configuration options.
- **Hybrid tool execution:** core file and shell tools (`read`, `write`, `edit`, `bash`) execute natively through `agy`'s `read_file`, `write_file`, `edit_file`, and `run_command`; all other compatible Pi and extension tools are routed through the authenticated loopback MCP bridge (`pi-bridge`, `pi_` prefix). Bridged tool text over 46 KiB keeps its head inline and saves the full payload to a temporary file; inline images are capped at 512 KiB / 1536px; long-running bridged calls are handed back at 150s before Antigravity's 3-minute MCP deadline and answered on the next prompt.
- **Compact native tool UI (`extensions/tool-activity.ts`):** renders native file, diff, and shell activity with Pi's built-in renderers, pre-computes compact diffs at ingestion time so session files stay small and redraws stay fast, caches rendered rows, and survives session restore.
- **Session persistence & lifecycle:** supports ACP protocol v1 via the official TypeScript SDK, streaming, cancellation, usage/quota reporting, persisted session resume/load across Pi restarts, warm connection prewarming, idle binding hibernation (6h default), idle compaction, and 7-day unreferenced history cleanup.
- **Permission modes:** supports persisted `default`, `auto-edit`, and `yolo` (default) permission modes with a single-use, fail-closed Pi permission broker in prompting modes.
- **Instruction preservation:** keeps Pi project instructions (including `AGENTS.md` and named prompt sections) separate from truncated conversation history, up to 256 KiB UTF-8.

## New-user setup

### Prerequisites

1. Install [Google Antigravity CLI (`agy`)](https://www.antigravity.google/) and verify `agy --version` works.
2. Node.js `>=22.19.0` (standalone Pi builds also need `node` or `nodejs` on `PATH`, or `NODE` set to its path).

### Install

Install from GitHub:

```bash
pi remove npm:pi-antigravity-acp-provider   # if the upstream package is installed
pi install git:github.com/chunyoupeng/pi-antigravity-acp-provider
pi
```

To run from a local checkout:

```bash
git clone https://github.com/chunyoupeng/pi-antigravity-acp-provider.git
cd pi-antigravity-acp-provider
npm install
pi --no-extensions -e ./extensions/index.ts
```

To install a persistent local development checkout into Pi:

```bash
pi remove git:github.com/chunyoupeng/pi-antigravity-acp-provider
pi install "$PWD"
```

Pi loads the local directory without copying it. Restart Pi or run `/reload` after switching. Full ACP notifications are forwarded to Pi's `provider_stream_event` hook before conversion; display-only native tool records never enter the model transcript.

### First-run flow in Pi

1. Optionally run `/antigravity-acp setup` for a CLI/auth preflight and permission mode selection.
2. Run `/login` → **Sign in with an account** → **Google Antigravity (ACP)** (or authenticate `agy` directly).
3. Run `/antigravity-acp doctor` to verify CLI resolution, 544K patch status, authentication, and active bindings.
4. Run `/model` and choose an `antigravity-acp/*` model.
5. Press **Shift+Tab** to pick the reasoning effort tier advertised by Antigravity.

### Binary resolution & proxy / TLS behavior

The provider resolves `agy` in this order: `AGY_ACP_BIN`, `~/.local/bin/agy` (`agy.exe` on Windows), then `PATH`.

Loopback MCP and relay traffic is exempted from proxies in the ACP child environment (`localhost`, `127.0.0.1`, `::1`). Explicit `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase variants) are preserved. On macOS, when none are explicitly set, enabled system HTTP/HTTPS proxy settings are probed automatically; set `PI_ANTIGRAVITY_ACP_PROXY` to an absolute HTTP/HTTPS proxy URL to explicitly override child proxy settings. An explicit `SSL_CERT_FILE` is preserved; otherwise `NIX_SSL_CERT_FILE` or a readable system CA bundle is used when available.

### SSH and headless Google login

When Pi runs over SSH, or on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, `/login` automatically uses a manual browser relay:

1. Pi prints the Google authorization URL instead of launching a remote browser.
2. Open that URL locally and complete Google sign-in.
3. Copy the **complete final loopback URL** (`http://127.0.0.1:...`) from the browser address bar even if the page fails to connect locally.
4. Paste that URL into Pi; the provider validates its host, port, path, and OAuth state and relays it to the local listener on the server.

Set `PI_ANTIGRAVITY_ACP_OAUTH_MODE=manual` to force this flow or `PI_ANTIGRAVITY_ACP_OAUTH_MODE=browser` to force normal browser launch.

For API-key authentication, choose **Enter an API key** → **Antigravity Gemini API key** in `/login`, or set `GEMINI_API_KEY`.

On macOS, `agy` stores OAuth credentials in the login Keychain under service `gemini`, account `antigravity`; Pi stores only a non-secret configured marker.

### Diagnostics & logs

- Redacted ACP server and relay stderr: `$PI_CODING_AGENT_DIR/antigravity-acp-provider/logs/acp-server.log` (rotated to `.1` past 5 MiB).
- Session binding and turn decisions: `$PI_CODING_AGENT_DIR/antigravity-acp-provider/logs/bindings.jsonl` (rotated past 5 MiB).
- Timeline diagnostic tool: `node scripts/diagnose-session.mjs [session.jsonl | session id | cwd] [--all]` aligns a Pi session with `bindings.jsonl` and `$GEMINI_HOME/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` in local time, flagging context jumps, duplicate replays, harness checkpoints, and backend errors.

## Commands

```text
/antigravity-acp setup
/antigravity-acp doctor
/antigravity-acp doctor --verbose
/antigravity-acp status
/antigravity-acp usage
/antigravity-acp quota
/antigravity-acp qualify
/antigravity-acp logout
/antigravity-acp account
/antigravity-acp permissions
/antigravity-acp permissions default
/antigravity-acp permissions auto-edit
/antigravity-acp permissions yolo
/antigravity-acp sessions
/antigravity-acp plan <task>
```

Permission mode is saved in `$PI_CODING_AGENT_DIR/antigravity-acp-provider/config.json` (where `PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`). ACP session bindings are stored beside it in `sessions.json`, and the auto-patched `agy` binary + `patch-state.json` live under `runtime/`.

On first use of a custom `PI_CODING_AGENT_DIR` without a config, an existing config from `~/.pi/agent/antigravity-acp-provider/config.json` is copied once (existing configs are never overwritten, and sessions are not copied). **Custom Pi profiles do not isolate Antigravity OAuth credentials or `$GEMINI_HOME/antigravity-cli`.**

- `usage` queries `agy -p "/usage"` and formats remaining quota windows in local time.
- `quota` shows current-process token totals, latest server quota metadata, and latest context fill.
- `sessions` lists Antigravity sessions for the current working directory and attaches one to the current Pi session.
- `plan <task>` sends Antigravity's built-in `/plan` command.
- `logout` / `account` invokes ACP `logout`, clears Keychain credentials on macOS, and forgets saved ACP sessions. Run Pi's `/logout` afterward to remove the Pi marker, then `/login` for another account.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `AGY_ACP_BIN` | Explicit path to the `agy` executable |
| `PI_ANTIGRAVITY_PATCH_AGY` | Set to `0`/`false`/`no`/`off` to disable automatic 544K binary patching |
| `PI_ANTIGRAVITY_ACP_PROXY` | Override HTTP/HTTPS proxy URL for the ACP child process |
| `PI_ANTIGRAVITY_ACP_OAUTH_MODE` | Force `manual` or `browser` OAuth flow |
| `PI_ANTIGRAVITY_IDLE_TIMEOUT_MS` | Override idle ACP binding timeout (default 6 hours) |
| `PI_ANTIGRAVITY_MODEL_CATALOG_TTL_MS` | Override cached model catalog TTL (default 6 hours) |
| `PI_ANTIGRAVITY_CCPA_RELAY` | Set to `0`/`false` to disable the local CCPA relay |
| `PI_ANTIGRAVITY_CCPA_HTTP2` | Set to `0`/`false` to force HTTP/1.1 in the CCPA relay |
| `GEMINI_API_KEY` | Authenticate with a Gemini API key |
| `GEMINI_HOME` | Relocate Antigravity CLI data directory (default `~/.gemini`) |
| `PI_CODING_AGENT_DIR` | Relocate Pi agent config, sessions, logs, and patched runtime cache |
| `NODE` | Explicit Node.js executable for launching the ACP supervisor |
| `SSL_CERT_FILE` | Explicit CA bundle path for TLS verification |

## Development

```bash
npm run check          # tsc --noEmit && vitest run
npm run test:real-acp  # initializes the installed agy acp CLI
npm run test:live      # sends a real authenticated prompt
npm run test:qualify   # live cancel, restore, MCP, model, and permission qualification
npm run pack:check     # npm pack --dry-run
npm run test:packed    # isolated tarball install + Pi model-registration smoke test
npm audit --audit-level=moderate
```

Manual regression check against a real Pi process (required after source changes per [`AGENTS.md`](AGENTS.md)):

```bash
pi --no-extensions -e ./extensions/index.ts --no-session \
   --model "antigravity-acp/gemini-4-neon" \
   -p "Read package.json and tell me the package name, then run \`ls\`."
```

CI (`workflow_dispatch`) checks Node 22.19.0 and 24 with typechecking, unit tests, packed installation smoke tests, and `npm audit --audit-level=moderate`. Live authenticated tests are opt-in and never run in CI. See [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) for maintenance and release guidelines.

### Turn progress and recovery

Prompts are bounded by inactivity rather than total duration: streaming progress resets a 10-minute idle window, while an outstanding native tool, parked Pi tool, or permission request gets a finite 60-minute no-progress window. Cancellation sends `session/cancel`, resolves parked requests, and terminates unresponsive processes after a 1.5-second grace period. Interactive permission requests keep a 2-minute limit.

After 90 seconds without ACP updates, Pi warns and grants another 90 seconds for idle prompts before aborting, reporting the latest recognized inference error observed in this prompt's server/relay stderr (e.g. HTTP 503 capacity unavailable, HTTP 500, EOF) without echoing raw response bodies.

## Security boundary

This provider launches a full coding agent with the user's OS privileges. **The default `yolo` mode permits native commands and file edits without confirmation.** Switch to `/antigravity-acp permissions default` or `auto-edit` if you want confirmation prompts. Pi hooks govern tools routed through the `pi_` MCP bridge; native `read_file`, `write_file`, `edit_file`, and `run_command` are governed by Antigravity's permission mode and ACP permission requests. New and restored sessions must advertise and confirm the requested permission mode; unsupported changes or unexpected mode drift invalidate the binding. This protocol check is not an OS sandbox.

## Compatibility

Requires Pi 1.6.x (development is pinned to Pi 1.6.0), Node.js `>=22.19.0`, and an installed `agy` CLI (tested with `agy` 1.5.x). Uses `@agentclientprotocol/sdk` 1.8.0 and ACP protocol v1. Pi supplies host packages at runtime, so peer ranges remain `*` per Pi's package contract.

Earlier repository documents analyzing `@google/gemini-cli` or the superseded `agy_acp_server.par` installer are retained under [`docs/`](docs/README.md) for historical reference.

## License

MIT. Original work by Zac Bemis and upstream contributors; see [LICENSE](LICENSE).
