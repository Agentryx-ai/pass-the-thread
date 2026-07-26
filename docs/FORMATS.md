# Formats

What this tool reads and writes. These are **undocumented, internal** formats of two proprietary desktop apps, reconstructed by observation. They can change without notice.

## Source — Codex rollout

`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, one JSON object per line:

```jsonc
{ "timestamp": "2026-07-24T05:38:12.123Z", "type": "<item-type>", "payload": { … } }
```

| `type` | Meaning | Byte-exact IR / sidecar | Semantic target rendering |
| --- | --- | --- | --- |
| `session_meta` | first line: `id`, `cwd`, `cli_version`, `source`, `git`, `parent_thread_id`, … | yes | selected conversation metadata, not chat |
| `response_item` | model output and tool traffic | yes | supported messages, reasoning/media policy, and valid tool traffic |
| `turn_context` | per-turn settings snapshot (model, cwd, approval policy) | yes | selected metadata only; the full record stays sidecar-only |
| `event_msg` | UI/protocol events (`agent_message`, `token_count`, task/Goal updates, …) | yes | only explicitly typed projections such as inert task history or Goal state; generic protocol events stay sidecar-only |
| `compacted` | context-compaction summary | yes | the latest portable summary may rebuild compact context; earlier or invalid boundaries stay sidecar-only |
| `world_state`, `inter_agent_communication_metadata` | agent internals | yes | no live semantics; sidecar-only |

`response_item` payload variants:

```jsonc
{ "type":"message", "role":"user"|"assistant"|"developer", "content":[{"type":"input_text"|"output_text","text":"…"}] }
{ "type":"reasoning", "summary":[{"type":"summary_text","text":"…"}] }
{ "type":"function_call", "name":"shell", "arguments":"{\"cmd\":\"ls\"}", "call_id":"call_x" }
{ "type":"function_call_output", "call_id":"call_x", "output":"…" }
{ "type":"custom_tool_call",  "name":"…", "input":"…", "call_id":"…" }
{ "type":"tool_search_call",  "call_id":"…", "arguments":"…" }   // note: no `name`
{ "type":"tool_search_output","call_id":"…", "tools":[…] }        // note: no `output`
```

Calls and results are flat and paired by `call_id`, not nested.

### Selecting the conversations Codex Desktop lists

Not every rollout is a conversation in the sidebar. Sub-agent threads, `codex exec` automation runs and archived threads all live in the same directory. It resolves the list from Codex's own state, in this order:

1. `~/.codex/.codex-global-state.json` — the sidebar's grouping, in one of two shapes. Older builds record `thread-project-assignments` (thread → project) plus `projectless-thread-ids`, which together *are* the membership. Current builds drop the assignment map: projects are registered under `local-projects` with `rootPaths`, and a thread belongs to whichever project's root contains its `cwd` (longest match), so membership comes from the index below and this file only supplies the names.
2. `~/.codex/state_<n>.sqlite` — `threads` (`archived`, `rollout_path`, `title`, `name`, `first_user_message`, `cwd`, `source`, `recency_at_ms`) and `thread_spawn_edges` (parent → child). Used to drop archived and spawned threads, and to resolve each thread's rollout file.
3. Rollout-file scan, applying the equivalent rules from `session_meta` (`parent_thread_id`, `source`), when neither is available.

### Conversation names

The name Codex shows is not the first thing the user typed. Codex generates a short name for threads started from the app — `git pull 해서 최신화하고 tagless-p2p4-mac-hardware-handoff.md 읽으세요` becomes `최신화하고 문서 읽기` — and never names CLI threads, whose first message it shows instead.

`~/.codex/session_index.jsonl` is where the names live, append-only, one line per naming:

```jsonc
{"id":"<threadId>","thread_name":"…","updated_at":"2026-07-13T14:10:51.946387Z"}
```

Renaming appends another line, so the newest `updated_at` wins. On the machine this was reconstructed from, 38 of 38 app-created threads had an entry and none of the 13 CLI/exec threads did.

`threads.name` / `threads.title` is a weaker second source, used when there is no index file. `title` is seeded with `first_user_message` and replaced when Codex names the thread, so a `title` that differs from `first_user_message` is a generated name — but the DB lags renames (8 of 38 still carried the first message).

## Target — Codex Desktop 26.721.41059

Claude → Codex writes a new rollout under `sessions/YYYY/MM/DD` or
`archived_sessions`, then registers that exact path in the `threads` table of
the pinned `state_<n>.sqlite`. Equivalent existing project paths are resolved
to one canonical filesystem identity before the rollout and index row are
planned. The importer never writes `goals_1.sqlite`; eligible live Goals are
activated only through the separately fingerprinted app-server Goal RPC after
thread registration.

Semantic mode emits human/model text and native tool traffic only for a
contiguous parallel call batch from one assistant record/envelope followed by
the exact result set in one distinct, direct-child user record/envelope. Native
record lineage is mandatory; missing or ambiguous `uuid`/`parentUuid` fails
closed to inert history. Task notifications,
historical/superseded Goals, access snapshots, and other source controls are
rendered as explicitly inert assistant history, never copied as raw user
commands. Verbatim mode preserves the exact Claude JSONL as one inert context
item. Both modes retain every original byte in the immutable bridge sidecar.

Claude Desktop writes an auto-compact boundary followed by an
`isCompactSummary` record. The adapter turns that summary into a nonempty Codex
`compacted.payload.replacement_history` and appends post-boundary items once.
In semantic mode, planning fails if no summary is recoverable. Verbatim mode
keeps the original compact records as inert archival context and does not claim
native resume semantics. Both modes fail when the conservative active-context
estimate is above the pinned safe limit.

Private writes are enabled only when separate rollout, thread-index, archive
(when selected), project-identity, and Goal (when selected) bindings resolve to
the exact audited 26.721.41059 artifacts. Unknown records and newer versions
remain readable/plannable, but do not acquire write capability. Researching an
unknown/new installed build requires a user-supplied provenance manifest that
binds the live installed artifacts; it does not grant write capability until a
new audited profile is implemented and registered.

Apply takes a second full hash of the active Appx identity after Goal/journal
and sidecar setup, immediately before the first Codex target mutation. That
probe is the exact batch-start support snapshot. An application update during
the subsequent multi-session batch is outside the importer's atomicity model;
the importer does not re-hash per session.

## Target — Claude Desktop

A conversation needs **two** artifacts. Writing only the transcript leaves it invisible.

### 1. Session record (what the list is built from)

`<app-data>/Claude/claude-code-sessions/<accountId>/<deviceId>/local_<uuid>.json`

`<app-data>` is `%APPDATA%` (Windows), `~/Library/Application Support` (macOS) or `$XDG_CONFIG_HOME`, default `~/.config` (Linux) — Electron's `app.getPath("userData")`.

Observed on Windows and macOS; the Linux location follows Electron's convention but has not been checked. `--sessions-root` overrides it.

```jsonc
{
  "sessionId": "local_<uuid>",
  "cliSessionId": "<uuid>",          // → transcript file name
  "cwd": "C:\\path\\to\\project",    // → transcript folder
  "originCwd": "…",
  "createdAt": 0, "lastActivityAt": 0, "lastFocusedAt": 0,
  "model": "…", "effort": "…", "permissionMode": "…",
  "title": "…", "titleSource": "auto",
  "isArchived": false,
  "completedTurns": 0,
  "bridgeSessionIds": [], "alwaysAllowedReasons": [], "sessionPermissionUpdates": [],
  "classifierSummaryEnabled": true, "spawnSeed": {}
}
```

Only non-archived records are listed. The `<accountId>/<deviceId>` pair comes from `oauthAccount` in `~/.claude.json`; if that is missing it falls back to the directory with active records and the most recent activity. Existing records are never touched.

`cliSessionId` is not a stable identity. Continuing an imported conversation makes Claude fork it into a session of its own and rewrite that field to point at the fork, after which the record no longer looks like one this tool wrote. `sessionId` — the record's own id, and its file name — does not change, so the import history remembers the records it wrote by that instead. A repointed record is Claude's conversation and is left alone; its transcript is at `projects/<projectKey>/<its cliSessionId>.jsonl`, which is where messages sent after the import will be.

### 2. Transcript (the content)

`<claudeHome>/projects/<projectKey>/<cliSessionId>.jsonl`, where

```js
projectKey = cwd.replace(/[^a-zA-Z0-9]/g, "-")   // hashed suffix past 200 chars
```

One JSON object per line:

```jsonc
{
  "parentUuid": "<previous uuid|null>",
  "isSidechain": false,
  "userType": "external",
  "cwd": "…", "sessionId": "…", "version": "…", "gitBranch": "…",
  "type": "user" | "assistant",
  "message": { "role": "…", "content": [ /* Anthropic content blocks */ ] },
  "uuid": "…", "timestamp": "ISO-8601",
  "isMeta": true,              // injected context, not authored by the user
  "customTitle": "…",          // display title (highest priority)
  "toolUseResult": { }         // raw tool payload, for rendering
}
```

Titles resolve as `customTitle` → `aiTitle` → `lastPrompt` → `summary` → first non-meta user message.

## Conversion rules

| Codex | Claude |
| --- | --- |
| `message` user | user message |
| `message` assistant | assistant message, grouped with the turn's tool calls |
| `message` developer/system, or user text wrapped in a Codex tag (`<environment_context>`, `<instructions>`, `<recommended_plugins>`, `<skills_instructions>`, `<permissions …>`, `<collaboration_mode>`, `<app-context>`, `<codex_delegation>`, …) | user message with `isMeta: true` |
| `<codex_delegation>` specifically | the wrapper stays `isMeta`, but its `<input>` becomes the user message — it is all a delegated thread has in place of a first prompt |
| `<oai-mem-citation>` at the end of an assistant reply | a readable `isMeta` line after the reply — see below |
| `reasoning` | `thinking` block (opt-in) |
| `*_call` | `tool_use` block — `name` falls back to the item type; `input` is coerced to an object |
| `*_output` | `tool_result` block — content falls back across `output` / `result` / `tools` / `content` |

### Memory citations

When Codex answers from its memory files it appends one block as the last thing in the reply, as instructed by a `developer` message ("Use this exact structure for programmatic parsing"):

```
<oai-mem-citation>
<citation_entries>
MEMORY.md:46-53|note=[evidence artifact handling context]
</citation_entries>
<rollout_ids>
019f4f03-c457-7043-a408-9b54025c6e0c
</rollout_ids>
</oai-mem-citation>
```

It is not an item type. It arrives as plain text inside an assistant `output_text` block, and Codex Desktop parses it back out, so the tags are never on screen there.

**Claude has no citation form to convert it into.** Transcript lines carry no citation field — the ones that exist are `firstPrompt`, `agentName`, `customTitle`, `aiTitle`, `summary`, `lastPrompt`, `gitBranch`, `relocated`, `isSidechain` — and the `citations` array the Messages API puts on text blocks has no renderer: in the bundled Claude Code 2.1.219 build the string appears only in Bedrock model definitions and in bundled API documentation. The known content-block types (`tool_use`, `mcp_tool_result`, `search_result`, `web_search_tool_result`, `tool_reference`, `compaction`, …) have no citation among them either.

So it is treated like everything else that is real content authored by neither side: lifted out of the reply and re-emitted as an `isMeta` line, the shape sub-agent reports get.

```
[pass-the-thread] Codex cited its memory here:
  MEMORY.md:46-53 — evidence artifact handling context
  conversation 019f4f03-c457-7043-a408-9b54025c6e0c
```

The `developer` message that *defines* the format is untouched; it is already `isMeta`, and it is an instruction rather than a citation.

## Replay invariants

A transcript can load in the UI and still fail on the next turn with a 400. Every conversion is validated before writing, and repairs these:

- `tool_use.input` must be an object — a JSON string or array is rejected.
- Every `tool_use` must be answered by a `tool_result` with the same id **in the next message**. Multiple calls in one turn are answered in one user message; calls with no recorded output get a synthesized error result.
- A `tool_result` whose `tool_use` never appeared (compacted history) is demoted to text.
- No empty message content, no empty text blocks.
- The transcript starts with a user message, and `parentUuid` forms one chain.

`src/validate.ts` encodes these; the import path refuses to write a transcript that violates them.
