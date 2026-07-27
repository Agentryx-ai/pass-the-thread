# Compaction failure case

## Case identity

Source thread: `019f9b2a-0564-7e01-be66-fe04458e2a5f`

This case belongs to cohort A (Claude → Codex, Codex Desktop `26.721.41059`
built-in importer). It was a long Claude source with a recorded compact boundary. It demonstrates why a successful import write is not enough to establish that the resulting Codex thread can continue safely.

## Measured values

| Value | Count | Meaning |
| --- | ---: | --- |
| Source `compactMetadata.preTokens` | 998,008 | Claude source token count immediately before its compact boundary |
| Source `compactMetadata.postTokens` | 21,581 | Claude source token count immediately after compaction |
| Source `cumulativeDroppedTokens` | 976,427 | Tokens recorded as dropped by source compaction |
| Imported Codex seeded total | 576,090 | Initial target `event_msg.token_count.info.total_token_usage.total_tokens` and `last_token_usage.total_tokens` |
| Retry last usage | 670,194 | Target `last_token_usage.total_tokens` on retry |
| Target model context window | 258,400 | Imported thread's `model_context_window` |
| Remote compaction failures | 2 | Both explicitly reported as `context_window_exceeded`; remote compact ran out of room |

The target values are Codex-seeded/accounted thread token totals. They are not measured API input tokens; the target `input_tokens` fields were zero.

## Failure sequence

1. The source had already compacted from 998,008 to 21,581 tokens.
2. The imported rollout contained no native `compacted` record.
3. Codex seeded the imported thread at 576,090 total tokens, already 317,690 above the 258,400 model context window.
4. A retry reported 670,194 last-usage tokens.
5. Remote compaction failed twice with explicit `context_window_exceeded` / ran-out-of-room metadata.

Steps 1–5 are runtime observations. The causal statement that the imported seed and absent compaction representation made continuation unsafe is a narrow `DERIVED` conclusion. The exact Rust calculation that produced 576,090 and 670,194 remains `UNKNOWN`.

## Scope of this case

This is one thread, observed failing at runtime. It is not a survey.

- Which **other** sessions would fail to resume under compaction is `UNKNOWN`.
  Static inspection of transcripts and ledgers cannot answer it: nothing on disk
  records a resumability verdict, and the failure above was visible only because
  the thread was actually continued and the remote compaction actually ran.
- No claim is made here about cohort B (Codex → Claude). Its 42 records were
  censused on 2026-07-28 for continuation state, not for resumability, and no
  cohort B session has been continued under a compaction boundary as a test.
- Reading a large or long-running transcript is not evidence that it would fail.
  Establishing a per-session verdict requires an executed preflight, which is the
  design requirement below rather than an existing measurement.

## Design requirement

Before writing a long imported thread, a framework should:

- preserve a source compaction boundary in a target-safe representation;
- avoid copying incompatible cumulative token accounting as current context;
- validate every seeded usage value against the target model context window;
- run a resumability/compaction preflight, not merely a schema check;
- refuse or require an explicit lossy fallback when safe continuation cannot be demonstrated.
