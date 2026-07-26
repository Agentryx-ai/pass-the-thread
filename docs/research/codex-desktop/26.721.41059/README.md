# Codex Desktop 26.721.41059 importer snapshot

This directory records a version-pinned investigation of Codex Desktop's built-in external-agent importer. It is evidence for the in-development Pass the Thread framework; it is not a claim that every provider direction is complete.

## Snapshot

| Field | Value |
| --- | --- |
| Investigation date | 2026-07-26 |
| Windows package | `OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0` |
| MSIX version | `26.721.4979.0` |
| Electron app version | `26.721.41059` |
| Electron build number | `5848` |
| Batch ID | `77c07f8a-db9f-4e4a-bc2a-1a300f4d792f` |
| Imported sample | 50 Claude sessions from 23 source directories |
| Native importer result | 50 successes, 0 reported failures, completed within one second |

The MSIX package version and the Electron app version are different version layers. The internal version comes from the packaged `package.json`; it is not derived from the MSIX version.

## Bottom line

The built-in importer completed quickly and reported every selected session as a success, but that success signal did not establish conversation fidelity. The imported rollouts contained only message response items: no native tool calls, tool results, reasoning, images, compaction records, world state, or turn context. A long compacted source also produced an imported token seed above the model context window and failed remote compaction twice.

The UI offers useful coarse categories, but Chat sessions are one aggregate choice. It exposes no per-session picker, search, date range, archive filter, or "existing projects only" filter. The Projects checkbox is independent from the Chats checkbox and does not constrain which chats are imported.

These observations justify retaining an inspectable importer path with explicit selection, preview, validation, loss reporting, and recovery. The architectural starting point is the predecessor `codex-to-claude` source-reader / conversion / target-writer design. Baton is not the source architecture. That lineage now continues under the Pass the Thread name; the supported direction matrix remains explicitly versioned and incomplete.

## Evidence labels

| Label | Meaning |
| --- | --- |
| `STATIC` | Directly present in the version-pinned Electron bundle |
| `RUNTIME` | Measured from the import UI, source data, target rollouts, or explicit runtime errors |
| `DERIVED` | Arithmetic or a narrowly stated inference from static/runtime evidence |
| `UNKNOWN` | Not established, usually because behavior is inside the proprietary Rust app-server |

Do not promote a `DERIVED` statement to native implementation fact. In particular, Claude Code import is delegated to `codex.exe`; its parsing and mapping implementation remains `UNKNOWN` beyond static request names and runtime output.

## Documents

- [Built-in importer surface](BUILT_IN_IMPORTER.md) — providers, item choices, limits, routing, and selection risks.
- [50-session observations](BATCH_OBSERVATIONS.md) — source/target census and what the success result did not measure.
- [Compaction case](COMPACTION_CASE.md) — the concrete over-window token seed and two failed remote compactions.
- [Resume contamination case](RESUME_CONTAMINATION_CASE.md) — why a project-correct imported rollout consulted a global Baton handoff.
- [Project grouping case](PROJECT_GROUPING_CASE.md) — the duplicate-project hypothesis, evidence limits, and canonical-path mitigation.
- [Framework implications](FRAMEWORK_IMPLICATIONS.md) — why this belongs in a unified, extensible importer architecture.
- [Goal app-server contract](GOAL_RPC.md) — generated protocol, isolated restart canary, version gate, and crash-recovery boundary.
- [Artifact provenance](../../../../reference/codex-desktop/26.721.41059/README.md) and [machine-readable manifest](../../../../reference/codex-desktop/26.721.41059/manifest.json).

## Prior snapshot

`C:\_projects\Agentryx-ai\Agentryx\docs\reference\desktop-apps\CODEX_EXTERNAL_AGENT_IMPORT_2026-07-24.md` describes internal app version `26.721.3996`. It is useful historical context, but it is not evidence for this snapshot unless a claim is re-observed here.
