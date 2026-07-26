# Pass the Thread CLI

```
threadpass list    [options] [--json]
threadpass import  [options] [--dry-run] [--force]
threadpass fix     [--dry-run] [--prune]
threadpass scan    [selection]
threadpass plan    [selection] --evidence <manifest.json> --out <plan.json>
threadpass apply   --plan <plan.json> --confirm <digest> --evidence <manifest.json>
threadpass recover --operation <id> --evidence <manifest.json>
```

Without a global install, that is:

```bash
node --experimental-strip-types --experimental-sqlite src/threadpass.ts list
```

## Pass flags to node, not through npm

npm has its own `--dry-run` and `--force`, and consumes them instead of
forwarding them to the script — `npm run import -- --dry-run` reached the tool
as a plain `import` and wrote for real. It now detects the swallowed flag and
refuses, and `npm run import:dry` has the flag baked in. Everything else belongs
on a direct `node src/threadpass.ts` invocation.

## Commands

`list` prints the per-project breakdown and the conversations that would be
imported. Read-only.

`import` converts and writes. Re-runs are safe: imports are deduplicated by
source hash and render mode, and a conversation is never registered twice.

`fix` cleans up transcripts that Claude duplicated. Opening an imported
conversation makes Claude append the history it replayed, so every message
shows twice. `fix` collapses that without re-converting. Messages you really
did repeat are kept, since their timestamps differ. It also re-syncs titles from
the transcripts, and reports records left behind for conversations no longer
imported — `--prune` removes those.

## Experimental bidirectional matrix

These commands use the same shared conversion core as the legacy Codex → Claude
flow. `codex-to-claude` remains an executable alias for compatibility.

```text
threadpass scan  [selection]
threadpass plan  [selection] --render-mode <mode> --goal-mode <mode> --evidence <manifest.json> --out <plan.json>
threadpass apply --plan <plan.json> --confirm <digest> --evidence <manifest.json>
threadpass recover --operation <id> --evidence <manifest.json>
```

Codex → Claude uses the same commands with `--direction codex-to-claude`:

```text
threadpass plan --direction codex-to-claude [selection] --workspace-dir <account/device> --out <plan.json>
threadpass apply --plan <plan.json> --confirm <digest> [--dry-run] [--allow-overwrite]
threadpass recover --operation <id>
```

`scan` and `plan` are read-only with respect to Codex and Claude data. With no
archive option, `scan` inventories active and archived records; `plan` safely
defaults to active. A plan's SHA-256 digest binds the selected source revisions,
render mode, canonical Codex home and database, audited target hashes, generated
thread IDs, rollout paths/hashes, active-context upper bounds, Goal source hash,
Goal target thread/readback, and target capability fingerprint. `apply`
rebuilds all of it and refuses if any binding changed.

The forward plan additionally binds the typed renderer fingerprint, exact
semantic or verbatim output hashes, target transcript, Claude account/device
wrapper and their plan-time hashes. Semantic mode renders supported messages,
reasoning, images and valid tool pairs. Task notifications become readable
`isMeta` history; access, world-state, protocol and unknown controls remain only
in the lossless sidecar, never accidental user text. Verbatim mode puts the
byte-exact UTF-8 source in one inert metadata record. Goal controls are appended
through the native Claude Goal adapter; `skip` still retains inert Goal history.

Forward `--dry-run` refuses `--out` and creates no directory, sidecar, journal,
backup, transcript or wrapper. A real apply preflights every selected target,
stores canonical sources, creates immutable content-hash backups for all
existing targets, and only then begins target mutation. Existing targets need
both `--allow-overwrite` and the unchanged plan-time SHA-256 proof. The durable
batch journal reconciles write-before-journal crash windows by exact before/after
hash; `recover --operation <id>` rolls an uncommitted batch back and refuses
committed history. Archived Codex sessions produce archived Claude wrappers.
If no Claude workspace can be resolved, plan with `--no-register` explicitly;
the transcript will not appear in Claude Desktop. Active context after the last
portable compact boundary is capped at 1,000,000 serialized characters and
fails closed instead of creating a conversation that cannot resume.

`recover` is the only supported interrupted-write cleanup path. It revalidates
the exact installed Codex build, requires Codex Desktop to be closed, obtains
the same exclusive target lock, verifies rollout ownership before changing the
database, and records the recovered attempt. If a Goal RPC may have crossed its
commit boundary, recovery first performs native `thread/goal/get`: an exact
readback rolls forward, an absent Goal permits importer-artifact cleanup, and a
differing Goal stops without clearing or overwriting it. A later `apply` starts a new
validated attempt without discarding earlier attempt history.

Selection options:

| Option | Values / meaning |
| --- | --- |
| `--archive` | `active` (default), `archived`, or `all` |
| `--project-scope` | `all`, `projects`, `projectless`, or `existing-targets` |
| `--session <id>` | exact Codex Desktop wrapper session id shown by `scan`; repeat for an OR-list |
| `--project <name-or-path>` | exact target project name or canonical root; repeat for an OR-list |
| `--from-date`, `--to-date` | inclusive ISO date/time bounds |
| `--limit <n>` | explicit newest-first cap; omitted means no cap |
| `--workspace-dir` | exact Claude Desktop account/device record directory |
| `--claude-home`, `--codex-home`, `--sessions-root` | override detected roots |
| `--out <path>` | JSON output file; omitted or `-` writes stdout; forbidden by forward `apply --dry-run` |
| `--render-mode <mode>` | `semantic` (default) or `verbatim`; included in the plan digest |
| `--goal-mode <mode>` | `migrate` (default) or `skip`; independent of render mode and included in the digest |
| `--no-migrate-goal` | alias for `--goal-mode skip`; conflicting flags are rejected |
| `--allow-overwrite` | forward apply only: authorize overwrite after exact unchanged-target proof |
| `--dry-run` | forward apply only: rebuild and validate the confirmed plan with zero mutation |

Apply requirements:

- Windows and the exact audited Codex Desktop Electron build `26.721.41059`;
- Codex Desktop fully closed;
- `--confirm` exactly equal to the saved plan digest;
- `--evidence reference/codex-desktop/26.721.41059/manifest.json`;
- unchanged Claude wrapper records and transcripts.

The evidence loader independently resolves the active Appx package and hashes
its live artifacts. Unknown or changed binaries fail closed. Apply obtains one
exclusive lock for the target, preflights every session before the first target
write, and treats an exact previous result as already applied. Each committed
session gets a bridge sidecar and operation journal. An unexpected runtime or
I/O failure can still leave earlier session transactions committed, so inspect
the plan and loss report before confirmation.

For Claude → Codex, live Goal activation uses only the audited 41059
`codex.exe app-server --stdio --enable goals` methods. The target thread is
registered first, then `thread/goal/get` must be absent or exactly idempotent,
`thread/goal/set` is issued, and a fresh-process `thread/goal/get` must match the
confirmed objective, active status, and portable budget. Provider counters are
not treated as equivalent. The unconditional `thread/goal/clear` RPC is never a
recovery primitive because it has no Goal id or compare-and-clear precondition.
See the [runtime evidence](research/codex-desktop/26.721.41059/GOAL_RPC.md).

## Selecting conversations

| Flag | Imports |
| --- | --- |
| *(default)* | everything the Codex Desktop sidebar shows |
| `--projects-only` | only conversations in a project |
| `--projectless-only` | only the Recents ones |
| `--project <name>` | one project, by Codex name or path |
| `--include-archived`, `--archived-only` | include or restrict to archived threads |
| `--interactive-only` | drop `codex exec` automation runs |
| `--since-days <n>`, `--max <n>`, `--from <d>`, `--to <d>`, `--id <id>` | further limits |

## Import options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | | print the plan, write nothing |
| `--title-prefix <s>` | | prefix titles, e.g. `"[Codex] "` |
| `--include-reasoning` | off | keep Codex reasoning as `thinking` blocks |
| `--full-history` | off | every turn instead of Codex's compacted context |
| `--render-mode <mode>` | `semantic` | `semantic` converts supported structures; `verbatim` renders the complete source rollout as inert historical text |
| `--max-tool-output <n>` | 4000 | cap on each tool result, in characters |
| `--max-chars <n>` | 1000000 | cap on a whole transcript |
| `--include-empty` | off | keep threads you never wrote in |
| `--force` | | re-import, and refresh records this tool wrote |
| `--no-register` | off | transcript only, so it will not be listed |
| `--model <id>` | `claude-opus-5` | model recorded for resumed sessions |
| `--version-tag <s>` | | `version` field written into transcript lines |
| `--codex-home`, `--claude-home`, `--sessions-root` | standard paths | override source and targets |
| `--bridge-root <path>` | `~/.codex-to-claude/bridge-v1` | content-addressed canonical source sidecars |
| `--json` | off | machine-readable `list` output |

`verbatim` is the canonical-preservation escape hatch. It reads the source
rollout without modifying it, strictly decodes its UTF-8 bytes without trimming
or newline normalization, and places that exact text in an `isMeta` Claude
message. Tool-looking JSON, task notifications, goals, and permission text
therefore remain visible history and never become active Claude controls. The
default `semantic` mode remains preferable when a resumable, rendered
conversation matters more than preserving the source representation verbatim.
The matrix command applies the same contract in reverse: exact Claude JSONL is
placed into an inert Codex historical-context item. In both directions the
source file is never rewritten, and the matrix also stores the exact source
revision in its content-addressed bridge sidecar.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done |
| 1 | unknown command, or no command given |
| 2 | npm swallowed a flag; nothing ran |
