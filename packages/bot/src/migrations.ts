import { Sql } from 'postgres';
import { basename } from 'path';

export interface Migrations {
  key: string;
  /** Absolute path to queries, in order of application. The migration system will filter this to the
   * list of queries that need to be run. */
  files: string[];
}

/** Run migrations. Migrations for adapters should usually be last. */
export async function runMigrations(sql: Sql, migrations: Migrations[]) {
  await sql`
    CREATE SCHEMA IF NOT EXISTS ramus;
    CREATE TABLE IF NOT EXISTS ramus.__migrations (
      id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      source string,
      index int,
      filename string,
    );
    `.simple();

  let nextVersion: Record<string, number> =
    await sql`SELECT source, MAX(index) + 1 AS needed FROM ramus.__migrations GROUP BY source`.then(
      (rows) => Object.fromEntries((rows as any[]).map((row) => [row.source, row.needed]))
    );

  const neededSources = migrations.filter((m) => nextVersion[m.key] ?? 0 < m.files.length);
  if (!neededSources.length) {
    console.log(`Migrations are up to date`);
    return;
  }

  await sql.begin(async (sql) => {
    for (const migration of neededSources) {
      await runMigrationSet(sql, nextVersion[migration.key] ?? 0, migration);
    }
  });
}

export async function runMigrationSet(sql: Sql, needed: number, migrations: Migrations) {
  for (let index = needed; index < migrations.files.length; index++) {
    const query = migrations.files[index - 1];
    let filename = basename(query);
    console.log(`Running migration ${migrations.key}(${index}) ${filename}`);
    await sql.file(query);
    await sql`INSERT INTO ramus.__migrations (source, index, filename)
        VALUES
        (${migrations.key}, ${index}, ${filename})`;
  }
}
