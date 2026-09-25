import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/** Minimal database interface implemented by embedded PGlite (dev/tests) and node-postgres (production). */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function one<T>(db: Db, sql: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await db.query<T>(sql, params);
  return rows[0];
}

export interface DbOptions {
  databaseUrl?: string;
  /** Directory for embedded Postgres; omit for an in-memory database. */
  pgliteDir?: string;
}

export async function openDb(opts: DbOptions): Promise<Db> {
  if (opts.databaseUrl) return openPostgres(opts.databaseUrl);
  return openPglite(opts.pgliteDir);
}

type PgliteLike = Pick<PGlite, "query" | "exec">;

function wrapPglite(conn: PgliteLike, root: PGlite): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await conn.query<T>(sql, params);
      return res.rows;
    },
    async exec(sql: string) {
      await conn.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (conn !== root) return fn(wrapPglite(conn, root)); // already inside a transaction
      return root.transaction(async (tx) => fn(wrapPglite(tx, root)));
    },
    async close() {
      await root.close();
    },
  };
}

async function openPglite(dir?: string): Promise<Db> {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  return wrapPglite(db, db);
}

function wrapPgClient(client: pg.PoolClient): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return fn(wrapPgClient(client)); // nested: reuse the open transaction
    },
    async close() {
      client.release();
    },
  };
}

async function openPostgres(connectionString: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query("select 1");
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrapPgClient(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
