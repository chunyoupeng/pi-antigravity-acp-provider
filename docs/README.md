# Documentation map

> These documents are the upstream project's design and research record, kept for reference. Where they describe tool handling (native Antigravity tools shown as text), they describe upstream, not this fork; see the fork notes at the top of the [README](../README.md).

The documents separate observed facts, decisions, and planned work so future upstream changes can be reevaluated without mistaking assumptions for protocol guarantees.

> **Current architecture:** see [ANTIGRAVITY-MIGRATION.md](ANTIGRAVITY-MIGRATION.md). Documents centered on bundled `@google/gemini-cli` are historical and superseded because its individual Code Assist login path was retired.

| Document | Purpose |
|---|---|
| [ANTIGRAVITY-MIGRATION.md](ANTIGRAVITY-MIGRATION.md) | Current runtime/auth architecture and live validation |
| [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) | Implemented beta surface and remaining 1.0 release gates |
| [RUNTIME-UPDATES.md](RUNTIME-UPDATES.md) | Signed runtime catalog, automatic update policy, and maintainer workflow |
| [FORK-REVIEW.md](FORK-REVIEW.md) | Selective reliability improvements, fork attribution, deliberate exclusions and validation boundaries |
| [MAINTENANCE.md](MAINTENANCE.md) | Supported dependency versions, CI, profiles, release checklist, and branch-protection follow-up |
| [EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md) | Recommendation, scope, and decisive tradeoffs |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Definition of “first-class,” “no special setup,” and acceptance criteria |
| [RESEARCH.md](RESEARCH.md) | Pi, ACP, Gemini CLI, SDK, packaging, and ecosystem findings |
| [REFERENCE-COMPARISON.md](REFERENCE-COMPARISON.md) | What to adopt and avoid from the requested and adjacent implementations |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Proposed components, processes, sessions, state, and data flow |
| [PROTOCOL-MAPPING.md](PROTOCOL-MAPPING.md) | ACP-to-Pi event, content, stop-reason, usage, and tool mapping |
| [AUTH-PERMISSIONS-SECURITY.md](AUTH-PERMISSIONS-SECURITY.md) | Authentication design, permission round trips, filesystem policy, and threat model |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Phased build plan with concrete deliverables and exit criteria |
| [TEST-RELEASE-PLAN.md](TEST-RELEASE-PLAN.md) | Test matrix, fault injection, compatibility, marketplace, and release gates |
| [RISKS-OPEN-QUESTIONS.md](RISKS-OPEN-QUESTIONS.md) | Risk register, upstream blockers, decisions to validate, and rejected approaches |
| [SOURCES.md](SOURCES.md) | Versioned source inventory and links |

## Status vocabulary

- **Observed**: verified in source, installed documentation, package metadata, or a cited issue.
- **Required**: an acceptance condition for this project.
- **Proposed**: architecture not yet validated by a live prototype.
- **Deferred**: deliberately outside the first stable release.

## Recommended reading order

For implementation: [Implementation Status](IMPLEMENTATION-STATUS.md) → [Executive Summary](EXECUTIVE-SUMMARY.md) → [Requirements](REQUIREMENTS.md) → [Architecture](ARCHITECTURE.md) → [Protocol Mapping](PROTOCOL-MAPPING.md) → [Authentication and Security](AUTH-PERMISSIONS-SECURITY.md) → [Implementation Plan](IMPLEMENTATION-PLAN.md) → [Test Plan](TEST-RELEASE-PLAN.md). Read Research and Reference Comparison when revisiting a decision; use Risks and Sources during release review.
