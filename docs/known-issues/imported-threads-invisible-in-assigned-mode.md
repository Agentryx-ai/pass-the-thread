# Import-created threads are invisible to `list`/`import` in `assigned` selection mode

**Severity:** high (data-loss-adjacent — a real, non-archived Desktop conversation cannot be selected or migrated)
**Area:** `src/codex-desktop-state.ts`, `src/codex-source.ts`
**Status:** fixed

## Summary

When Codex Desktop's `.codex-global-state.json` contains a `thread-project-assignments`
map, `loadDesktopSelection` returns `mode: "assigned"` and treats that UI-state map as
the **complete** thread membership. But the real Desktop sidebar is backed by the
`threads` table in `state_*.sqlite` (`listThreads({archived:false, parentThreadId:null})`),
**not** by the global-state map. Threads that exist as `threads` rows + rollout files but
were never written into the global-state map — notably threads created by external
importers (`originator: "agentryx-session-import"`) — are shown by Codex Desktop yet
**dropped by threadpass**. No flag recovers them: `--include-archived`,
`--include-empty`, and even `--id <that id>` all operate on the already-truncated set.

## Concrete repro (observed)

Thread `dbdffb3e-9def-58d8-a0c4-113f3f05244e`, title `[Claude] 리톡 파일 복원 조건 확인`,
cwd `C:\_projects\Agentryx-ai\ReTalk`, is **loaded and visible in Codex Desktop**.

`state_5.sqlite` `threads` row (authoritative for the Desktop sidebar):

| column | value |
|---|---|
| `archived` | `0` |
| `has_user_event` | `1` |
| `source` | `vscode` (not subagent) |
| spawn-edge child? | no |
| `rollout_path` | `~/.codex/sessions/2026/07/24/rollout-...-dbdffb3e-...jsonl` (exists, 785 KB) |

It satisfies the `loadDesktopThreads` WHERE clause, which returns **680** rows on this
machine. Yet:

```console
$ threadpass list --id dbdffb3e-9def-58d8-a0c4-113f3f05244e
23 conversation(s), 0 after refinements.  []
No conversations match.

$ threadpass list --id dbdffb3e-... --include-empty
23 conversation(s), 0 after refinements.
No conversations match.
```

The population is a fixed **23** regardless of filters — the size of the global-state
map, not the 680-row thread table.

In `.codex-global-state.json`, `dbdffb3e` appears **only** under
`electron-persisted-atom-state → heartbeat-thread-permissions-by-id`. It is absent from
`thread-project-assignments` and `projectless-thread-ids`, so `assigned` mode never
enumerates it.

## Root cause

`loadDesktopSelection` ([src/codex-desktop-state.ts:135](../../src/codex-desktop-state.ts)):
when `thread-project-assignments` is present, it returns `mode: "assigned"` with
`threadProject` / `unknownThreadIds` / `projectlessThreadIds` derived purely from the
global-state JSON.

`loadDesktopSessions` ([src/codex-source.ts:319](../../src/codex-source.ts)) for the
`assigned` branch builds its id set as:

```ts
const ids = [...new Set([...selection.threadProject.keys(), ...selection.unknownThreadIds])];
const rows = loadThreadsByIds(codexHome, ids, opts);
```

So the thread population is exactly `thread-project-assignments ∪ projectless-thread-ids`.
Any `threads`-table row absent from that map — every import-created thread — is
unreachable. The `derived` branch ([src/codex-source.ts:289](../../src/codex-source.ts))
does the right thing (it calls `loadDesktopThreads`, which queries the full `threads`
table), but it only runs when the global state has **no** assignments map.

The tool's contract is "select exactly the conversations Codex Desktop shows." Desktop
shows this thread because the sidebar reads the `threads` table; threadpass's
`assigned`-mode approximation reads the UI-state map, which the importer never updates.
The two diverge precisely on import-created threads.

## Fix (applied)

Option 1, narrowed. `loadDesktopSessions`' `assigned` branch now unions the thread index
into the map-derived population instead of treating the map as complete membership, and
places the unioned rows by cwd the way `derived` mode places them.

The union is confined to the clients the map is a map of: the set of `source` values on
the mapped rows themselves. An index also holds `codex exec` runs, CLI sessions and
subagent work — 564 exec + ~300 subagent rows against 18 mapped conversations on the
machine this was found on — which Desktop does not list beside its own conversations.
Unioning the whole index traded a population that was too small for one an order of
magnitude too large (23 -> 665 selected). Taking the client set from Codex's own data
keeps the judgement out of a hardcoded client name and degrades to previous behaviour
when the map names no usable client.

Result on the reported machine: 23 -> 44 conversations, all `vscode`, no exec/subagent
rows. `dbdffb3e` (`[Claude] 리톡 파일 복원 조건 확인`) and `9cf419ea`
(`[Claude] 저희 작업진행상화을...`) are both selectable and grouped under their project.

Regression test: `test/import.test.ts` — "assigned mode selects an index thread the
assignment map never learned about".

## Suggested fix

Reconcile `assigned` mode against the `threads` table instead of trusting the map as the
complete membership. Options:

1. **Union the DB thread ids into the `assigned` population.** After building `ids` from
   the map, also pull the full non-archived, top-level, non-subagent id set from
   `loadDesktopThreads` and union it in; threads not in the map get
   `projectName = "(no project)"` / `hasProject = false` (same treatment as
   `unknownThreadIds`). This keeps sidebar-accurate project grouping while no longer
   dropping DB-present threads.
2. **Make `--id` authoritative.** When an explicit `--id` is given and the id resolves to
   a valid `threads` row + rollout, bypass the selection filter entirely. Cheap, and
   directly fixes the "I can see it in Desktop but can't target it" case.

Option 1 is the correct general fix; option 2 is a good low-risk stopgap and useful on
its own.

## Regression test

Add a fixture where `.codex-global-state.json` has a non-empty
`thread-project-assignments` **and** the `threads` table contains an extra
non-archived, top-level row absent from that map (mimicking `agentryx-session-import`).
Assert the extra thread appears in `loadDesktopSessions(..., {})` and is targetable via
`--id`.
