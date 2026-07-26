// Clean an already-written transcript in place, without re-converting from Codex.
// Used when Claude has appended a replay of the history to an imported file.
import fs from "node:fs";
import { dedupeLines, repairTranscript } from "./repair.ts";
import type { ClaudeTranscriptRecord } from "./types.ts";

export interface FixResult {
  path: string;
  before: number;
  after: number;
  changed: boolean;
}

export function fixTranscriptFile(targetPath: string, dryRun = false): FixResult | null {
  let raw: string;
  try {
    raw = fs.readFileSync(targetPath, "utf8");
  } catch {
    return null;
  }
  const lines: ClaudeTranscriptRecord[] = [];
  for (const l of raw.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l) as ClaudeTranscriptRecord);
    } catch {
      return null; // not ours to touch if any line is unreadable
    }
  }
  const before = lines.length;
  const cleaned = repairTranscript(dedupeLines(lines));
  const changed = cleaned.length !== before;
  if (changed && !dryRun) {
    fs.writeFileSync(targetPath, cleaned.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }
  return { path: targetPath, before, after: cleaned.length, changed };
}
