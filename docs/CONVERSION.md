# Conversion

What survives the trip from a Codex rollout to a Claude transcript, and what
each Codex item turns into. On-disk shapes for both sides are in
[FORMATS.md](./FORMATS.md); flags are in [CLI.md](./CLI.md).

| Codex | Claude |
| --- | --- |
| user, assistant message | user, assistant message |
| `function_call`, `custom_tool_call`, `tool_search_call` | `tool_use` |
| `*_output` | `tool_result` |
| `reasoning` | `thinking` (with `--include-reasoning`) |
| pasted screenshots | `image` |
| `agent_message` | metadata line, prefixed with the sender |
| injected context | metadata line |
| memory citations | metadata line after the reply they belong to |
| sandbox and approval policy | `permissionMode` |
| reasoning effort | `effort` |
| `event_msg`, `world_state` | dropped |

## Conversation names

Codex names conversations it starts from the app, and shows that name rather
than the message you opened with — `git pull 해서 최신화하고 …handoff.md
읽으세요` is listed as `최신화하고 문서 읽기`. Imports carry the name over, so
a conversation is called the same thing on both sides.

CLI conversations never get a name from Codex, and Codex lists them by their
first message. Those import the same way, minus the injected boilerplate.

## Injected context

Codex adds a lot of tooling boilerplate to conversations as ordinary user
messages: environment blocks, plugin catalogs, skill and permission
instructions, AGENTS.md contents. Importing those as messages makes it look
like you pasted them, and one of them usually becomes the title.

They are marked `isMeta` instead, which is Claude's own convention for context
nobody typed. They stay in the transcript, out of the conversation and out of
the title.

Codex builds that boilerplate client-side and sends it as a normal user
message, so nothing in the rollout marks it. Detection is textual and needs a
Codex-specific signal: a `developer` role, a Codex-specific opening tag, or a
known heading together with the structure that goes with it. Tags you might
paste yourself, like `<instructions>` or `<root>`, are left alone. When an
injection wraps a real message (attachment lists, response annotations), the
two are split.

## Memory citations

When Codex answers from its memory files it appends an `<oai-mem-citation>`
block as the last thing in the reply. Codex Desktop parses it back out, so the
tags are never on screen there. Left alone, they would show up as raw markup at
the end of an imported answer. They become a readable metadata line after the
reply they belong to instead.

## Permissions

Codex separates approval (when to ask) from sandbox (what it may touch). Claude
has one `permissionMode`:

| Codex | Claude |
| --- | --- |
| approval asks the user (`default`, `on-request`, `untrusted`, `on-failure`) | `default` |
| never asks, `danger-full-access` or sandbox disabled | `bypassPermissions` |
| never asks, `workspace-write` or `managed` | `acceptEdits` |
| never asks, `read-only` | `plan` |
| anything else | `default` |

Reasoning effort carries over directly. Codex `ultra` becomes `max`. The Claude
model has no Codex counterpart and defaults to `claude-opus-5`, which `--model`
overrides.

## Long conversations

Claude replays a whole transcript when you resume, so a long Codex session can
blow past the context window before you send anything. Codex records the
shortened context it kept on each compaction, and imports start from the most
recent one. On one observed set of 20 conversations this took 39 MB of
serialized history down to 6.5 MB. Provider-reported token counters, when
present, remain source provenance; the offline refusal check uses explicitly
named serialized character or UTF-8 byte units and never treats those counters
as target usage.

Nothing is summarised, and nothing needs to be. Codex does not summarise at
import either. It seeds token counts so its own auto-compaction runs on the
next turn, which Claude cannot do because it fails first.

Claude has a different mechanism for the same problem: a
`system`/`compact_boundary` line in the transcript, after which everything
earlier is left out when the conversation loads. `--full-history` keeps every
turn on disk and writes one of those markers wherever Codex compacted, so the
whole conversation stays searchable while only the recent part is replayed.

`--max-tool-output` changes the 4000-character cap on tool results, and
`--max-chars` sets the overall ceiling.

## Resuming

A transcript can show up in the sidebar and still fail on the first message
with a 400. Every conversion is checked before it is written, and these are
repaired:

- `tool_use.input` must be an object, not a JSON string
- every `tool_use` needs a `tool_result` in the next message, so several calls
  in one turn are answered together and missing outputs get a placeholder
- a `tool_result` with no matching call becomes text
- no empty messages, transcripts start with a user message, `parentUuid` forms
  one chain
