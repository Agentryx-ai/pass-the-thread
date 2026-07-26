# CLI

```
codex-to-claude list    [options] [--json]
codex-to-claude import  [options] [--dry-run] [--force]
codex-to-claude fix     [--dry-run] [--prune]
```

Without a global install, that is:

```bash
node --experimental-strip-types --experimental-sqlite src/cli.ts list
```

## Pass flags to node, not through npm

npm has its own `--dry-run` and `--force`, and consumes them instead of
forwarding them to the script — `npm run import -- --dry-run` reached the tool
as a plain `import` and wrote for real. It now detects the swallowed flag and
refuses, and `npm run import:dry` has the flag baked in. Everything else belongs
on a direct `node src/cli.ts` invocation.

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

## Experimental Claude → Codex matrix

The matrix command uses the same repository and shared conversion core; it is
not a separate successor project.

```text
node --experimental-strip-types --experimental-sqlite src/matrix-cli.ts scan  [selection]
node --experimental-strip-types --experimental-sqlite src/matrix-cli.ts plan  [selection] --render-mode <mode> --evidence <manifest.json> --out <plan.json>
node --experimental-strip-types --experimental-sqlite src/matrix-cli.ts apply --plan <plan.json> --confirm <digest> --evidence <manifest.json>
node --experimental-strip-types --experimental-sqlite src/matrix-cli.ts recover --operation <id> --evidence <manifest.json>
```

`scan` and `plan` are read-only with respect to Codex and Claude data. With no
archive option, `scan` inventories active and archived records; `plan` safely
defaults to active. A plan's SHA-256 digest binds the selected source revisions,
render mode, canonical Codex home and database, audited target hashes, generated
thread IDs, rollout paths/hashes, and active-context upper bounds. `apply`
rebuilds all of it and refuses if any binding changed.

`recover` is the only supported interrupted-write cleanup path. It revalidates
the exact installed Codex build, requires Codex Desktop to be closed, obtains
the same exclusive target lock, verifies rollout ownership before changing the
database, and records the recovered attempt. A later `apply` starts a new
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
| `--out <path>` | JSON output file; omitted or `-` writes stdout |
| `--render-mode <mode>` | `semantic` (default) or `verbatim`; included in the plan digest |

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
