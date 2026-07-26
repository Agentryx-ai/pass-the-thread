# 50-session import observations

## Observation set

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

## Source structural census

| Source block | Count |
| --- | ---: |
| `tool_use` | 8,948 |
| `tool_result` | 9,039 |
| `thinking` | 3,102 |
| `image` | 1 |

## Imported Codex rollout census

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

## What is confirmed

- All 50 selected sessions produced target rollouts and were reported as successful.
- Every imported `response_item` was a message.
- No target-native call, result, reasoning, image, compaction, world-state, or turn-context structure survived as its corresponding native item type.
- The source contained thousands of tool and reasoning blocks, so absence in the target is meaningful rather than a property of a text-only sample.

## What is inferred, not proven

The paired censuses show a structural fidelity collapse. They do **not** by themselves prove whether each source tool block was discarded, rendered into a text marker, merged with adjacent text, or otherwise transformed. Establishing that exact mapping would require content-level correlation or the proprietary Rust implementation.

Likewise, "50 successes" appears to mean that the importer completed its write operation without item-level errors. It must not be treated as a semantic round-trip or resumability guarantee.

## Defects and gaps exposed by the batch

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
