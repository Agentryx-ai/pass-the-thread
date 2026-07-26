import { createHash } from "node:crypto";

/** Open provider/format identifier (for example `claude` or `codex`). */
export type EnvelopeSource = string;
export type LineEnding = "" | "\n" | "\r\n";

/** Exact source record plus parse metadata; unknown records remain opaque here. */
export interface RawEnvelope {
  version: 1;
  id: string;
  source: EnvelopeSource;
  sourcePath: string;
  recordIndex: number;
  raw: string;
  lineEnding: LineEnding;
  /** SHA-256 of the exact UTF-8 record bytes, including its line terminator. */
  contentSha256: string;
  parsed?: unknown;
  parseError?: string;
}

export interface EnvelopeLocation {
  sourcePath: string;
  recordIndex: number;
  lineEnding: LineEnding;
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable JSON is used only for derived IDs/manifests, never in place of raw input. */
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") {
      if (typeof item === "bigint") return item.toString();
      if (item === undefined) return null;
      return item;
    }
    if (seen.has(item)) throw new TypeError("Cannot stable-stringify a cyclic value");
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      result = item.map(visit);
    } else {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        const child = (item as Record<string, unknown>)[key];
        if (child !== undefined) out[key] = visit(child);
      }
      result = out;
    }
    seen.delete(item);
    return result;
  };
  const serialized = JSON.stringify(visit(value));
  if (serialized === undefined) throw new TypeError("Value cannot be represented as stable JSON");
  return serialized;
}

export function deterministicId(namespace: string, value: unknown): string {
  return sha256Utf8(`${namespace}\0${stableStringify(value)}`);
}

export function createEnvelope(
  source: EnvelopeSource,
  raw: string,
  location: EnvelopeLocation,
): RawEnvelope {
  const contentSha256 = sha256Utf8(raw + location.lineEnding);
  const id = deterministicId("raw-envelope-v1", {
    source,
    sourcePath: location.sourcePath,
    recordIndex: location.recordIndex,
    contentSha256,
  });
  const envelope: RawEnvelope = {
    version: 1,
    id,
    source,
    sourcePath: location.sourcePath,
    recordIndex: location.recordIndex,
    raw,
    lineEnding: location.lineEnding,
    contentSha256,
  };
  try {
    // A UTF-8 BOM belongs to the raw bytes but is not valid JSON syntax.
    envelope.parsed = JSON.parse(location.recordIndex === 0 ? raw.replace(/^\uFEFF/, "") : raw);
  } catch (error) {
    envelope.parseError = error instanceof Error ? error.message : String(error);
  }
  return envelope;
}

export function verifyEnvelope(envelope: RawEnvelope): void {
  if (envelope.version !== 1) throw new Error(`Unsupported envelope version: ${String(envelope.version)}`);
  const actual = sha256Utf8(envelope.raw + envelope.lineEnding);
  if (actual !== envelope.contentSha256) {
    throw new Error(`Raw envelope hash mismatch: expected ${envelope.contentSha256}, got ${actual}`);
  }
  const expectedId = deterministicId("raw-envelope-v1", {
    source: envelope.source,
    sourcePath: envelope.sourcePath,
    recordIndex: envelope.recordIndex,
    contentSha256: envelope.contentSha256,
  });
  if (expectedId !== envelope.id) throw new Error(`Raw envelope id mismatch: ${envelope.id}`);
}


