import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import {
  createEnvelope,
  deterministicId,
  sha256Utf8,
  stableStringify,
  verifyEnvelope,
  type RawEnvelope,
} from "./envelope.ts";
import type { BridgeBundle, BridgeConversation, BridgeOperation } from "./ir.ts";

interface StoredRawObject {
  version: 1;
  contentSha256: string;
  raw: string;
  lineEnding: RawEnvelope["lineEnding"];
}

interface StoredEnvelopeRef {
  version: 1;
  id: string;
  source: RawEnvelope["source"];
  sourcePath: string;
  recordIndex: number;
  contentSha256: string;
}

interface StoredConversation {
  version: 1;
  contentSha256: string;
  conversation: BridgeConversation;
  envelopes: StoredEnvelopeRef[];
}

interface StoredLatestConversation {
  version: 1;
  conversationId: string;
  contentSha256: string;
}

export interface StoreResult {
  conversationPath: string;
  objectsWritten: number;
  objectsReused: number;
  operation: BridgeOperation;
}

export function defaultBridgeRoot(home = os.homedir()): string {
  // Keep the predecessor path so existing sidecars remain discoverable. The
  // schema itself is provider neutral and can back more adapters later.
  return path.join(home, ".codex-to-claude", "bridge-v1");
}

function safeKey(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? value
    : deterministicId("bridge-store-key-v1", value);
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid SHA-256 object key: ${value}`);
}

export function objectPath(root: string, contentSha256: string): string {
  assertSha256(contentSha256);
  return path.join(root, "objects", `${contentSha256}.json`);
}

export function conversationPath(root: string, conversationId: string): string {
  return path.join(root, "conversations", safeKey(conversationId), "latest.json");
}

export function conversationRevisionPath(
  root: string,
  conversationId: string,
  contentSha256: string,
): string {
  assertSha256(contentSha256);
  return path.join(root, "conversations", safeKey(conversationId), "revisions", `${contentSha256}.json`);
}

export function operationPath(root: string, operationId: string): string {
  return path.join(root, "operations", `${safeKey(operationId)}.json`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.rmSync(temporary);
    } catch {
      // Rename already consumed it, or the write failed before creating it.
    }
  }
}

function parseJsonFile<T>(filePath: string, label: string): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read bridge ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Invalid bridge ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rawObjectFor(envelope: RawEnvelope): StoredRawObject {
  return {
    version: 1,
    contentSha256: envelope.contentSha256,
    raw: envelope.raw,
    lineEnding: envelope.lineEnding,
  };
}

function verifyRawObject(object: StoredRawObject, expectedSha256: string): void {
  if (
    object == null ||
    object.version !== 1 ||
    typeof object.raw !== "string" ||
    (object.lineEnding !== "" && object.lineEnding !== "\n" && object.lineEnding !== "\r\n")
  ) {
    throw new Error(`Invalid raw object for ${expectedSha256}`);
  }
  const actual = sha256Utf8(object.raw + object.lineEnding);
  if (object.contentSha256 !== expectedSha256 || actual !== expectedSha256) {
    throw new Error(`Raw object hash mismatch for ${expectedSha256}`);
  }
}

function envelopeRef(envelope: RawEnvelope): StoredEnvelopeRef {
  return {
    version: 1,
    id: envelope.id,
    source: envelope.source,
    sourcePath: envelope.sourcePath,
    recordIndex: envelope.recordIndex,
    contentSha256: envelope.contentSha256,
  };
}

function conversationPayloadHash(
  conversation: BridgeConversation,
  envelopes: StoredEnvelopeRef[],
): string {
  return sha256Utf8(stableStringify({ version: 1, conversation, envelopes }));
}

function validateBundle(bundle: BridgeBundle): void {
  const ids = new Set<string>();
  for (const envelope of bundle.envelopes) {
    verifyEnvelope(envelope);
    if (ids.has(envelope.id)) throw new Error(`Duplicate envelope id: ${envelope.id}`);
    ids.add(envelope.id);
  }
  if (
    bundle.conversation.recordEnvelopeIds.length !== bundle.envelopes.length ||
    bundle.conversation.recordEnvelopeIds.some((id, index) => id !== bundle.envelopes[index]?.id)
  ) {
    throw new Error("Conversation record envelope order does not match the supplied envelopes");
  }
  for (const event of bundle.conversation.events) {
    if (!ids.has(event.sourceEnvelopeId)) {
      throw new Error(`Event ${event.id} refers to missing envelope ${event.sourceEnvelopeId}`);
    }
  }
  const reconstructedSourceSha256 = sha256Utf8(
    bundle.envelopes.map((envelope) => envelope.raw + envelope.lineEnding).join(""),
  );
  if (bundle.conversation.sourceContentSha256 !== reconstructedSourceSha256) {
    throw new Error("Conversation source content hash does not match the supplied envelopes");
  }
}

function writeOperation(root: string, operation: BridgeOperation): void {
  atomicWrite(operationPath(root, operation.id), serialize(operation));
}

/** Persist a conversation manifest and content-addressed raw source objects. */
export function writeBridgeConversation(root: string, bundle: BridgeBundle): StoreResult {
  validateBundle(bundle);
  fs.mkdirSync(path.join(root, "objects"), { recursive: true });
  fs.mkdirSync(path.join(root, "conversations"), { recursive: true });
  fs.mkdirSync(path.join(root, "operations"), { recursive: true });

  let objectsWritten = 0;
  let objectsReused = 0;
  const handled = new Set<string>();
  for (const envelope of bundle.envelopes) {
    if (handled.has(envelope.contentSha256)) continue;
    handled.add(envelope.contentSha256);
    const target = objectPath(root, envelope.contentSha256);
    if (fs.existsSync(target)) {
      verifyRawObject(parseJsonFile<StoredRawObject>(target, "object"), envelope.contentSha256);
      objectsReused += 1;
      continue;
    }
    atomicWrite(target, serialize(rawObjectFor(envelope)));
    objectsWritten += 1;
  }

  const envelopeRefs = bundle.envelopes.map(envelopeRef);
  const conversationSha256 = conversationPayloadHash(bundle.conversation, envelopeRefs);
  const stored: StoredConversation = {
    version: 1,
    contentSha256: conversationSha256,
    conversation: bundle.conversation,
    envelopes: envelopeRefs,
  };
  const target = conversationRevisionPath(root, bundle.conversation.id, conversationSha256);
  const serialized = serialize(stored);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== serialized) {
    throw new Error(`immutable bridge revision changed: ${target}`);
  }
  if (!fs.existsSync(target)) {
    atomicWrite(target, serialized);
  }
  atomicWrite(conversationPath(root, bundle.conversation.id), serialize({
    version: 1,
    conversationId: bundle.conversation.id,
    contentSha256: conversationSha256,
  } satisfies StoredLatestConversation));

  const operation: BridgeOperation = {
    version: 1,
    id: deterministicId("bridge-operation-v1", {
      kind: "store_conversation",
      conversationId: bundle.conversation.id,
      conversationSha256,
    }),
    kind: "store_conversation",
    conversationId: bundle.conversation.id,
    conversationSha256,
    status: "completed",
  };
  const opTarget = operationPath(root, operation.id);
  const opSerialized = serialize(operation);
  if (!fs.existsSync(opTarget) || fs.readFileSync(opTarget, "utf8") !== opSerialized) {
    writeOperation(root, operation);
  }
  return { conversationPath: target, objectsWritten, objectsReused, operation };
}

/** Read and hash-verify every object before returning a reconstructed bundle. */
export function readBridgeConversation(
  root: string,
  conversationId: string,
  revisionSha256?: string,
): BridgeBundle {
  let revision = revisionSha256;
  if (revision == null) {
    const latest = parseJsonFile<StoredLatestConversation>(conversationPath(root, conversationId), "latest pointer");
    if (
      latest?.version !== 1 || latest.conversationId !== conversationId ||
      typeof latest.contentSha256 !== "string"
    ) throw new Error(`Invalid bridge latest pointer for ${conversationId}`);
    revision = latest.contentSha256;
  }
  const stored = parseJsonFile<StoredConversation>(
    conversationRevisionPath(root, conversationId, revision),
    "conversation revision",
  );
  if (stored == null || stored.version !== 1 || !Array.isArray(stored.envelopes)) {
    throw new Error(`Invalid bridge conversation manifest for ${conversationId}`);
  }
  if (stored.conversation?.id !== conversationId) {
    throw new Error(`Bridge conversation id mismatch: expected ${conversationId}`);
  }
  const actualConversationSha256 = conversationPayloadHash(stored.conversation, stored.envelopes);
  if (stored.contentSha256 !== actualConversationSha256 || revision !== actualConversationSha256) {
    throw new Error(`Bridge conversation manifest hash mismatch for ${conversationId}`);
  }
  const envelopes = stored.envelopes.map((ref) => {
    if (ref == null || ref.version !== 1 || typeof ref.contentSha256 !== "string") {
      throw new Error(`Invalid envelope reference in conversation ${conversationId}`);
    }
    const object = parseJsonFile<StoredRawObject>(objectPath(root, ref.contentSha256), "object");
    verifyRawObject(object, ref.contentSha256);
    const envelope = createEnvelope(ref.source, object.raw, {
      sourcePath: ref.sourcePath,
      recordIndex: ref.recordIndex,
      lineEnding: object.lineEnding,
    });
    if (envelope.id !== ref.id) throw new Error(`Envelope id mismatch for ${ref.id}`);
    return envelope;
  });
  const bundle = { conversation: stored.conversation, envelopes };
  validateBundle(bundle);
  return bundle;
}
