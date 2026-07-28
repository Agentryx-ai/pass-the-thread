# Codex Desktop 26.721.41059 importer snapshot

This directory records a version-pinned investigation of Codex Desktop's built-in external-agent importer, together with the on-disk measurements of this project's own import output that the same investigation produced. It is evidence for the in-development Pass the Thread framework; it is not a claim that every provider direction is complete.

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
| Cohort B re-measurement | 2026-07-28 |

The MSIX package version and the Electron app version are different version layers. The internal version comes from the packaged `package.json`; it is not derived from the MSIX version.

## Two cohorts

Evidence in this snapshot comes from two distinct bodies of data running in opposite directions. Conflating them has already produced one wrong number, so they are labelled throughout.

| Cohort | Direction | Written by | Size | Ledger |
| --- | --- | --- | ---: | --- |
| A | Claude → Codex | Codex Desktop `26.721.41059` built-in importer | 50 sessions | Codex rollouts, batch `77c07f8a-…` |
| B | Codex → Claude | this project's importer | 42 records | `~/.claude/codex-import-history.json` |

Cohort A is what the built-in importer did. Cohort B is what this project did, and it is the source of the 2026-07-28 measurements on continuation state, project grouping, and the relocation hazard. Unqualified counts of 50 in these documents always mean cohort A.

## Bottom line

The built-in importer completed quickly and reported every selected session as a success, but that success signal did not establish conversation fidelity. The imported rollouts contained only message response items: no native tool calls, tool results, reasoning, images, compaction records, world state, or turn context. A long compacted source also produced an imported token seed above the model context window and failed remote compaction twice.

The UI offers useful coarse categories, but Chat sessions are one aggregate choice. It exposes no per-session picker, search, date range, archive filter, or "existing projects only" filter. The Projects checkbox is independent from the Chats checkbox and does not constrain which chats are imported.

These observations justify retaining an inspectable importer path with explicit selection, preview, validation, loss reporting, and recovery. The architectural starting point is the predecessor `codex-to-claude` source-reader / conversion / target-writer design. Baton is not the source architecture. That lineage now continues under the Pass the Thread name; the supported direction matrix remains explicitly versioned and incomplete.

The 2026-07-28 cohort B measurements sharpen that conclusion in one direction and blunt it in another. They confirm real defects in this project's own import path — a manufactured path spelling that duplicates project registrations, and a whole-file hash that cannot tell continuation from an incidental append. They also establish that the typed-IR pipeline in this repository has never been run against real data here: its bridge store does not exist on this machine. Nothing in this snapshot is a passing report for the replacement.

## Evidence labels

| Label | Meaning |
| --- | --- |
| `STATIC` | Directly present in the version-pinned Electron bundle |
| `RUNTIME` | Measured from the import UI, source data, target rollouts, on-disk ledgers and transcripts, or explicit runtime errors |
| `DERIVED` | Arithmetic or a narrowly stated inference from static/runtime evidence |
| `UNKNOWN` | Not established, usually because behavior is inside the proprietary Rust app-server |

Do not promote a `DERIVED` statement to native implementation fact. In particular, Claude Code import is delegated to `codex.exe`; its parsing and mapping implementation remains `UNKNOWN` beyond static request names and runtime output.

## Documents

- [Built-in importer surface](BUILT_IN_IMPORTER.md) — providers, item choices, limits, routing, and selection risks.
- [Batch observations](BATCH_OBSERVATIONS.md) — the cohort A source/target census, and the cohort B census covering size, continuation state, and why the stored hash cannot detect continuation.
- [Compaction case](COMPACTION_CASE.md) — the concrete over-window token seed, two failed remote compactions, and the limits of that single case.
- [Resume contamination case](RESUME_CONTAMINATION_CASE.md) — why a project-correct imported rollout consulted a global Baton handoff.
- [Project grouping case](PROJECT_GROUPING_CASE.md) — the confirmed drive-letter-case root cause in this project's import path, the relocation hazard, and canonical-path mitigation.
- [Framework implications](FRAMEWORK_IMPLICATIONS.md) — why this belongs in a unified, extensible importer architecture, and what has not been exercised.
- [Goal app-server contract](GOAL_RPC.md) — generated protocol, isolated restart canary, version gate, and crash-recovery boundary.
- [Artifact provenance](../../../../reference/codex-desktop/26.721.41059/README.md) and [machine-readable manifest](../../../../reference/codex-desktop/26.721.41059/manifest.json).

## Corrections made on 2026-07-28

Prior claims are corrected in place rather than deleted. Each superseded statement is retained near its replacement so the change is auditable.

| Corrected claim | Replacement | Where |
| --- | --- | --- |
| The duplicate-project root cause is `UNKNOWN` and may be a Codex Desktop defect awaiting a controlled native-UI reproduction. | Confirmed cause: drive-letter case is not normalized to one canonical form, and this project's own `normalizeCwd` manufactures the lowercase spelling. This is a defect in the import path, not in Codex Desktop. The prior `STATIC` observation about the Electron bundle's `rootPaths` comparison stands but no longer carries the attribution. | [Project grouping case](PROJECT_GROUPING_CASE.md) |
| The Codex → Claude cohort is ~50, by analogy with the built-in importer's cap. | It is 42 records across five batches. The 50 and the 42 are different importers running in opposite directions. | [Batch observations](BATCH_OBSERVATIONS.md) |
| A recorded target hash identifies whether this tool's output is untouched. | It does not. 0 of 42 transcripts still match their recorded hash while 22 of the same 42 have no post-import content. Continuation must be classified on content. | [Batch observations](BATCH_OBSERVATIONS.md) |
| A transcript can be located from the recorded `projectRoot`. | 41 of 42 can; one has been moved by Claude Code and reports absent. Sessions must be located by id. | [Project grouping case](PROJECT_GROUPING_CASE.md) |

## Prior snapshot

`C:\_projects\Agentryx-ai\Agentryx\docs\reference\desktop-apps\CODEX_EXTERNAL_AGENT_IMPORT_2026-07-24.md` describes internal app version `26.721.3996`. It is useful historical context, but it is not evidence for this snapshot unless a claim is re-observed here.
