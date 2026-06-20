import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../../src/infrastructure/persistence/database.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe("migrate", () => {
  test("creates an index on recurring_postings(month) for fast forecast lookups", () => {
    const row = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recurring_postings' AND name = $name",
      )
      .get({ $name: "idx_recurring_postings_month" });
    expect(row).not.toBeNull();
  });

  test("is idempotent (safe to run twice)", () => {
    expect(() => migrate(db)).not.toThrow();
  });
});

describe("openDatabase durability", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kakeibo-db-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses the rollback journal (not WAL) for a file database", () => {
    const fileDb = openDatabase(join(dir, "k.sqlite"));
    const mode = (fileDb.query("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode;
    fileDb.close();
    // Rollback journal writes straight to the main file (no -wal to lose).
    expect(mode).toBe("delete");
  });

  test("backs up the existing database file when re-opened", () => {
    const path = join(dir, "k.sqlite");
    const first = openDatabase(path);
    first.exec("INSERT INTO reflections (month, id) VALUES ('2026-01', 'r1')");
    first.close();

    openDatabase(path).close(); // existing non-empty file -> snapshot it

    const backups = readdirSync(join(dir, "backups"));
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/k\.sqlite\..*\.bak$/);
  });

  test("does not create a backup when the database is unchanged", () => {
    const path = join(dir, "k.sqlite");
    openDatabase(path).close(); // creates the file (nothing to back up yet)
    openDatabase(path).close(); // file exists -> 1 backup
    openDatabase(path).close(); // unchanged since that backup -> still 1

    expect(readdirSync(join(dir, "backups")).length).toBe(1);
  });

  test("keeps only the most recent backups", () => {
    const path = join(dir, "k.sqlite");
    openDatabase(path).close();
    // Each open mutates the DB (a unique row) so every re-open snapshots a change.
    for (let i = 0; i < 14; i += 1) {
      const each = openDatabase(path);
      each.exec(
        `INSERT INTO transactions (id, type, amount_minor, currency, occurred_at)
         VALUES ('t${i}', 'INCOME', 100, 'JPY', '2026-01-01')`,
      );
      each.close();
    }
    expect(readdirSync(join(dir, "backups")).length).toBeLessThanOrEqual(10);
  });
});
