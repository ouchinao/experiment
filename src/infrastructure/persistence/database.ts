import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** How many startup backups of the database file to retain. */
const BACKUP_LIMIT = 10;

/**
 * Opens a SQLite database and applies the schema.
 *
 * Bun ships an embedded SQLite engine (`bun:sqlite`), so persistence needs no
 * external service — a perfect fit for this privacy-first, offline app. Pass
 * ":memory:" for an ephemeral database (used by integration tests).
 *
 * Durability choices for a single-user local app:
 *  - the **rollback journal** (not WAL) is used, so every commit lands directly
 *    in the main file — there is no separate `-wal` that could be deleted or
 *    stranded (e.g. on a full disk), and no WAL `-shm` file to fail on;
 *  - the existing file is snapshotted into a rotating `backups/` directory on
 *    open, so a mishap can be recovered from a recent copy.
 */
export function openDatabase(path: string): Database {
  // Resolve to an absolute path and make sure the parent directory exists — a
  // missing directory is a common cause of SQLITE_CANTOPEN, and resolving means
  // it doesn't depend on the process's current working directory.
  const dbPath = path === ":memory:" ? path : resolve(path);
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
    backUpExisting(dbPath);
  }

  let db: Database;
  try {
    db = new Database(dbPath, { create: true });
    // Rollback journal: durable per-commit writes to the main file, and it
    // converts an existing WAL database back (also avoids SQLITE_IOERR_SHMOPEN).
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("PRAGMA foreign_keys = ON;");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not open the SQLite database at "${dbPath}": ${detail}. ` +
        "Check the location is writable, has free disk space, and isn't on a " +
        "synced or network folder (iCloud/Dropbox/SMB). Set DATABASE_PATH to a " +
        'local path, e.g. DATABASE_PATH="$HOME/.kakeibo/kakeibo.sqlite".',
    );
  }

  migrate(db);
  return db;
}

/**
 * Copies the current database file into a sibling `backups/` directory before it
 * is opened, keeping the most recent {@link BACKUP_LIMIT}. Best-effort: an
 * unchanged database is not re-copied, and any failure (e.g. no disk space)
 * must never stop the app from starting.
 */
function backUpExisting(dbPath: string): void {
  try {
    if (!existsSync(dbPath)) return;
    const dir = join(dirname(dbPath), "backups");
    mkdirSync(dir, { recursive: true });
    const name = basename(dbPath);
    const existing = readdirSync(dir)
      .filter((f) => f.startsWith(`${name}.`) && f.endsWith(".bak"))
      .sort();

    const latest = existing.at(-1);
    if (latest && filesEqual(dbPath, join(dir, latest))) return; // nothing changed

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(dbPath, join(dir, `${name}.${stamp}.bak`));

    // Drop everything but the newest BACKUP_LIMIT copies.
    const all = [...existing, `${name}.${stamp}.bak`].sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUP_LIMIT))) {
      rmSync(join(dir, old), { force: true });
    }
  } catch {
    // Backups are best-effort; never block startup on them.
  }
}

/** Byte-compares two files; false if either can't be read. */
function filesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
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
