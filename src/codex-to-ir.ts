import fs from "node:fs";
import { createHash } from "node:crypto";

import { createEnvelope, deterministicId, type LineEnding } from "./envelope.ts";
import type { BridgeBundle } from "./ir.ts";
import { decodeCanonicalUtf8 } from "./render-mode.ts";
import type { CodexSession } from "./types.ts";

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
    const carriageReturn = newline > start && contents[newline - 1] === "\r";
    lines.push({
      raw: contents.slice(start, carriageReturn ? newline - 1 : newline),
      lineEnding: carriageReturn ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

/** Build the provider-neutral canonical sidecar for a Codex source rollout. */
export function codexRolloutToBridgeBundle(session: CodexSession): BridgeBundle {
  const bytes = fs.readFileSync(session.rolloutPath);
  let contents: string;
  try {
    contents = decodeCanonicalUtf8(bytes);
  } catch {
    throw new Error(`Codex rollout is not valid UTF-8: ${session.rolloutPath}`);
  }
  const envelopes = splitExactLines(contents).map((line, recordIndex) => createEnvelope("codex", line.raw, {
    sourcePath: session.rolloutPath,
    recordIndex,
    lineEnding: line.lineEnding,
  }));
  const sourceContentSha256 = createHash("sha256").update(bytes).digest("hex");
  if (session.sourceContentSha256 != null && session.sourceContentSha256 !== sourceContentSha256) {
    throw new Error(`Codex rollout changed after it was parsed: ${session.rolloutPath}`);
  }
  return {
    envelopes,
    conversation: {
      version: 1,
      id: session.sessionId || deterministicId("codex-conversation-v1", session.rolloutPath),
      source: "codex-rollout",
      sourcePath: session.rolloutPath,
      sourceContentSha256,
      sourceSessionId: session.sessionId || null,
      cwd: session.cwdOriginal || session.cwd || null,
      title: session.codexName || session.title || null,
      recordEnvelopeIds: envelopes.map((envelope) => envelope.id),
      // The mature Codex→Claude mapper remains authoritative for semantic
      // rendering. This manifest is the lossless raw layer and intentionally
      // does not pretend unsupported event_msg/world_state records were typed.
      events: [],
    },
  };
}
