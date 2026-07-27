# Duplicate project grouping case

## Verdict

The root cause is confirmed and it is a defect in **this project's import path**, not in
Codex Desktop `26.721.41059`. Drive-letter case is not normalized to one canonical
form across the producers that register a project, so the same Windows directory is
registered under two spellings and presents as two Claude projects.

This supersedes the earlier verdict in this file, which recorded the root cause as
`UNKNOWN` and framed the duplicate as a possible Codex Desktop defect awaiting a
controlled native-UI reproduction. That framing was corrected on 2026-07-28; the
superseded reasoning is retained below under "Superseded hypothesis" so the
correction is auditable.

## Confirmed cause

`src/paths.ts` forces the drive letter of every imported `cwd` to lowercase:

```ts
export function normalizeCwd(cwd: string): string {
  if (/^[A-Za-z]:/.test(cwd)) return cwd[0].toLowerCase() + cwd.slice(1);
  return cwd;
}
```

Its comment states that Claude Code stores Windows paths with a lowercase drive
letter and that lowercasing therefore prevents a separate project entry. The
measurement below contradicts that premise: Claude Code stores whichever spelling
the session's `cwd` carried, and both spellings are present on this machine. The
importer consequently manufactures a spelling that native Claude Code sessions in
the same directories do not use.

| Measurement (2026-07-28) | Value | Evidence |
| --- | ---: | --- |
| Ledger records with a lowercase drive letter | 42 of 42 | `RUNTIME` |
| Ledger records with an uppercase drive letter | 0 of 42 | `RUNTIME` |
| Codex source `cwd` spellings seen in a continued transcript | uppercase `C:\_projects\...` | `RUNTIME` |
| Literal keys in the `projects` map of `~/.claude.json` | 116 | `RUNTIME` |
| Distinct keys after folding case and separator direction | 75 | `DERIVED` |
| Key groups holding more than one spelling of one directory | 23 | `DERIVED` |
| Redundant entries beyond one per directory | 41 | `DERIVED` |
| Key groups differing by letter case alone | 21 | `DERIVED` |

Confirmed case-only pairs include the `itineva`, `DaeumKkini`, `araseo`,
`auto-play`, and `C:\_projects\Agentryx-ai` roots, for example:

```text
"C:/_projects/Agentryx-ai/itineva"   "c:/_projects/Agentryx-ai/itineva"
"C:\\_projects\\Agentryx-ai\\itineva"  "c:\\_projects\\Agentryx-ai\\itineva"
```

Separator direction (`/` versus `\`) is a second, independent duplication axis
visible in the same map. Which component wrote each individual `~/.claude.json`
key is `UNKNOWN`; what is measured is that both spellings exist for the same
directory and that the importer deterministically produces the lowercase one.

### Where the split does and does not reach

The split is confirmed in the project registry. It does **not** reach the
transcript directory on this machine: `~/.claude/projects` holds 64 project
directories with 0 case-folded duplicate groups, because NTFS folds case and
`c---projects-...` opens the directory already created as `C---projects-...`.
On a case-sensitive filesystem the same input would produce two transcript
directories. The earlier expectation that each spelling yields its own project
folder is therefore true of the registry and of case-sensitive hosts, and false
of the on-disk transcript directory here.

### How to re-measure

1. Read `~/.claude/codex-import-history.json` (schema `{version, records[]}`) and
   test each `records[].projectRoot` against `/^[a-z]:/`.
2. Read the `projects` object of `~/.claude.json`, group its keys by
   `key.split('/').join('\\').toLowerCase()`, and count groups of size > 1.
3. List `~/.claude/projects` and group directory names by `name.toLowerCase()`.

## Relocation hazard

Deriving a transcript path from the recorded `projectRoot` is unsafe even when the
spelling is canonical, because Claude Code moves a session's transcript when the
user continues it from a different directory.

| Field | Value |
| --- | --- |
| Record | `019f8a94-aa70-7b82-bfdd-b414b59aabe5` |
| Ledger `projectRoot` | `c:\_projects\Agentryx-ai\Agentryx-New` |
| Derived transcript path | `~/.claude/projects/c---projects-Agentryx-ai-Agentryx-New/019f8a94-….jsonl` — does not exist |
| Actual transcript path | `~/.claude/projects/C---projects-Agentryx-ai-agentryx/019f8a94-….jsonl` |
| Size when measured 2026-07-28 | 1,277 lines, 3,338,188 bytes, still growing |
| Distinct `cwd` values inside the transcript | 6 |
| Records whose transcript is at the derived path | 41 of 42 |

`src/claude-target.ts` derives the target through `targetPathFor` and
`transcriptPathFor`, both of which encode `cwd` directly. For this record both
return "absent". A writer that trusts that answer creates a fresh stub while a
3.3 MB live conversation continues elsewhere under the same session id. The
hazard is `RUNTIME`; that a write would actually clobber the live thread is
`DERIVED`, because no write was attempted.

## Superseded hypothesis

Retained for audit. The earlier text recorded that two same-looking project
entries were observed after import, that the empty pre-import entry had since been
archived or removed, and that the exact pair could no longer be compared — so a
single historical root cause was `UNKNOWN`. It then cited the `26.721.41059`
Electron bundle as `STATIC` evidence of a credible duplicate path in Codex Desktop:
project records carry `rootPaths`, the update/dedup surface compares path arrays as
stored, and path handling uses lexical resolution/stat checks rather than a
filesystem `realpath` identity.

That `STATIC` observation about the bundle still stands as written and is not
retracted. What is retracted is the attribution: the duplicate grouping observed on
this machine is explained by the import path's own drive-letter handling, and no
Codex Desktop defect needs to be invoked to account for it. A Codex Desktop
duplicate path remains possible but is now unsupported by anything measured here.

## Spellings that can name the same Windows directory

- `C:\repo` versus `\\?\C:\repo`;
- drive-letter or component case differences (**confirmed** as the operative cause);
- slash-direction and trailing-separator differences (**confirmed** as a second axis);
- 8.3 short names versus long names;
- junction, symlink, or `subst` aliases.

An exact string/array comparison can treat these as different even when Windows
opens the same directory. Imported target rows in the observed batch also used
extended-prefix/case spellings, so this is not merely theoretical.

## Framework mitigation

The shared `canonicalProjectIdentity` implementation:

1. strips extended Windows prefixes without changing the target;
2. resolves lexical path components;
3. uses `realpath.native` when the directory exists;
4. normalizes separators and case for comparison;
5. selects the longest existing target root;
6. does not create Codex project records during conversation import.

Consequently, the Claude → Codex adapter can attach a conversation to an existing
canonical root or leave it in Recents; it does not create a second project entry as
a side effect.

Two further requirements follow from the measurements above:

7. **Do not invent a spelling.** Case-folding is for comparison. The spelling
   written to a target must be the one that target already uses for that
   directory, discovered by lookup, never assumed from a rule of thumb.
8. **Locate by session identity, not by derived path.** Before concluding a
   transcript is absent, search the whole `projects` tree for the session id. A
   derived-path miss means "moved or not written", and those two must not be
   collapsed.
