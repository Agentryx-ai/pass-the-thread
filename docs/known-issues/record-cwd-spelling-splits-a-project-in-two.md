# One directory becomes two sidebar projects when Codex spells its drive letter differently

**Severity:** medium (cosmetic but misleading — conversations from one project are listed under two identical-looking groups)
**Area:** `src/claude-desktop-target.ts` (`buildWrapperRecord`)
**Status:** fixed

## Summary

`C:\_projects\Agentryx-ai\Agentryx-New` appears twice in the Claude Desktop sidebar, once
with three conversations and once with the other three. Both groups are labelled
`Agentryx-New` and both point at the same folder.

```
3x  C:\_projects\Agentryx-ai\Agentryx-New   Codex import 기능 분석 / PDF 분석 보고서 작성 / Claude 웹서치 토큰 소모 분석
3x  c:\_projects\Agentryx-ai\Agentryx-New   정적 분석 담당자 ×2 / ../Baton 장점
```

Only the drive letter differs.

## Root cause

Claude Desktop groups the sidebar by the wrapper record's `cwd` **string**, so two
spellings are two projects.

Codex does not spell it consistently. Its index (`state_5.sqlite`) records `C:` for all
six of these threads, but the rollout files disagree with the index and with each other:

```
019f9b2a-0ae2  session_meta.cwd = "c:\\_projects\\Agentryx-ai\\Agentryx-New"
019f9b2a-062f  session_meta.cwd = "C:\\_projects\\Agentryx-ai\\Agentryx-New"
```

`buildWrapperRecord` was handed `s.cwdOriginal || s.cwd` — the rollout's raw spelling —
and wrote it to both `cwd` and `originCwd` verbatim.

The transcript **directory** never had this problem: it is derived from `s.cwd`, which
`normalizeCwd` ([src/paths.ts](../../src/paths.ts)) has always lowercased the drive letter
on, so all six transcripts share one directory. The record and its own transcript
directory therefore disagreed in case as well.

## Fix (applied)

`buildWrapperRecord` now runs `input.cwd` through `recordCwd` and writes the result to
both `cwd` and `originCwd`, so one folder cannot produce two groups.

`recordCwd` upper-cases the drive letter, because that is the spelling **Claude's own
sessions** use — Windows hands a process an upper-case drive as its working directory:

```
cwd="C:\_projects\Agentryx-ai\pass-the-thread"   (written by Claude Desktop itself)
cwd="C:\_projects\MeroZemory\branding"           (written by Claude Desktop itself)
```

Normalising the other way was tried first and is wrong: lower-casing would have collapsed
the imported conversations into a group of their own, separate from the ones started in
Claude in the same folder — trading a split between two imports for a split between
imports and native sessions.

`normalizeCwd` ([src/paths.ts](../../src/paths.ts)) lower-cases instead and is
deliberately left alone: it names transcript directories, where the layout is already
established and the filesystem is case-insensitive, so a record saying `C:` still resolves
into a `c---projects-...` directory.

Regression test: `test/import.test.ts` — "a record's cwd is normalized, so one directory
cannot become two projects".

## Repairing records written before the fix

Re-import the affected conversations; the refreshed record carries the normalized path:

```bash
threadpass import --id <id> --full-history --force --keep-continuation --title-prefix "[Codex] "
```

Nothing else has to be touched — the transcripts were already in the right directory.
