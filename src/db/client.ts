import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config.js";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Transaction;

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: process.env.VERCEL ? 5 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

export const db: Database = drizzle(pool, { schema, casing: "snake_case" });

export async function closeDb(): Promise<void> {
  await pool.end();
}
