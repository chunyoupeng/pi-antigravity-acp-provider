# Documentation map

> **Current architecture:** see the root [README](../README.md) and [ANTIGRAVITY-MIGRATION.md](ANTIGRAVITY-MIGRATION.md). Most other documents in `docs/` come from the upstream design/research record (originally targeting `@google/gemini-cli` and later `agy_acp_server.par`) and are kept for historical reference.

The documents separate observed facts, decisions, and historical design context so future changes can be evaluated without mistaking superseded assumptions for current behavior.

| Document | Purpose |
|---|---|
| [ANTIGRAVITY-MIGRATION.md](ANTIGRAVITY-MIGRATION.md) | Evolution from Gemini CLI → `agy_acp_server.par` → native `agy acp` |
| [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) | Current implemented surface and remaining qualification items |
| [CONTEXT-COMPACTION.md](CONTEXT-COMPACTION.md) | Context-window measurement, transcript usage accounting, and Pi compaction takeover |
| [FORK-REVIEW.md](FORK-REVIEW.md) | Selective reliability improvements, fork attribution, and validation boundaries |
| [MAINTENANCE.md](MAINTENANCE.md) | Supported dependency versions, CI, profiles, and release checklist |
| [EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md) | Historical upstream recommendation, scope, and decisive tradeoffs |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Historical upstream requirements and acceptance criteria |
| [RESEARCH.md](RESEARCH.md) | Historical Pi, ACP, Gemini CLI, SDK, packaging, and ecosystem findings |
| [REFERENCE-COMPARISON.md](REFERENCE-COMPARISON.md) | Historical comparison with adjacent implementations |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Historical upstream architecture notes |
| [PROTOCOL-MAPPING.md](PROTOCOL-MAPPING.md) | ACP-to-Pi event, content, stop-reason, usage, and tool mapping |
| [AUTH-PERMISSIONS-SECURITY.md](AUTH-PERMISSIONS-SECURITY.md) | Authentication design, permission round trips, and threat model |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Historical phased build plan |
| [TEST-RELEASE-PLAN.md](TEST-RELEASE-PLAN.md) | Test matrix, fault injection, compatibility, and release gates |
| [RISKS-OPEN-QUESTIONS.md](RISKS-OPEN-QUESTIONS.md) | Risk register and upstream blockers |
| [SOURCES.md](SOURCES.md) | Versioned source inventory and links |

## Status vocabulary

- **Observed**: verified in source, installed documentation, package metadata, or a cited issue.
- **Required**: an acceptance condition for this project.
- **Proposed**: architecture not yet validated by a live prototype.
- **Deferred**: deliberately outside the current scope.
