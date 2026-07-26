#!/usr/bin/env -S node --experimental-strip-types --experimental-sqlite
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveCodexHome, resolveClaudeHome } from "./paths.ts";
import { loadDesktopSessions } from "./codex-source.ts";
import { sourceKind } from "./codex-db.ts";
import { applyFilter } from "./filter.ts";
import { mapSessionToClaudeLines } from "./map.ts";
import {
  alreadyImported,
  inspectTarget,
  lastRecordFor,
  loadImportHistory,
  mapVerbatimRolloutToClaudeLines,
  makeHistoryRecord,
  saveImportHistory,
  sha256File,
  targetPathFor,
  transcriptPathFor,
  writeTranscript,
} from "./claude-target.ts";
import {
  buildWrapperRecord,
  countWorkspaceDirs,
  existingCliSessionIds,
  findActiveWorkspaceDir,
  findRecordFor,
  ourRecords,
  signedInWorkspaceDir,
  recordsByCliSessionId,
  refreshWrapperRecord,
  setRecordTitle,
  titleShowsCodexName,
  resolveDesktopSessionsRoot,
  writeWrapperRecord,
} from "./claude-desktop-target.ts";
import { npmSwallowedFlags, npmSwallowedMessage } from "./npm-flags.ts";
import { findContinuation } from "./continued.ts";
import { validateTranscript } from "./validate.ts";
import { fixTranscriptFile } from "./fix.ts";
import { parseRenderMode } from "./render-mode.ts";
import { codexRolloutWithGoalToBridgeBundle } from "./codex-to-ir.ts";
import { defaultBridgeRoot, writeBridgeConversation } from "./bridge-store.ts";
import type { SessionFilter } from "./types.ts";

export const LEGACY_HELP = `threadpass — import Codex CLI/Desktop sessions into Claude Code / Claude Desktop

By default this selects exactly the conversations Codex Desktop shows in its list:
it reads Codex's own index (state_*.sqlite) and replicates the Desktop filter
listThreads({archived:false, parentThreadId:null}) — i.e. non-archived, top-level
threads, excluding subagent/worker threads. (Falls back to a rollout-file scan with
the equivalent filter if no index DB is present.)

USAGE
  threadpass list   [options] [--json]
  threadpass fix    [--dry-run] [--prune]
        de-duplicate transcripts, re-sync titles from them, and report or remove
        records for conversations this tool no longer imports
  threadpass import [options] [--dry-run] [--force] [--include-reasoning] [--version-tag <s>]

SELECTION (Codex Desktop conversation-list criteria)
  --interactive-only   drop non-interactive 'codex exec' automation runs
  --include-archived   also include archived threads (Desktop hides these)
  --archived-only      only archived threads (implies --include-archived)
  --projects-only      only conversations assigned to a Codex project
  --projectless-only   only conversations with no project (Codex 'Recents')
  --include-empty      keep threads the user never wrote in (Codex hides these)
  --full-history       import every turn instead of the context Codex compacted
                       to (faithful, but may not fit Claude's context window)
  --render-mode <mode> semantic (default) converts supported structures;
                       verbatim renders the exact rollout as inert history
  --max-tool-output <n>  cap each tool result at n characters (default 4000)
  --max-chars <n>        cap the whole transcript (default 1000000); older turns
                         are dropped so a resumed conversation fits the context

OPTIONAL REFINEMENTS (off by default)
  --since-days <n>   only threads active within N days
  --max <n>          cap number of threads
  --project <substr> only threads whose cwd contains substr
  --from <date>      lower bound on last activity (ISO or YYYY-MM-DD)
  --to <date>        upper bound on last activity
  --id <sessionId>   a single thread by id

PATHS
  --codex-home <p>   default $CODEX_HOME or ~/.codex
  --claude-home <p>  default $CLAUDE_CONFIG_DIR or ~/.claude
  --bridge-root <p>  canonical source sidecars; default ~/.codex-to-claude/bridge-v1

Sessions are written to <claude-home>/projects/<encoded-cwd>/<sessionId>.jsonl and
deduped via <claude-home>/codex-import-history.json (source-content sha256).
`;

function parseDateMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
}

function toFilter(v: Record<string, string | boolean | undefined>): SessionFilter {
  return {
    // Default 0 = no age/count cut: the Codex Desktop criteria drive selection,
    // these are opt-in refinements only.
    sinceDays: v["since-days"] != null ? Number(v["since-days"]) : 0,
    max: v["max"] != null ? Number(v["max"]) : 0,
    project: typeof v["project"] === "string" ? v["project"] : undefined,
    fromMs: parseDateMs(v["from"] as string | undefined),
    toMs: parseDateMs(v["to"] as string | undefined),
    id: typeof v["id"] === "string" ? v["id"] : undefined,
    projectsOnly: v["projects-only"] === true,
    projectlessOnly: v["projectless-only"] === true,
    archivedOnly: v["archived-only"] === true,
    includeEmpty: v["include-empty"] === true,
  };
}

function fmtDate(ms: number | null): string {
  if (ms == null) return "??????????";
  return new Date(ms).toISOString().slice(0, 10);
}

export function main(argv: string[]): number {
  const swallowed = npmSwallowedFlags(argv);
  if (swallowed.length > 0) {
    process.stderr.write(npmSwallowedMessage(swallowed, argv));
    return 2;
  }

  const command = argv[0];
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(LEGACY_HELP);
    return command ? 0 : 1;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: false,
    options: {
      "codex-home": { type: "string" },
      "claude-home": { type: "string" },
      "interactive-only": { type: "boolean", default: false },
      "include-archived": { type: "boolean", default: false },
      "since-days": { type: "string" },
      max: { type: "string" },
      project: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      id: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "include-reasoning": { type: "boolean", default: false },
      "version-tag": { type: "string" },
      "title-prefix": { type: "string" },
      "no-register": { type: "boolean", default: false },
      "sessions-root": { type: "string" },
      model: { type: "string" },
      "projects-only": { type: "boolean", default: false },
      "projectless-only": { type: "boolean", default: false },
      "archived-only": { type: "boolean", default: false },
      "include-empty": { type: "boolean", default: false },
      "max-tool-output": { type: "string" },
      "max-chars": { type: "string" },
      "full-history": { type: "boolean", default: false },
      "render-mode": { type: "string" },
      "bridge-root": { type: "string" },
      prune: { type: "boolean", default: false },
    },
  });

  const codexHome = resolveCodexHome(values["codex-home"] as string | undefined);
  const claudeHome = resolveClaudeHome(values["claude-home"] as string | undefined);
  const nowMs = Date.now();
  const filter = toFilter(values as Record<string, string | boolean | undefined>);
  const renderMode = parseRenderMode(values["render-mode"] as string | undefined);
  const bridgeRoot = path.resolve(
    typeof values["bridge-root"] === "string" ? values["bridge-root"] : defaultBridgeRoot(),
  );

  const { via, sessions: all } = loadDesktopSessions(codexHome, {
    interactiveOnly: values["interactive-only"] === true,
    includeArchived:
      values["include-archived"] === true || values["archived-only"] === true,
    // Codex already compacted long sessions; replaying the full history instead
    // can exceed Claude's context window.
    useCodexCompaction: values["full-history"] !== true,
  });
  const selected = applyFilter(all, filter, nowMs);

  if (command === "list") {
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          selected.map((s) => ({
            sessionId: s.sessionId,
            cwd: s.cwd,
            rolloutPath: s.rolloutPath,
            firstTsMs: s.firstTsMs,
            lastTsMs: s.lastTsMs,
            messageCount: s.messageCount,
            model: s.model,
            title: s.codexName || s.title,
            // The first message, kept separate from the name Codex displays.
            firstMessage: s.title,
            codexName: s.codexName ?? null,
          })),
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    const byKind: Record<string, number> = {};
    for (const s of selected) {
      const k = sourceKind(s.source);
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    const kindStr = Object.entries(byKind)
      .map(([k, c]) => `${k}:${c}`)
      .join("  ");
    const viaLabel =
      via === "desktop"
        ? "Desktop sidebar state"
        : via === "db"
          ? "index DB (all top-level threads)"
          : "file scan";
    // Codex Desktop groups by project; conversations with no project are only
    // reachable through Recents, so show the split before anything is imported.
    const grouped = new Map<string, number>();
    for (const s of selected) {
      const key =
        s.hasProject === false ? "(no project)" : (s.projectName ?? "(unknown)");
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    const byProject = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `  ${String(c).padStart(3)}  ${k}`)
      .join("\n");
    process.stderr.write(
      `Codex home: ${codexHome}\nSelection: Codex Desktop conversation list (via ${viaLabel}).\n` +
        `${all.length} conversation(s), ${selected.length} after refinements.  [${kindStr}]\n\n` +
        `By project:\n${byProject}\n\n`,
    );
    if (selected.length === 0) {
      process.stderr.write("No conversations match.\n");
      return 0;
    }
    for (let i = 0; i < selected.length; i++) {
      const s = selected[i];
      const idx = String(i + 1).padStart(3, " ");
      const msgs = String(s.messageCount).padStart(4, " ");
      const kind = sourceKind(s.source).padEnd(7, " ");
      const proj = s.projectName ? `[${s.projectName}] ` : "";
      process.stdout.write(
        `${idx}. ${fmtDate(s.lastTsMs)}  ${kind}  ${msgs} msg  ${proj}${s.cwd || "(no cwd)"}\n` +
          `     ${s.sessionId}  ${s.codexName || s.title || "(untitled)"}\n`,
      );
    }
    return 0;
  }

  if (command === "import") {
    const history = loadImportHistory(claudeHome);
    const dryRun = values["dry-run"] === true;
    const force = values.force === true;
    let imported = 0;
    let skipped = 0;
    let registered = 0;
    let conflicts = 0;

    // Claude Desktop lists conversations from wrapper records, not from the
    // transcript files. Without a record an imported transcript stays invisible.
    const register = values["no-register"] !== true;
    const sessionsRoot = resolveDesktopSessionsRoot(
      values["sessions-root"] as string | undefined,
    );
    // Records live under <accountId>/<deviceId>. Ask Claude Code which account
    // is signed in rather than guessing, so a stale second account's directory
    // cannot swallow the import.
    const workspaceDir = register
      ? (signedInWorkspaceDir(sessionsRoot, claudeHome) ??
        findActiveWorkspaceDir(sessionsRoot))
      : null;
    if (
      register &&
      workspaceDir != null &&
      signedInWorkspaceDir(sessionsRoot, claudeHome) == null &&
      countWorkspaceDirs(sessionsRoot) > 1
    ) {
      process.stderr.write(
        `WARNING: several Claude accounts have session records and the signed-in one\n` +
          `could not be determined; guessing ${workspaceDir}.\n` +
          `Pass --sessions-root <dir> if the import lands under the wrong account.\n\n`,
      );
    }
    const alreadyRegistered =
      workspaceDir != null ? existingCliSessionIds(workspaceDir) : new Set<string>();
    if (register && workspaceDir == null) {
      process.stderr.write(
        `WARNING: no Claude Desktop session-record directory found under\n  ${sessionsRoot}\n` +
          `Transcripts will be written but will NOT appear in the Claude Desktop list.\n\n`,
      );
    }

    process.stderr.write(
      `Codex home:  ${codexHome}\nClaude home: ${claudeHome}\n` +
        `Render mode: ${renderMode}\n` +
        `Selection: Codex Desktop conversation list (via ${via === "desktop" ? "Desktop sidebar state" : via === "db" ? "index DB" : "file scan"}).\n` +
        `${selected.length} conversation(s) selected${dryRun ? " (dry-run)" : ""}.\n\n`,
    );

    for (const s of selected) {
      const sha = s.sourceContentSha256 ?? sha256File(s.rolloutPath);
      if (sha256File(s.rolloutPath) !== sha) {
        skipped += 1;
        process.stdout.write(`skip  ${s.sessionId}  (source rollout changed after inventory; run again)\n`);
        continue;
      }
      if (!force && alreadyImported(history, sha, renderMode)) {
        skipped += 1;
        // The transcript already exists, but it may predate registration —
        // register it so it actually shows up in the Claude Desktop list.
        if (workspaceDir != null && !alreadyRegistered.has(s.sessionId) && !dryRun) {
          const catchUp =
            renderMode === "verbatim"
              ? mapVerbatimRolloutToClaudeLines(s, {
                  titlePrefix:
                    typeof values["title-prefix"] === "string"
                      ? (values["title-prefix"] as string)
                      : undefined,
                })
              : mapSessionToClaudeLines(s, {
                  titlePrefix:
                    typeof values["title-prefix"] === "string"
                      ? (values["title-prefix"] as string)
                      : undefined,
                });
          if (catchUp.length > 0) {
            const record = buildWrapperRecord({
              cliSessionId: s.sessionId,
              cwd: s.cwdOriginal || s.cwd,
              lines: catchUp,
              title: catchUp[0]?.customTitle ?? s.codexName ?? s.title ?? "(untitled)",
              model: typeof values["model"] === "string" ? (values["model"] as string) : undefined,
              sandboxPolicy: s.sandboxPolicy,
              approvalMode: s.approvalMode,
              reasoningEffort: s.reasoningEffort,
            });
            writeWrapperRecord(workspaceDir, record);
            alreadyRegistered.add(s.sessionId);
            // Remember it here too, or a later run cannot tell this record from
            // one Claude made once Claude repoints it.
            const seen = lastRecordFor(history, s.sessionId);
            if (seen != null) {
              seen.recordSessionIds = [
                ...(seen.recordSessionIds ?? []),
                record.sessionId,
              ];
            }
            registered += 1;
            process.stdout.write(
              `skip  ${s.sessionId}  (already imported) — registered\n`,
            );
            continue;
          }
        }
        process.stdout.write(`skip  ${s.sessionId}  (already imported)\n`);
        continue;
      }
      const lines =
        renderMode === "verbatim"
          ? mapVerbatimRolloutToClaudeLines(s, {
              version:
                typeof values["version-tag"] === "string"
                  ? (values["version-tag"] as string)
                  : undefined,
              titlePrefix:
                typeof values["title-prefix"] === "string"
                  ? (values["title-prefix"] as string)
                  : undefined,
            })
          : mapSessionToClaudeLines(s, {
              version:
                typeof values["version-tag"] === "string"
                  ? (values["version-tag"] as string)
                  : undefined,
              includeReasoning: values["include-reasoning"] === true,
              titlePrefix:
                typeof values["title-prefix"] === "string"
                  ? (values["title-prefix"] as string)
                  : undefined,
              maxToolChars:
                values["max-tool-output"] != null
                  ? Number(values["max-tool-output"])
                  : undefined,
              maxChars: values["max-chars"] != null ? Number(values["max-chars"]) : undefined,
            });
      if (lines.length === 0) {
        skipped += 1;
        process.stdout.write(`skip  ${s.sessionId}  (no convertible content)\n`);
        continue;
      }
      // Never write a transcript that would fail on resume.
      const issues = validateTranscript(lines);
      if (issues.length > 0) {
        skipped += 1;
        process.stdout.write(
          `skip  ${s.sessionId}  (would not be replayable: ${issues[0].kind} @line ${issues[0].line})
`,
        );
        continue;
      }
      const { targetPath } = targetPathFor(claudeHome, s);

      // Claude appends to a transcript when the conversation is opened or
      // continued. Overwriting then destroys messages sent after the import,
      // so a transcript that changed since we wrote it is left alone.
      const prior = lastRecordFor(history, s.sessionId);
      const state = inspectTarget(targetPath, prior?.targetSha256);

      // "Changed since we wrote it" covers both a history Claude replayed into
      // the file — which --force exists to get past — and messages the user sent
      // afterwards, which nothing can bring back. Only the second is refused,
      // and --force does not override it: the flag is for replay duplicates, not
      // for discarding conversation.
      // Claude does not always continue in place: it can fork an imported
      // conversation into a session of its own and repoint the record we wrote
      // at the fork. The messages are then in a file no Codex session names, so
      // looking only at our own target would call the conversation untouched.
      const owned =
        workspaceDir != null
          ? ourRecords(workspaceDir, prior?.recordSessionIds ?? [], s.sessionId)
          : { current: null, repointed: [] };
      let continued =
        state === "modified" || state === "foreign"
          ? findContinuation(targetPath, prior?.importedAtMs)
          : null;
      let continuedIn = targetPath;
      for (const fork of owned.repointed) {
        if (continued != null) break;
        const forkPath = transcriptPathFor(claudeHome, fork.record.cwd, fork.record.cliSessionId);
        continued = findContinuation(forkPath, prior?.importedAtMs);
        if (continued != null) continuedIn = forkPath;
      }
      if (continued != null) {
        conflicts += 1;
        skipped += 1;
        const when =
          continued.firstAtMs != null
            ? new Date(continued.firstAtMs).toISOString().replace("T", " ").slice(0, 16)
            : "after the import";
        process.stdout.write(
          `skip  ${s.sessionId}  (${continued.turns} message(s) sent in Claude after the import)\n` +
            `      first was ${when}: ${JSON.stringify(continued.firstText)}\n` +
            `      they are in ${continuedIn}\n` +
            `      re-importing would leave them behind. Move that file aside first.\n`,
        );
        continue;
      }

      if (force && (state === "modified" || state === "foreign")) {
        conflicts += 1;
        process.stdout.write(
          state === "modified"
            ? `WARN  ${s.sessionId}  overwriting a transcript Claude rewrote (no messages of yours in it)
`
            : `WARN  ${s.sessionId}  overwriting a transcript this tool did not write
`,
        );
      }
      if (!force && (state === "modified" || state === "foreign")) {
        conflicts += 1;
        skipped += 1;
        process.stdout.write(
          state === "modified"
            ? `skip  ${s.sessionId}  (continued in Claude since import — use --force to overwrite)
`
            : `skip  ${s.sessionId}  (a transcript this tool did not write is already there)
`,
        );
        continue;
      }

      if (dryRun) {
        process.stdout.write(`would write  ${lines.length} lines -> ${targetPath}\n`);
        imported += 1;
        continue;
      }
      writeBridgeConversation(bridgeRoot, codexRolloutWithGoalToBridgeBundle(s, codexHome));
      const res = writeTranscript(claudeHome, s, lines);
      history.records = history.records.filter((r) => r.importedSessionId !== s.sessionId);
      // The records written for this conversation stay known across runs, so a
      // repointed one is recognisable later instead of looking like a stranger.
      const recordSessionIds = [...(prior?.recordSessionIds ?? [])];
      const historyRecord = makeHistoryRecord(s, sha, nowMs, res.sha256, renderMode);
      historyRecord.recordSessionIds = recordSessionIds;
      history.records.push(historyRecord);
      imported += 1;
      process.stdout.write(
        `import ${res.lineCount} lines (${res.bytes}b) -> ${res.targetPath}\n`,
      );

      for (const fork of owned.repointed) {
        process.stdout.write(
          `  note  ${fork.record.sessionId}.json is Claude's now (it points at ` +
            `${fork.record.cliSessionId}); left alone\n`,
        );
      }

      if (workspaceDir != null && alreadyRegistered.has(s.sessionId) && force) {
        // Refresh the record we wrote earlier so remapped fields (title,
        // permission mode, effort, turn count) take effect.
        const existing = owned.current ?? findRecordFor(workspaceDir, s.sessionId);
        if (existing) {
          if (!recordSessionIds.includes(existing.record.sessionId)) {
            recordSessionIds.push(existing.record.sessionId);
          }
          refreshWrapperRecord(
            existing.path,
            existing.record,
            buildWrapperRecord({
              cliSessionId: s.sessionId,
              cwd: s.cwdOriginal || s.cwd,
              lines,
              title: lines[0]?.customTitle ?? s.codexName ?? s.title ?? "(untitled)",
              model: typeof values["model"] === "string" ? (values["model"] as string) : undefined,
              sandboxPolicy: s.sandboxPolicy,
              approvalMode: s.approvalMode,
              reasoningEffort: s.reasoningEffort,
            }),
          );
          registered += 1;
          process.stdout.write(`  refreshed -> ${existing.record.sessionId}.json
`);
        }
      } else if (workspaceDir != null && !alreadyRegistered.has(s.sessionId)) {
        const record = buildWrapperRecord({
          cliSessionId: s.sessionId,
          cwd: s.cwdOriginal || s.cwd,
          lines,
          title: lines[0]?.customTitle ?? s.codexName ?? s.title ?? "(untitled)",
          model: typeof values["model"] === "string" ? (values["model"] as string) : undefined,
          sandboxPolicy: s.sandboxPolicy,
          approvalMode: s.approvalMode,
          reasoningEffort: s.reasoningEffort,
        });
        writeWrapperRecord(workspaceDir, record);
        recordSessionIds.push(record.sessionId);
        alreadyRegistered.add(s.sessionId);
        registered += 1;
        process.stdout.write(`  registered -> ${record.sessionId}.json\n`);
      }
    }

    if (!dryRun) saveImportHistory(claudeHome, history);
    process.stderr.write(
      `\nDone. imported=${imported} skipped=${skipped} registered=${registered}` +
        (conflicts > 0 ? ` conflicts=${conflicts}` : "") +
        `\n` +
        (conflicts > 0
          ? force
            ? `${conflicts} conversation(s) had local changes and were overwritten (--force).\n`
            : `${conflicts} conversation(s) left untouched because they changed after import.\n`
          : "") +
        (registered > 0
          ? `Restart Claude Desktop to see the imported conversations.\n`
          : ""),
    );
    return 0;
  }

  if (command === "fix") {
    // Claude appends the history it replayed when an imported conversation is
    // opened, leaving every message twice. Collapse that without re-converting.
    const history = loadImportHistory(claudeHome);
    const dryRun = values["dry-run"] === true;
    const prune = values["prune"] === true;
    const seenPaths = new Set<string>();
    let scanned = 0;
    let repaired = 0;
    let removed = 0;
    for (const rec of history.records) {
      const s = all.find((x) => x.sessionId === rec.importedSessionId);
      if (!s) continue;
      const { targetPath } = targetPathFor(claudeHome, s);
      if (seenPaths.has(targetPath)) continue;
      seenPaths.add(targetPath);
      const res = fixTranscriptFile(targetPath, dryRun);
      if (res == null) continue;
      scanned += 1;
      if (res.changed) {
        repaired += 1;
        removed += res.before - res.after;
        process.stdout.write(
          `${dryRun ? "would fix" : "fixed"}  ${res.before} -> ${res.after} lines  ${targetPath}\n`,
        );
      }
    }
    // A record can drift from the transcript it points at: a title corrected in
    // a later version otherwise only reaches the list on a full re-import.
    const fixSessionsRoot = resolveDesktopSessionsRoot(
      values["sessions-root"] as string | undefined,
    );
    const wsDir =
      signedInWorkspaceDir(fixSessionsRoot, claudeHome) ??
      findActiveWorkspaceDir(fixSessionsRoot);
    let retitled = 0;
    let orphaned = 0;
    if (wsDir != null) {
      const records = recordsByCliSessionId(wsDir);
      const importable = new Map(selected.map((x) => [x.sessionId, x]));
      // Scan the records themselves, not just the history: a record can outlive
      // its history entry, and then nothing points at it any more.
      const known = new Map(all.map((x) => [x.sessionId, x]));
      const candidates = [...records.keys()].filter(
        (cli) => known.has(cli) || history.records.some((r) => r.importedSessionId === cli),
      );
      for (const cliSessionId of candidates) {
        const entry = records.get(cliSessionId);
        if (entry == null) continue;

        const session = importable.get(cliSessionId);
        if (session == null) {
          // Still listed, but no longer something this tool imports (an empty
          // thread, or one outside the current filters).
          orphaned += 1;
          process.stdout.write(
            `orphan  ${JSON.stringify(String(entry.record.title).slice(0, 56))}` +
              `${prune ? "  (removed)" : "  — pass --prune to remove"}\n`,
          );
          if (prune && !dryRun) {
            try {
              fs.rmSync(entry.path);
            } catch {
              /* already gone */
            }
            const source = known.get(cliSessionId);
            if (source) {
              try {
                fs.rmSync(targetPathFor(claudeHome, source).targetPath);
              } catch {
                /* already gone */
              }
            }
          }
          continue;
        }

        const { targetPath } = targetPathFor(claudeHome, session);
        let title: string | undefined;
        try {
          const head = fs.readFileSync(targetPath, "utf8").split(/\r?\n/, 1)[0];
          title = (JSON.parse(head) as { customTitle?: string }).customTitle;
        } catch {
          title = undefined;
        }
        // A record already showing the name Codex shows is right, whatever the
        // transcript says. Transcripts written before imports learned to read
        // Codex's names hold the first message in customTitle, and re-syncing
        // from one of those would put the paragraph back over the name — the
        // downgrade the naming work exists to prevent. The prefix stays with
        // the record, since `fix` is not told which one an import used.
        const named = titleShowsCodexName(entry.record.title, session.codexName);
        if (title != null && title !== entry.record.title && !named) {
          retitled += 1;
          process.stdout.write(
            `retitle ${JSON.stringify(String(entry.record.title).slice(0, 36))}` +
              ` -> ${JSON.stringify(title.slice(0, 36))}\n`,
          );
          if (!dryRun) setRecordTitle(entry.path, entry.record, title);
        }
      }
      if (prune && !dryRun && orphaned > 0) {
        history.records = history.records.filter((r) => importable.has(r.importedSessionId));
        saveImportHistory(claudeHome, history);
      }
    }

    process.stderr.write(
      `\nScanned ${scanned} transcript(s); ${repaired} had duplicates, ` +
        `${removed} line(s) removed; ${retitled} title(s) re-synced; ` +
        `${orphaned} orphaned record(s)${dryRun ? " (dry-run)" : ""}.\n`,
    );
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${LEGACY_HELP}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
