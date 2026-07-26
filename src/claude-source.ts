import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { createEnvelope, sha256Utf8, type LineEnding, type RawEnvelope } from "./envelope.ts";

export interface ClaudeSourceTranscript {
  sourcePath: string;
  contentSha256: string;
  records: RawEnvelope[];
  sessionId: string | null;
  sessionIds: string[];
  cwd: string | null;
  cwds: string[];
  title: string | null;
}

interface ExactLine {
  raw: string;
  lineEnding: LineEnding;
}

function splitExactLines(contents: string): ExactLine[] {
  const lines: ExactLine[] = [];
  let start = 0;
  while (start < contents.length) {
    const newline = contents.indexOf("\n", start);
    if (newline < 0) {
      lines.push({ raw: contents.slice(start), lineEnding: "" });
      break;
    }
    const hasCarriageReturn = newline > start && contents[newline - 1] === "\r";
    lines.push({
      raw: contents.slice(start, hasCarriageReturn ? newline - 1 : newline),
      lineEnding: hasCarriageReturn ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(records: RawEnvelope[], key: string): string | null {
  for (const envelope of records) {
    const record = asRecord(envelope.parsed);
    const value = record?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function uniqueStrings(records: RawEnvelope[], key: string): string[] {
  const values = new Set<string>();
  for (const envelope of records) {
    const value = asRecord(envelope.parsed)?.[key];
    if (typeof value === "string" && value !== "") values.add(value);
  }
  return [...values].sort();
}

function titleFrom(records: RawEnvelope[]): string | null {
  const titleKeys = ["customTitle", "aiTitle", "lastPrompt", "summary"];
  for (const key of titleKeys) {
    const title = firstString(records, key);
    if (title) return title;
  }
  for (const envelope of records) {
    const record = asRecord(envelope.parsed);
    if (record?.type !== "user" || record.isMeta === true) continue;
    const origin = asRecord(record.origin);
    if (typeof origin?.kind === "string" && origin.kind !== "human") continue;
    const message = asRecord(record.message);
    const content = message?.content;
    if (typeof content === "string" && content.trim() !== "") return content.trim().slice(0, 200);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const item = asRecord(block);
      if (item?.type === "text" && typeof item.text === "string" && item.text.trim() !== "") {
        return item.text.trim().slice(0, 200);
      }
    }
  }
  return null;
}

/** Read one transcript without normalising or dropping any source record. */
export function readClaudeJsonl(sourcePath: string): ClaudeSourceTranscript {
  const bytes = fs.readFileSync(sourcePath);
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Claude transcript is not valid UTF-8: ${sourcePath}`);
  }
  const records = splitExactLines(contents).map((line, recordIndex) =>
    createEnvelope("claude", line.raw, {
      sourcePath,
      recordIndex,
      lineEnding: line.lineEnding,
    }));
  return {
    sourcePath,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    records,
    sessionId: firstString(records, "sessionId"),
    sessionIds: uniqueStrings(records, "sessionId"),
    cwd: firstString(records, "cwd"),
    cwds: uniqueStrings(records, "cwd"),
    title: titleFrom(records),
  };
}

/** Discover every Claude Code transcript; no implicit age or count cap is applied. */
export function discoverClaudeTranscripts(claudeHome: string): string[] {
  const root = path.join(claudeHome, "projects");
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(child);
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

export function scanClaudeSessions(claudeHome: string): ClaudeSourceTranscript[] {
  const sessions: ClaudeSourceTranscript[] = [];
  for (const sourcePath of discoverClaudeTranscripts(claudeHome)) {
    try {
      sessions.push(readClaudeJsonl(sourcePath));
    } catch {
      // Discovery may race with Claude rotating a file. A direct read still
      // throws; bulk scanning merely omits a path that no longer exists.
    }
  }
  return sessions;
}
