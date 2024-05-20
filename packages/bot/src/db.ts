import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { runMigrations, Migrations } from './migrations.js';

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
