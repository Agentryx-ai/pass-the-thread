import { DatabaseSync } from "node:sqlite";

export interface CodexThreadRegistration {
  id: string;
  rolloutPath: string;
  cwd: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  archived: boolean;
  firstUserMessage: string;
  preview: string;
  tokensUsed?: number;
}

const REQUIRED_COLUMNS = [
  "id", "rollout_path", "created_at", "updated_at", "source", "model_provider", "cwd", "title",
  "sandbox_policy", "approval_mode", "tokens_used", "has_user_event", "archived", "archived_at", "cli_version",
  "first_user_message", "memory_mode", "created_at_ms", "updated_at_ms", "preview", "recency_at",
  "recency_at_ms", "history_mode",
];

export function assertThreadSchema41059(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(threads)").all() as unknown as Array<{ name: string }>;
  const names = new Set(rows.map((row) => String(row.name)));
  const missing = REQUIRED_COLUMNS.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`unsupported Codex threads schema; missing ${missing.join(", ")}`);
}

export function assertThreadSchemaFile41059(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assertThreadSchema41059(db);
  } finally {
    db.close();
  }
}

export function threadExists(dbPath: string, id: string): boolean {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT 1 FROM threads WHERE id = ? LIMIT 1").get(id) != null;
  } finally {
    db.close();
  }
}

export function threadRolloutPath(dbPath: string, id: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1").get(id) as
      { rollout_path?: unknown } | undefined;
    return typeof row?.rollout_path === "string" ? row.rollout_path : null;
  } finally {
    db.close();
  }
}

export function registerCodexThread41059(dbPath: string, row: CodexThreadRegistration): void {
  const db = new DatabaseSync(dbPath);
  try {
    assertThreadSchema41059(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      const seconds = Math.floor(row.updatedAtMs / 1000);
      const createdSeconds = Math.floor(row.createdAtMs / 1000);
      db.prepare(`INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
        cli_version, first_user_message, memory_mode, created_at_ms, updated_at_ms,
        preview, recency_at, recency_at_ms, history_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id,
        row.rolloutPath,
        createdSeconds,
        seconds,
        "vscode",
        "openai",
        row.cwd,
        row.title,
        JSON.stringify({ type: "read-only" }),
        "on-request",
        row.tokensUsed ?? 0,
        row.firstUserMessage ? 1 : 0,
        row.archived ? 1 : 0,
        row.archived ? seconds : null,
        "0.146.0-alpha.3.1",
        row.firstUserMessage,
        "enabled",
        row.createdAtMs,
        row.updatedAtMs,
        row.preview,
        seconds,
        row.updatedAtMs,
        "legacy",
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function unregisterCodexThread41059(dbPath: string, id: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM threads WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
