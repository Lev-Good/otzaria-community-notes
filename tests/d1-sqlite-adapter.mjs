import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

/**
 * Lightweight Cloudflare D1-compatible adapter backed by Node's built-in `node:sqlite`.
 */
export class D1SqliteAdapter {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  exec(sql) {
    this.db.exec(sql);
  }

  applyMigrationFile(filePath) {
    const sql = fs.readFileSync(filePath, 'utf8');
    this.db.exec(sql);
  }

  prepare(query) {
    const db = this.db;
    const makeBound = (params) => ({
      first: async (colName) => {
        const stmt = db.prepare(query);
        const row = stmt.get(...params);
        if (!row) return null;
        if (colName) return row[colName] ?? null;
        return { ...row };
      },
      all: async () => {
        const stmt = db.prepare(query);
        const rows = stmt.all(...params).map((r) => ({ ...r }));
        return { results: rows, success: true, meta: { changes: 0 } };
      },
      run: async () => {
        const stmt = db.prepare(query);
        const res = stmt.run(...params);
        return {
          success: true,
          meta: {
            changes: Number(res.changes || 0),
            last_row_id: Number(res.lastInsertRowid || 0),
          },
        };
      },
    });

    return {
      bind: (...params) => makeBound(params.map((p) => (p === undefined ? null : p))),
      first: (colName) => makeBound([]).first(colName),
      all: () => makeBound([]).all(),
      run: () => makeBound([]).run(),
    };
  }

  close() {
    this.db.close();
  }
}
