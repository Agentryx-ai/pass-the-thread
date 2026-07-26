<div align="center">

# Pass the Thread

**Move agent conversations without flattening away the structures that make them usable.**

Provider-neutral session portability with a shared conversation IR, deterministic plans, and fidelity-aware adapters. This project succeeds `codex-to-claude`; its original Codex → Claude flow remains available through the same commands and the legacy executable alias.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen.svg)](#requirements)
[![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](./package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue.svg)](#requirements)

</div>

## ✨ What's New

*Newest first.*

The linked pull requests below are historical work from the `codex-to-claude` predecessor repository.

- 🧭 **Importer-matrix foundation** — a lossless raw-envelope store, typed historical IR, archive/project/session/date selection, deterministic plans and loss reports, and a version-gated Codex Desktop 26.721.41059 target adapter now live beside the original converter. The built-in Codex importer was audited because “50 succeeded” did not preserve native tool calls, reasoning, images, compaction, world state, or turn context in the observed targets. See the [version-pinned research](docs/research/codex-desktop/26.721.41059/README.md).
- 🧷 **A conversation you carried on in Claude is left alone** — `--force` treated "Claude replayed the history into the file" and "you answered in it" as the same kind of change and overwrote both, which cost a message. It now tells them apart and refuses the second, naming what would have been deleted and counting only lines somebody typed. Continuing an import also makes Claude fork it and repoint the record at a session of its own; those records are recognised as no longer ours, left alone rather than duplicated, and searched for messages sent there. ([#9](https://github.com/Agentryx-ai/codex-to-claude/pull/9), [#10](https://github.com/Agentryx-ai/codex-to-claude/pull/10))
- 🛑 **A dry run stays dry** — `npm run import -- --dry-run` used to import for real. npm owns `--dry-run` and `--force`, parses them as its own config and passes an empty argv on, so the flag never arrived and the write path ran. It now detects the swallowed flag and refuses; `npm run import:dry` has it baked in. ([#6](https://github.com/Agentryx-ai/codex-to-claude/pull/6))
- 🧠 **Memory citations out of the reply** — when Codex answers from its memory files it appends an `<oai-mem-citation>` block, which Codex Desktop parses back out and never shows. Imports used to end an answer with raw markup; the citation is now a readable metadata line after the reply. ([#3](https://github.com/Agentryx-ai/codex-to-claude/pull/3))
- 🏷️ **Titles the way Codex titles them** — Codex names the threads you start from the app and lists that name, not your opening message. Imports read those names from `~/.codex/session_index.jsonl`, so a conversation is called the same thing on both sides. ([#2](https://github.com/Agentryx-ai/codex-to-claude/pull/2))
- 🍎 **macOS support** — the Claude Desktop session-record store resolves per platform now instead of assuming the Windows layout, and project grouping follows current Codex Desktop builds, which dropped the thread→project map in favour of `local-projects` root paths. ([#1](https://github.com/Agentryx-ai/codex-to-claude/pull/1))

## Contents

**On this page** — [Quick start](#quick-start) · [Importer matrix](#experimental-importer-matrix) · [How it works](#how-it-works) · [Features](#features) · [Choosing conversations](#choosing-conversations) · [Requirements](#requirements) · [Safety](#safety) · [Limitations](#limitations)

**Reference** — [CLI](docs/CLI.md) · [Conversion](docs/CONVERSION.md) · [Formats](docs/FORMATS.md)

## Quick start

```bash
git clone https://github.com/Agentryx-ai/pass-the-thread
cd pass-the-thread
node --experimental-strip-types --experimental-sqlite src/threadpass.ts list
```

```console
$ threadpass list
20 conversation(s), 20 after refinements.  [vscode:19  cli:1]

By project:
    3  Agentryx
    2  ReTalk
    2  Itineva
    1  ModuBoza
    1  (no project)
    ...

$ threadpass import --dry-run          # writes nothing
$ threadpass import --title-prefix "[Codex] "
```

Restart Claude Desktop. The conversations are in the sidebar under the same
projects, and you can open and continue them.

Flags belong on `node src/threadpass.ts`, not on `npm run` — see
[CLI](docs/CLI.md#pass-flags-to-node-not-through-npm).

## Experimental importer matrix

The original Codex → Claude commands remain available. The provider matrix adds the first reverse adapter through the same `threadpass` entrypoint:

```text
Codex  ── existing converter ──► Claude
Claude ── shared IR + 41059 adapter ──► Codex
```

Start with a read-only inventory or a saved deterministic plan:

```bash
threadpass scan --archive all
threadpass plan --archive active --project-scope existing-targets \
  --render-mode semantic \
  --evidence reference/codex-desktop/26.721.41059/manifest.json \
  --out import-plan.json
```

There is no implicit 30-day or 50-session cap. Filters include exact sessions, projects, archive state, existing-target projects, date bounds, and an explicit `--limit`. Every selected source revision remains byte-exact in the bridge sidecar. `semantic` (default) renders supported meaning into the target; `verbatim` renders the entire canonical source as inert historical text. Historical task/access records and superseded Goal events always remain inert. A separately identified authoritative active Goal is restored by default in either render mode; `--goal-mode skip` keeps it as history without live activation.

Applying a plan is intentionally strict and Windows-only for this first target. It requires Codex Desktop to be closed, the exact saved plan digest, and the pinned [26.721.41059 evidence manifest](reference/codex-desktop/26.721.41059/manifest.json). The loader re-hashes the installed `app.asar` and `codex.exe`; a copied manifest by itself is not accepted as live-version evidence. See [CLI](docs/CLI.md#experimental-claude--codex-matrix).

## How it works

Claude Desktop keeps a conversation in two places, and needs both to show it:

| Layer | Location | Role |
| --- | --- | --- |
| Session record | `<app-data>/Claude/claude-code-sessions/<account>/<device>/local_<uuid>.json` | Builds the conversation list. Points at a transcript by `cliSessionId` and `cwd`. |
| Transcript | `~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl` | The conversation itself. |

Writing only a transcript leaves it invisible, so this writes both.

```
~/.codex/sessions/**/rollout-*.jsonl
        │
        ├─ select    what Codex Desktop lists
        ├─ convert   rollout items to transcript lines
        ├─ validate  replay invariants
        │
        ├──► ~/.claude/projects/<enc-cwd>/<id>.jsonl
        └──► claude-code-sessions/.../local_<uuid>.json
```

## Features

- 📋 **The same list you already see** — selection replicates the Codex Desktop sidebar, including its project grouping, so you pick from what you recognise
- 🔁 **Whole conversations, not just text** — messages, tool calls, tool results, images and sub-agent reports
- 🏷️ **Titles that read like titles** — Codex's own conversation names, and its injected boilerplate marked as metadata so it never becomes one
- 🧭 **Registered, so Claude actually lists it** — the session record is written alongside the transcript
- 🔐 **Sandbox and approval mapped** — Codex's two settings collapse into Claude's one `permissionMode`
- 📉 **Long sessions still open** — imports start from the context Codex compacted to; 39 MB of history became 6.5 MB across 20 conversations
- ✅ **Validated before writing** — every conversion is replay-checked, and one that would fail on resume is repaired or refused
- 🧾 **Semantic or verbatim, in both directions** — semantic conversion is the default; `--render-mode verbatim` keeps exact UTF-8 source text inert when canonical representation matters more than native rendering
- 🛟 **Your edits win** — a conversation you continued in Claude is skipped, not overwritten

<details>
<summary><b>What it deliberately does not do</b></summary>

Out of scope today: migrating settings, skills, plugins and MCP servers;
network/account-backed history that has no local transcript; and pretending
historical tasks, superseded goals, or grants are safe live control state. Only
the canonical current Goal can be restored, through a separately versioned and
verified target-native capability.

</details>

<details>
<summary><b>Why this is its own repository</b></summary>

It was written for Agentryx, an AI-native agent harness in development, which
needs conversation history to move between providers. It depends on the on-disk
formats of two proprietary desktop apps, and those change on someone else's
schedule. That churn is easier to handle in a small project that can be fixed
and released on its own. It works without Agentryx.

</details>

## Choosing conversations

Codex Desktop groups by project. Conversations without one appear only under
Recents, and plenty of people never look at them, so membership is a filter:

| Flag | Imports |
| --- | --- |
| *(default)* | everything the sidebar shows |
| `--projects-only` | only conversations in a project |
| `--projectless-only` | only the Recents ones |
| `--project <name>` | one project, by Codex name or path |
| `--include-archived`, `--archived-only` | include or restrict to archived threads |
| `--interactive-only` | drop `codex exec` automation runs |

`list` prints the per-project breakdown first. Further limits: `--since-days`,
`--max`, `--from`, `--to`, `--id`. Full flag reference in [CLI](docs/CLI.md).

## Requirements

Windows or macOS, and Node.js 22.6 or newer. The runtime has no production dependencies; development installs TypeScript and Node declarations for strict type checking.

Every path resolves per platform: the Claude Desktop session-record store from
`%APPDATA%`, `~/Library/Application Support` or `$XDG_CONFIG_HOME`, and
`~/.codex` and `~/.claude` from the home directory. Linux follows the same rules
but has not been run there; `--sessions-root` and `--claude-home` override any
of it.

## Safety

This writes into another application's local data, so it stays cautious.

- It creates files and deletes none. The only records it rewrites are ones it
  wrote itself, and only with `--force`.
- `--dry-run` prints every target path and writes nothing.
- If you continued an imported conversation in Claude, the transcript changed
  since the import and it is skipped, with a note.
- `--force` overrides that for a transcript Claude only rewrote — opening a
  conversation makes it replay the history back into the file — and says what it
  overwrote. It stops at a transcript holding messages you sent after the
  import, naming the first one, and does not offer to override: the flag exists
  to get past replay duplicates, not to discard conversation.
- To undo an import, delete the transcripts and the `local_*.json` records it
  created. Both are listed in its output.
- Prefer running with Claude Desktop closed.

## Limitations

- Built on undocumented internals of two proprietary desktop apps. They can
  change at any time.
- Claude → Codex writes are supported only for the exact audited Codex Desktop
  26.721.41059 artifacts and are still experimental; create and inspect a plan
  first, close Codex, and keep a backup.
- Tested on Windows 11 and macOS 26. Linux resolves the same way but has not
  been run there.
- Codex encrypts its compaction summaries, so an import shows where compaction
  happened but not what it said.
- Sub-agent threads arrive as messages, not as separate threads.
- Large rollouts are read whole. No streaming yet.

## Documentation

| | |
| --- | --- |
| [CLI](docs/CLI.md) | Commands, every flag, exit codes |
| [Conversion](docs/CONVERSION.md) | What each Codex item becomes, injected context, permissions, compaction, replay repairs |
| [Formats](docs/FORMATS.md) | The on-disk shapes both sides use, reconstructed by observation |

## Related

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), calling
  Codex from Claude Code
- [inmzhang/transession](https://github.com/inmzhang/transession), CLI session
  translation by session id
- Codex CLI `/import`, Claude into Codex

## Development

```bash
npm run verify
```

## Disclaimer

Unofficial, and not affiliated with OpenAI or Anthropic. "Codex" and "Claude"
are trademarks of their respective owners. Back up anything you care about.

## License

Apache 2.0, see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

You can use, modify and ship this, including commercially. Keep the copyright
notice and the NOTICE file, and say what you changed. The license does not
grant rights to the project's name or marks.
