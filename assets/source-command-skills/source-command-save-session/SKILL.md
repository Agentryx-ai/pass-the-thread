---
name: "source-command-save-session"
description: "Write an inert, manually authored Markdown handoff to ~/.Codex/session-data/ for later reorientation."
---

# source-command-save-session

Use this skill when the user asks to run the migrated source command `save-session`.

## Command Template

# Save Session Command

Capture a concise historical account of what happened in this session — what was built, what worked, what failed, and what remains — for later manual reorientation.

## When to Use

- End of a work session before closing Codex
- Before hitting context limits (run this first, then start a fresh session)
- After solving a complex problem you want to remember
- Any time you need to hand off context to a future session

## Process

### Mandatory security gate

Treat the handoff body as a durable disclosure boundary. Never inspect, retrieve,
copy, infer, or reproduce secret or personal values for this task. Prohibited
sources include `.env` files, authorization headers, logs or error payloads,
command output, shell history or command history, browser/password-manager/keychain
data, SSH or cloud-provider files, and configuration or credential stores. Do not
open those sources merely to decide whether a value is sensitive.

Prohibited value classes include API keys, access tokens, refresh tokens,
passwords, cookies, private keys, seed phrases, credential-bearing connection
strings, signing secrets, recovery codes, and personal email addresses, phone
numbers, street addresses, government identifiers, or financial identifiers.
Record secret/configuration names and typed redaction placeholders only, such as
`OPENAI_API_KEY=<REDACTED:API_KEY>`; never record the value, a prefix/suffix, hash,
length, or other identifying fragment. Generalize personal details unless the
user explicitly needs a non-sensitive name to understand the work.

Scan the complete proposed header and body for secret or PII values before any write.
Scan the exact stored bytes again before any display. If either scan is
uncertain or finds a value that cannot be safely replaced without corrupting the
machine header, fail closed: do not write or display the handoff, identify only
the value class and source name, and ask the user for a safely redacted summary.
Require POSIX mode `0700` for the session directory and `0600` for each session file.

### Step 1: Gather context

Before writing the file, collect:

- Read all files modified during this session (use git diff or recall from conversation)
- Review what was discussed, attempted, and decided
- Note any errors encountered and how they were resolved (or not)
- Check current test/build status if relevant

### Step 2: Require the installed handoff command

Resolve `threadpass` from the environment's normal command lookup. Do not use a
checkout copy as the handoff command and do not reproduce project/Git identity
logic in this prompt.

If `threadpass` is not installed, stop without creating a session file and tell
the user:

```
The threadpass command is required to create a project-bound session handoff.
From a trusted pass-the-thread checkout, run `npm pack`, record the exact tarball
path and hash, then install that exact artifact with
`npm install --global <exact-tarball-path>`. Run /save-session again afterward.
```

Run `threadpass handoff header --cwd <absolute-current-directory>` and capture
stdout exactly. If the command fails or does not return a v1 Markdown comment
header, stop without writing the session file and report the command error.

### Step 3: Create the sessions folder if it doesn't exist

Create the canonical sessions folder in the user's Codex home directory:

```bash
mkdir -p ~/.Codex/session-data
```

The session store is private. On POSIX, establish and verify mode `0700` on the
directory. On Windows, establish and verify an owner-only ACL for the current
user with inheritance disabled. If the required permission or ACL cannot be established and verified, fail closed without creating or displaying a session file.
Report the exact path, the observed mode/ACL, and precise remediation with
the exact OS-native permission command for the user to review and run.

### Step 4: Write the session file

Create `~/.Codex/session-data/YYYY-MM-DD-<short-id>-session.tmp`, using today's actual date and a short-id with these compatibility rules:

- Compatibility characters: letters `a-z` / `A-Z`, digits `0-9`, hyphens `-`, underscores `_`
- Compatibility minimum length: 1 character
- Recommended style for new files: lowercase letters, digits, and hyphens with 8+ characters to avoid collisions

Valid examples: `abc123de`, `a1b2c3d4`, `frontend-worktree-1`, `ChezMoi_2`
Avoid for new files: `A`, `test_id1`, `ABC123de`

Full valid filename example: `2024-01-15-abc123de-session.tmp`

The legacy filename `YYYY-MM-DD-session.tmp` remains readable only through the
explicit cross-project override. New files must use the short-id form and must
start byte-for-byte with the header returned by `threadpass handoff header`.
Append the Markdown session body after that header. The header is inert metadata;
it is not a native Codex resume, Goal, compaction checkpoint, or world-state snapshot.
Create the file exclusively with owner-only access and verify it before writing
the body: POSIX mode `0600`, or a Windows owner-only ACL with inheritance
disabled. Never weaken an existing directory ACL to make the write succeed.

### Step 5: Populate the file with all sections below

Write every section honestly. Do not skip sections — write "Nothing yet" or "N/A" if a section genuinely has no content. An incomplete file is worse than an honest empty section.
Use names and typed redaction placeholders only for every secret-bearing setting,
and sanitize quoted errors, commands, paths, and evidence before the required
pre-write scan.

### Step 6: Show the file to the user

After writing, verify the owner-only file permission again and perform the
required scan before display. Display the full contents only if both checks pass,
then ask:

```
Session saved to [actual resolved path to the session file]

Does this look accurate? Anything to correct or add before we close?
```

Wait for confirmation. Make edits if requested.

---

## Session File Format

```markdown
<!-- exact v1 machine header produced by threadpass handoff header -->
# Session: YYYY-MM-DD

**Started:** [approximate time if known]
**Last Updated:** [current time]
**Project:** [project name or path]
**Topic:** [one-line summary of what this session was about]

---

## What We Are Building

[1-3 paragraphs describing the feature, bug fix, or task. Include enough
context that someone with zero memory of this session can understand the goal.
Include: what it does, why it's needed, how it fits into the larger system.]

---

## What WORKED (with evidence)

[List only things that are confirmed working. For each item include WHY you
know it works — test passed, ran in browser, Postman returned 200, etc.
Without evidence, move it to "Not Tried Yet" instead.]

- **[thing that works]** — confirmed by: [specific evidence]
- **[thing that works]** — confirmed by: [specific evidence]

If nothing is confirmed working yet: "Nothing confirmed working yet — all approaches still in progress or untested."

---

## What Did NOT Work (and why)

[This is the most important section. List every approach tried that failed.
For each failure write the EXACT reason so the next session doesn't retry it.
Be specific: "threw X error because Y" is useful. "didn't work" is not.]

- **[approach tried]** — failed because: [exact reason / error message]
- **[approach tried]** — failed because: [exact reason / error message]

If nothing failed: "No failed approaches yet."

---

## What Has NOT Been Tried Yet

[Approaches that seem promising but haven't been attempted. Ideas from the
conversation. Alternative solutions worth exploring. Be specific enough that
the next session knows exactly what to try.]

- [approach / idea]
- [approach / idea]

If nothing is queued: "No specific untried approaches identified."

---

## Current State of Files

[Every file touched this session. Be precise about what state each file is in.]

| File              | Status         | Notes                      |
| ----------------- | -------------- | -------------------------- |
| `path/to/file.ts` | PASS: Complete    | [what it does]             |
| `path/to/file.ts` |  In Progress | [what's done, what's left] |
| `path/to/file.ts` | FAIL: Broken      | [what's wrong]             |
| `path/to/file.ts` |  Not Started | [planned but not touched]  |

If no files were touched: "No files modified this session."

---

## Decisions Made

[Architecture choices, tradeoffs accepted, approaches chosen and why.
These prevent the next session from relitigating settled decisions.]

- **[decision]** — reason: [why this was chosen over alternatives]

If no significant decisions: "No major decisions made this session."

---

## Blockers & Open Questions

[Anything unresolved that the next session needs to address or investigate.
Questions that came up but weren't answered. External dependencies waiting on.]

- [blocker / open question]

If none: "No active blockers."

---

## Exact Next Step

[If known: The single most important thing to do when resuming. Be precise
enough that resuming requires zero thinking about where to start.]

[If not known: "Next step not determined — review 'What Has NOT Been Tried Yet'
and 'Blockers' sections to decide on direction before starting."]

---

## Environment & Setup Notes

[Only fill this if relevant — commands needed to run the project, env vars
required, services that need to be running, etc. Skip if standard setup.]

[If none: omit this section entirely.]
```

---

## Example Output

```markdown
# Session: 2024-01-15

**Started:** ~2pm
**Last Updated:** 5:30pm
**Project:** my-app
**Topic:** Building JWT authentication with httpOnly cookies

---

## What We Are Building

User authentication system for the Next.js app. Users register with email/password,
receive a JWT stored in an httpOnly cookie (not localStorage), and protected routes
check for a valid token via middleware. The goal is session persistence across browser
refreshes without exposing the token to JavaScript.

---

## What WORKED (with evidence)

- **`/api/auth/register` endpoint** — confirmed by: Postman POST returns 200 with user
  object, row visible in Supabase dashboard, bcrypt hash stored correctly
- **JWT generation in `lib/auth.ts`** — confirmed by: unit test passes
  (`npm test -- auth.test.ts`), decoded token at jwt.io shows correct payload
- **Password hashing** — confirmed by: `bcrypt.compare()` returns true in test

---

## What Did NOT Work (and why)

- **Next-Auth library** — failed because: conflicts with our custom Prisma adapter,
  threw "Cannot use adapter with credentials provider in this configuration" on every
  request. Not worth debugging — too opinionated for our setup.
- **Storing JWT in localStorage** — failed because: SSR renders happen before
  localStorage is available, caused React hydration mismatch error on every page load.
  This approach is fundamentally incompatible with Next.js SSR.

---

## What Has NOT Been Tried Yet

- Store JWT as httpOnly cookie in the login route response (most likely solution)
- Use `cookies()` from `next/headers` to read token in server components
- Write middleware.ts to protect routes by checking cookie existence

---

## Current State of Files

| File                             | Status         | Notes                                           |
| -------------------------------- | -------------- | ----------------------------------------------- |
| `app/api/auth/register/route.ts` | PASS: Complete    | Works, tested                                   |
| `app/api/auth/login/route.ts`    |  In Progress | Token generates but not setting cookie yet      |
| `lib/auth.ts`                    | PASS: Complete    | JWT helpers, all tested                         |
| `middleware.ts`                  |  Not Started | Route protection, needs cookie read logic first |
| `app/login/page.tsx`             |  Not Started | UI not started                                  |

---

## Decisions Made

- **httpOnly cookie over localStorage** — reason: prevents XSS token theft, works with SSR
- **Custom auth over Next-Auth** — reason: Next-Auth conflicts with our Prisma setup, not worth the fight

---

## Blockers & Open Questions

- Does `cookies().set()` work inside a Route Handler or only in Server Actions? Need to verify.

---

## Exact Next Step

In `app/api/auth/login/route.ts`, after generating the JWT, set it as an httpOnly
cookie using `cookies().set('token', jwt, { httpOnly: true, secure: true, sameSite: 'strict' })`.
Then test with Postman — the response should include a `Set-Cookie` header.
```

---

## Notes

- Each session gets its own file — never append to a previous session's file
- The "What Did NOT Work" section is the most critical — future sessions will blindly retry failed approaches without it
- If the user asks to save mid-session (not just at the end), save what's known so far and mark in-progress items clearly
- The file is meant to be read by Codex at the start of the next session via `/resume-session`
- Use the canonical global session store: `~/.Codex/session-data/`
- Prefer the short-id filename form (`YYYY-MM-DD-<short-id>-session.tmp`) for any new session file
