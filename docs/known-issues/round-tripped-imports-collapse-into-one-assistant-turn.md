# A round-tripped conversation collapses into one assistant turn

**Severity:** medium (structure lost, content preserved — the conversation is readable but not navigable, and its turn boundaries are gone)
**Area:** `src/map.ts` (`mapSessionToClaudeLines` assistant buffering)
**Status:** open

## Summary

Importing a Codex thread that Codex itself received from Claude produces a transcript
with almost no turns. `019f9b2a-0ae2-…` (`당신은 Claude Desktop proprietary package
Snapshot의 정적 분석 담당자다`, 84 messages in the Codex index) imports as **2 lines**:
one user message and one assistant message carrying **83 text blocks**.

Nothing is dropped — the 83 blocks hold 70,558 characters, and the written transcript is
77,766 bytes against a 190 KB source. What is lost is the shape: eighty-three exchanges
render as a single unbroken assistant bubble.

## Observed

| conversation | Codex index msgs | transcript lines | worst single assistant line |
|---|---|---|---|
| `019f9b2a-0ae2` 정적 분석 담당자 | 84 | 2 | 83 blocks |
| `019f9b2a-05d0` PDF 분석 보고서 작성 | 182 | 27 | 69 blocks |
| `019f9b2a-062f` Codex import 기능 분석 | 1151 | 88 | — |

All are `019f9b2a-*` threads written by a prior Claude → Codex import in the same second,
and all sit in the `Agentryx-New` project. Threads authored natively in Codex are
unaffected — this is specific to conversations that have already crossed once.

## Root cause

`mapSessionToClaudeLines` buffers consecutive Codex items into one assistant turn and
flushes when a user message intervenes. That is correct for Codex's native shape, where a
single turn legitimately spans `reasoning` + `message` + `function_call` items and should
arrive as one Claude assistant message.

A Claude → Codex import does not write that shape. It writes the entire prior
conversation as a flat run of `role: "assistant"` messages, with the tool traffic
rendered into their text as `[external_agent_tool_call: …]` / `[external_agent_tool_result]`
rather than as `function_call` / `function_call_output` items:

```
message roles: {"user":1,"assistant":83}
  role=user      "당신은 Claude Desktop proprietary package Snapshot의 정적 분석 담당자다…"
  role=assistant "코드 검토에서 확인된 네 항목을 현재 Run 안에서만 최소 보정하겠습니다…"
  role=assistant "[external_agent_tool_call: exec]\ninput: {…}"
  role=assistant "[external_agent_tool_result]\n[{\"type\":\"input_text\"…}]"
```

Eighty-three consecutive `assistant` items with no user item between them are, to the
buffer, one turn. So they become one message.

## Suggested fix

The buffer needs a second flush condition beyond "a user message arrived". Options, in
rough order of how well they match what the source actually says:

1. **Flush on an item boundary the source already marks.** A Claude → Codex import writes
   one `response_item` per original turn; consecutive `message` items with
   `role: "assistant"` are separate turns by construction, unlike a `reasoning` →
   `message` → `function_call` run within one turn. Flushing between two adjacent
   assistant *messages* (as opposed to between an assistant message and its reasoning or
   tool items) restores the turn boundaries without needing to recognise the importer.
2. **Recognise the rendered tool markers.** `[external_agent_tool_call: …]` and
   `[external_agent_tool_result]` are the reverse importer's own rendering of a tool pair.
   Mapping them back to `tool_use` / `tool_result` blocks would restore not just turn
   boundaries but the tool structure — closing the round trip properly. Larger change, and
   it depends on a text format the other side is free to change.
3. **Cap blocks per assistant message.** Cheap, and wrong for the right reasons: it would
   split a genuine long Codex turn as readily as a collapsed import.

Option 1 is the correct general fix and does not require identifying the source as an
import. Option 2 is worth doing on top of it if the round trip is meant to be lossless.

## Regression test

A fixture rollout whose items are one `user` message followed by several consecutive
`assistant` messages (no `reasoning` or `function_call` between them). Assert each
assistant message becomes its own transcript line, and separately that a native-shaped
turn (`reasoning` + `message` + `function_call` in a row) still arrives as one.
