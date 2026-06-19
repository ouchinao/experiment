import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Opens a SQLite database and applies the schema.
 *
 * Bun ships an embedded SQLite engine (`bun:sqlite`), so persistence needs no
 * external service — a perfect fit for this privacy-first, offline app. Pass
 * ":memory:" for an ephemeral database (used by integration tests).
 */
export function openDatabase(path: string): Database {
  // Resolve to an absolute path and make sure the parent directory exists — a
  // missing directory is a common cause of SQLITE_CANTOPEN, and resolving means
  // it doesn't depend on the process's current working directory.
  const dbPath = path === ":memory:" ? path : resolve(path);
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  let db: Database;
  try {
    db = new Database(dbPath, { create: true });
    // WAL improves concurrent read/write behaviour for the local server, but it
    // needs a shared-memory (`-shm`) file that some filesystems can't provide
    // (network mounts, iCloud/Dropbox-synced folders…), where it fails with
    // SQLITE_IOERR_SHMOPEN. Treat it as best-effort: on failure, keep the
    // default rollback journal so the app still runs.
    try {
      db.exec("PRAGMA journal_mode = WAL;");
    } catch {
      // Filesystem doesn't support WAL shared memory — fall back silently.
    }
    db.exec("PRAGMA foreign_keys = ON;");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not open the SQLite database at "${dbPath}": ${detail}. ` +
        "Make sure the location is writable and not on a synced or network " +
        "folder (iCloud/Dropbox/SMB). Set DATABASE_PATH to a local path, e.g. " +
        'DATABASE_PATH="$HOME/.kakeibo/kakeibo.sqlite".',
    );
  }

  migrate(db);
  return db;
}

/** Creates the schema if it does not already exist (idempotent). */
export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL CHECK (type IN ('INCOME', 'EXPENSE')),
      amount_minor INTEGER NOT NULL,
      currency    TEXT NOT NULL,
      category    TEXT,
      occurred_at TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      -- Amount converted to the base currency at booking time. Nullable for
      -- rows created before multi-currency; read falls back to the original.
      base_amount_minor INTEGER,
      base_currency     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_month
      ON transactions (substr(occurred_at, 1, 7));

    CREATE TABLE IF NOT EXISTS monthly_plans (
      month                 TEXT PRIMARY KEY,
      id                    TEXT NOT NULL,
      currency              TEXT NOT NULL,
      planned_income_minor  INTEGER NOT NULL,
      savings_goal_minor    INTEGER NOT NULL,
      category_budgets_json TEXT NOT NULL DEFAULT '{}',
      -- Fields converted to the base currency at save time. Nullable for rows
      -- created before multi-currency; read falls back to the own-currency ones.
      base_currency              TEXT,
      base_planned_income_minor  INTEGER,
      base_savings_goal_minor    INTEGER,
      base_category_budgets_json TEXT
    );

    CREATE TABLE IF NOT EXISTS reflections (
      month        TEXT PRIMARY KEY,
      id           TEXT NOT NULL,
      answers_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency     TEXT NOT NULL,
      category     TEXT NOT NULL,
      day_of_month INTEGER NOT NULL,
      active       INTEGER NOT NULL DEFAULT 1,
      -- Amount converted to the base currency at creation time. Nullable for
      -- rows created before multi-currency; read falls back to the original.
      base_amount_minor INTEGER,
      base_currency     TEXT
    );

    -- Records that a recurring expense was auto-posted in a given month,
    -- keeping posting idempotent and forecasts free of double-counting.
    CREATE TABLE IF NOT EXISTS recurring_postings (
      recurring_id TEXT NOT NULL,
      month        TEXT NOT NULL,
      PRIMARY KEY (recurring_id, month)
    );

    -- The composite PK leads with recurring_id, so lookups by month alone
    -- (GetForecast -> postedIds) cannot use it efficiently. Index month.
    CREATE INDEX IF NOT EXISTS idx_recurring_postings_month
      ON recurring_postings (month);
  `);

  // Upgrade older databases that predate the base-currency columns.
  addColumnIfMissing(db, "transactions", "base_amount_minor", "INTEGER");
  addColumnIfMissing(db, "transactions", "base_currency", "TEXT");
  addColumnIfMissing(db, "recurring_expenses", "base_amount_minor", "INTEGER");
  addColumnIfMissing(db, "recurring_expenses", "base_currency", "TEXT");
  addColumnIfMissing(db, "monthly_plans", "base_currency", "TEXT");
  addColumnIfMissing(db, "monthly_plans", "base_planned_income_minor", "INTEGER");
  addColumnIfMissing(db, "monthly_plans", "base_savings_goal_minor", "INTEGER");
  addColumnIfMissing(db, "monthly_plans", "base_category_budgets_json", "TEXT");
}

/** Adds a column to a table if it does not already exist (idempotent). */
function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
