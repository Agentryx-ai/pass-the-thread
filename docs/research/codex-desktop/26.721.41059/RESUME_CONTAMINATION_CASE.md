# Resume-session contamination case

## Verdict

No evidence shows the built-in importer merged Baton source records into the auto-play or Ansim transcript. The imported rollouts retained their correct project `cwd`. The observed contamination occurred later when a generic, project-unscoped `resume-session` fallback searched `~/.codex/session-data` and found only a Baton handoff.

The importer still contributed to the failure mode: its target rollouts lacked native Goal, compaction, turn-context, and world-state records, leaving the continued thread without the structured recovery state that native durable work can use. That causal contribution is `DERIVED`; the global fallback behavior and concrete file selection are `RUNTIME`.

## auto-play: fallback was applied

| Field | Value |
| --- | --- |
| Imported target thread | `019f9b2a-05d6-76a3-900b-1a1633d95415` |
| Target `cwd` | `C:\_projects\Agentryx-ai\auto-play` |
| Title | `우리프로젝트의 목적/목표 및 범위에 대한 문서 일체를 읽고 이해하라 완전히` |
| Selected handoff | `C:\Users\MeroZemory\.codex\session-data\2026-07-22-baton-goal-handoff-session.tmp` |
| Handoff project | `C:\Users\MeroZemory\.codex\worktrees\44cf\Baton` |

The continued target read the Baton file and emitted `SESSION LOADED`, while also warning that the handoff was Baton rather than auto-play. This confirms selection and loading, not an import-time record merge.

## Ansim: same unsafe candidate, guarded outcome

| Field | Value |
| --- | --- |
| Imported target thread | `019f9b2a-0704-7e01-ae5a-1d3633d7f83e` |
| Target `cwd` | `C:\_projects\Agentryx-ai\Ansim` |
| Title | `프로젝트 목적/목표 및 범위 일체에 대해 이해하고 현 상황(뭘 하고있었는지, 뭘 해야할지 등)에 대해 확인하라` |
| Candidate found | the same `2026-07-22-baton-goal-handoff-session.tmp` |
| Outcome | rejected because it belonged to Baton |

Ansim therefore demonstrates the same global lookup defect but not actual content application. The agent explicitly kept the current Git state instead.

## Why imported threads were hit

The no-argument migrated `resume-session` skill says to load the most recent file under `~/.Codex/session-data`. It does not require the handoff's project/worktree to match the current thread `cwd`. At observation time that directory contained only the Baton handoff.

Native durable Goal continuation and this generic command are different mechanisms. Existing native threads that retain Goal/world-state/turn-context can resume through their structured state; the 50 cohort A rollouts contained none of those record types. It is therefore consistent for ordinary native conversations to appear unaffected while imported long-running work falls into the generic fallback. It is not proof that native threads can never invoke the unsafe skill.

## Required guard

Any session-handoff resolver must require an exact canonical project identity by default. A global “latest file” may be shown as a rejected candidate, but must never load unless the user explicitly chooses a cross-project handoff. Historical imported Goal state must remain inert unless a target-native activation contract is independently proven.
