# Selective fork improvements

These changes adapt ideas from the public forks rather than merging their host/deployment policies:

- [rasatpetabit, `4f6a4e3`](https://github.com/rasatpetabit/pi-antigravity-acp-provider/tree/4f6a4e33ae1e50c0b97ca0fe4a8c3f413a9bc9b4): cancellation/continuation cleanup, progress-based prompt liveness, instruction preservation and tool-omission visibility.
- [xztsummer, `ff7503e`](https://github.com/xztsummer/omp-antigravity-acp-provider/tree/ff7503e8289bd22577ec1bb2e2d1f43e37730c91): child-only HTTP proxy adaptation and authenticated loopback MCP bypasses.
- [robertvitali, `ffef188`](https://github.com/robertvitali/pi-antigravity-acp-provider/tree/ffef18842a3f0161fee294b0203dcbea72085d29): lifecycle guards around asynchronous setup and shutdown.
- [robertvitali, `8481e20`](https://github.com/robertvitali/pi-antigravity-acp-provider/commit/8481e20568b66d49b914305610608e7b751ff6cc): constraint-preserving, bounded MCP schema projection and labelled context reconstruction with explicit active requests/images.

## Deliberate differences

- Target current Pi 1.1.x and ACP SDK 1.8 stable configuration selectors, not fork-specific Pi 0.99 or OMP APIs and absolute host test paths.
- Preserve the documented `yolo`/automatic-update defaults, explicit API-key authentication, native-tool activity visibility, all supported platforms, and signed runtime publication.
- Outstanding work has a finite default 60-minute **inactivity** budget instead of disabling the watchdog indefinitely. Idle model progress retains the 10-minute window; prompt duration itself is not capped. Esc, process exit and provider close resolve parked calls.
- Keep full system instructions, capped at 256 KiB UTF-8 with a clear error on overflow, including current Pi transcript section updates/removals. The independent 32,000-character history/delta budget includes headings and fences, not instructions or the explicit active request. Active tool-loop identities are pinned; fail clearly if their labels alone cannot fit. Warm sessions receive only unseen context and do not repeat a request/image already delivered.
- Preserve supported MCP validation constraints, including literal choices and falsy constants. Omit entire tools with unsupported nested constraints rather than widening their declarations. Bound depth, traversal work and output size; reject cycles, executable/custom validators, proxies and accessors. Drop non-scalar annotation defaults without traversing them; retain original call-time argument validation and structured omission diagnostics.
- Do not pretend instruction/tool changes received during a continuation already reached ACP. Changed instructions invalidate restoration and force reconstruction on the next prompt; changed tool projections are rechecked before continuation early returns.
- Confirm permission policy through either modern configuration selectors or legacy modes. Unsupported changes close the session, competing changes are serialized, and unrequested mode-update notifications invalidate the binding. This is protocol validation, not isolation from the native agent.
- Report every omitted tool without hard-coding another deployment's `advisor`/`workflow` tool requirements.
- Keep queue ownership outside individual bindings, and guard asynchronous teardown against deleting a replacement binding.
- No history deletion, OAuth-account/profile migration, billing-environment restrictions, immutable Mac-only runtime pin, or local Intel macOS binary re-signing.

## Validation boundary

Regular tests use synthetic ACP child processes and isolated temporary stores. They cover new/restored modes, denied/ignored selectors, mode drift, aborted/late/partial parked calls, competing policy changes, stale continuations, changed tools, instruction changes across continuation and restart, oversized instructions, oversized tool results/arguments, explicit image handoffs, pinned parallel call/result identities, Unicode truncation boundaries, literal MCP constraints, hostile/cyclic/shared schemas, slow progress, finite stuck-work recovery, proxy preservation and shutdown during initialization.

Opt-in official-runtime checks can initialize, read model/mode metadata and reselect current settings without sending prompts. Real Google inference, native-tool execution, new-account OAuth and macOS proxy/signing qualification remain outside ordinary CI and are not implied by these synthetic tests.
