import postgres from 'postgres';
import { text, jsonb, uuid, timestamp, boolean, pgSchema } from 'drizzle-orm/pg-core';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { runMigrations, Migrations } from './migrations.js';
import { migrations as mainMigrations } from './migration_fn.js';
import { eq, sql } from 'drizzle-orm';

let pool: postgres.Sql | undefined;
export let _db: PostgresJsDatabase;

export interface RamusBotDbOptions {
  /** The connection string for the database. */
  connectionString: string;
  /** A Drizzle client for the database. This should usually be provided so that the bot can share the
   * connection pool with the rest of the application. If omitted, one will be created using `connectionString`. */
  db?: PostgresJsDatabase;
  /** Migrations to run when connecting. */
  migrations: Migrations[];
}

export async function initDb({ connectionString, db, migrations }: RamusBotDbOptions) {
  if (_db) {
    throw new Error(`Tried to initialize database twice`);
  }

  if (!migrations.some((m) => m.key === 'main')) {
    migrations.unshift(mainMigrations);
  }

  let migrationConn = postgres(connectionString, { max: 1 });
  await runMigrations(migrationConn, migrations);

  if (db) {
    _db = db;
  } else {
    pool = postgres(connectionString);
    _db = drizzle(pool);
  }
}

export function shutdownDb() {
  pool?.end();
}

export function postgresClient() {
  if (!_db) {
    throw new Error('Database not initialized');
  }

  return _db;
}

export const ramusSchema = pgSchema('ramus');

export const conversations = ramusSchema.table('ramus.conversations', {
  conversation_id: uuid('conversation_id').primaryKey(),
  organization: uuid('organization').notNull(),
  platform: text('platform').notNull(),
  active: boolean('active').notNull().default(true),
  started_by: uuid('started_by').notNull(),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
});

export const kvConfigs = ramusSchema.table('ramus.vars', {
  key: text('key').notNull().primaryKey(),
  value: jsonb('value').notNull(),
});

export async function kvGet<T>(tx: PostgresJsDatabase, key: string): Promise<T | undefined> {
  const data = await tx.select().from(kvConfigs).where(eq(kvConfigs.key, key));
  return data[0]?.value as T;
}

export async function kvSet<T>(tx: PostgresJsDatabase, key: string, value: T) {
  await tx
    .insert(kvConfigs)
    .values({ key, value })
    .onConflictDoUpdate({ target: [kvConfigs.key], set: { value: sql`EXCLUDED.value` } });
}
