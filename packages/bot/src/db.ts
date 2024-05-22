import postgres from 'postgres';
import { pgTable, text, jsonb, uuid, timestamp, boolean } from 'drizzle-orm/pg-core';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { runMigrations, Migrations } from './migrations.js';
import { eq, sql } from 'drizzle-orm';

export let _db: PostgresJsDatabase;

export async function initDb(connectionString: string, migrations: Migrations[]) {
  if (_db) {
    throw new Error(`Tried to initiialize database twice`);
  }

  connectionString = connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(`No database connection string provided`);
  }

  const migrationClient = postgres(connectionString, { max: 1 });

  await runMigrations(migrationClient, migrations);

  const client = postgres(connectionString);
  _db = drizzle(client);
}

export function postgresClient() {
  if (!_db) {
    throw new Error('Database not initialized');
  }

  return _db;
}

export const conversations = pgTable('ramus.conversations', {
  conversation_id: uuid('conversation_id').primaryKey(),
  organization: uuid('organization').notNull(),
  platform: text('platform').notNull(),
  active: boolean('active').notNull().default(true),
  started_by: uuid('started_by').notNull(),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
});

export const kvConfigs = pgTable('ramus.vars', {
  key: text('key').notNull().primaryKey(),
  value: jsonb('value').notNull(),
});

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const data = await postgresClient().select().from(kvConfigs).where(eq(kvConfigs.key, key));
  return data[0]?.value as T;
}

export async function kvSet<T>(key: string, value: T) {
  await postgresClient()
    .insert(kvConfigs)
    .values({ key, value })
    .onConflictDoUpdate({ target: [kvConfigs.key], set: { value: sql`excluded.value` } });
}
