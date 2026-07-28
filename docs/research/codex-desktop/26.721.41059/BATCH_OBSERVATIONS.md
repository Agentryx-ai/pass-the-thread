# Import batch observations

Two separate cohorts are recorded here and must not be conflated:

| Cohort | Direction | Written by | Size |
| --- | --- | --- | ---: |
| A | Claude → Codex | Codex Desktop `26.721.41059` built-in importer | 50 sessions |
| B | Codex → Claude | this project's importer | 42 records |

Every "50" in this snapshot belongs to cohort A. Cohort B was measured on
2026-07-28 and is documented below.

## Cohort A — observation set

| Metric | Value | Evidence |
| --- | ---: | --- |
| Batch ID | `77c07f8a-db9f-4e4a-bc2a-1a300f4d792f` | `RUNTIME` |
| Source directories represented | 23 | `RUNTIME` |
| Top-level Claude transcripts available | 263 | `RUNTIME` |
| Sessions imported | 50 (19.0% of 263) | `RUNTIME`, `DERIVED` |
| Import result | 50 successes, 0 failures | `RUNTIME` |
| Reported elapsed interval | one second | `RUNTIME` |
| Current Codex target state | 36 active, 14 archived | `RUNTIME` |

The percentage is `50 / 263`, rounded to one decimal place. The importer did not provide a per-session view explaining why these 50 were chosen from the 263 top-level transcripts. The 36/14 split is the current target state after import and subsequent manual archive actions; it is not evidence of Claude source archive state or archive preservation. Source archive state was not retained in the import ledger.

## Cohort A — source structural census

| Source block | Count |
| --- | ---: |
| `tool_use` | 8,948 |
| `tool_result` | 9,039 |
| `thinking` | 3,102 |
| `image` | 1 |

## Cohort A — imported Codex rollout census

| Target record/item | Count |
| --- | ---: |
| `session_meta` | 50 |
| `event_msg` | 22,958 |
| `response_item` | 21,250 |
| `response_item` with type `message` | 21,250 |
| native call items | 0 |
| native call-output/result items | 0 |
| native reasoning items | 0 |
| native image items | 0 |
| `compacted` items | 0 |
| `world_state` records | 0 |
| `turn_context` records | 0 |

## Cohort A — what is confirmed

- All 50 selected sessions produced target rollouts and were reported as successful.
- Every imported `response_item` was a message.
- No target-native call, result, reasoning, image, compaction, world-state, or turn-context structure survived as its corresponding native item type.
- The source contained thousands of tool and reasoning blocks, so absence in the target is meaningful rather than a property of a text-only sample.

## Cohort A — what is inferred, not proven

The paired censuses show a structural fidelity collapse. They do **not** by themselves prove whether each source tool block was discarded, rendered into a text marker, merged with adjacent text, or otherwise transformed. Establishing that exact mapping would require content-level correlation or the proprietary Rust implementation.

Likewise, "50 successes" appears to mean that the importer completed its write operation without item-level errors. It must not be treated as a semantic round-trip or resumability guarantee.

## Cohort A — defects and gaps exposed by the batch

| Finding | Severity for migration | Basis |
| --- | --- | --- |
| Success reporting does not include a fidelity check. | High | 50/50 success alongside zero native tool/reasoning/image items |
| Tool calls and results are not represented as native Codex call/result items. | High | Source/target census |
| Reasoning structure is not represented as native reasoning items. | Medium | Source/target census; exact content treatment unknown |
| The source image is not represented as a native image item. | Medium | Source/target census; exact fallback unknown |
| Compaction and turn state are absent from all imported targets. | High for long sessions | Target census plus the compaction failure case |
| Source archive preservation cannot be audited from the import ledger, and the UI offers no archive-state choice. | Medium | Runtime UI and ledger observation |
| The 50-session aggregate cannot be reviewed or searched before import. | Medium | Runtime UI observation |

An extensible importer should therefore report both operational success and representational loss, with the latter computed before any target write.

## Cohort B — the reverse direction, measured 2026-07-28

This cohort is this project's own Codex → Claude output, recorded in
`~/.claude/codex-import-history.json` (schema `{version, records[]}`, `version: 1`).
Every record carries `contentSha256`, `importedAtMs`, `importedSessionId`,
`sourceRolloutPath`, `projectRoot`, and `targetSha256`.

| Metric | Value | Evidence |
| --- | ---: | --- |
| Ledger records | 42 | `RUNTIME` |
| Transcripts under `~/.claude/projects` containing `"version":"0.0.0-codex-import"` | 42 | `RUNTIME` |
| Records whose transcript was located by session id | 42 of 42 | `RUNTIME` |
| Records whose transcript sits at the path derived from `projectRoot` | 41 of 42 | `RUNTIME` |

The cohort is 42, not the ~50 that had been assumed by analogy with cohort A's
50-session cap. That assumption is corrected here; the two numbers describe
different importers running in opposite directions and are unrelated.

Import batches, from `records[].importedAtMs` bucketed to the minute in UTC:

| Batch (UTC) | Records |
| --- | ---: |
| `2026-07-24T23:06` | 15 |
| `2026-07-24T23:18` | 1 |
| `2026-07-27T13:55` | 11 |
| `2026-07-27T14:55` | 14 |
| `2026-07-27T15:00` | 1 |

A loose search for the string `0.0.0-codex-import` matches 46 files; four of those
are ordinary conversations that discuss the marker. The exact JSON form
`"version":"0.0.0-codex-import"` matches exactly 42.

### The stored hash cannot detect continuation

`src/claude-target.ts` classifies an existing target by comparing its SHA-256
against the `targetSha256` the importer recorded (`inspectTarget`: `absent`,
`ours`, `modified`, `foreign`). Hashing all 42 transcripts and comparing:

| Result | Count |
| --- | ---: |
| Transcript hash equals recorded `targetSha256` | 0 |
| Transcript hash differs from recorded `targetSha256` | 42 |

Not one record still matches. Yet 22 of those same sessions have no post-import
content at all. The hash therefore cannot distinguish "the user continued this
conversation" from "Claude Code appended a line when the file was opened". A gate
built on it has only two outcomes: refuse all 42, or be forced past — and forcing
it would overwrite the 20 sessions that do contain real work. Both the 0/42 split
and the 22/20 split are `RUNTIME`; that a forced run would destroy those 20 is
`DERIVED`, because no write was attempted.

### Content-level classification does work

Splitting instead on "does any transcript line carry a `timestamp` later than the
record's `importedAtMs`" separates the cohort cleanly:

| Class | Count |
| --- | ---: |
| Unchanged since import | 22 |
| Modified since import | 20 |

All 20 modified sessions contain substantive tool work. Counting mutating tool
calls (`Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `PowerShell`) that
appear after `importedAtMs`, the smallest has 22 and the largest 537. There is no
"questions only" session in the cohort: no modified session sits near zero, so
"modified" and "carries real work" coincide here. Whether that coincidence holds
for other cohorts is `UNKNOWN`.

### How to re-measure cohort B

1. Parse `~/.claude/codex-import-history.json`; bucket `importedAtMs` by minute.
2. Walk `~/.claude/projects` recursively, indexing every `*.jsonl` by basename, and
   look each `importedSessionId` up by id rather than by derived path.
3. SHA-256 each transcript and compare with the record's `targetSha256`.
4. Parse each transcript line as JSON and test `Date.parse(line.timestamp) >
   record.importedAtMs`; count `tool_use` blocks on the later lines.
