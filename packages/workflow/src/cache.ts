import type { Database } from 'better-sqlite3';
import stringify from 'json-stable-stringify';

/** A cache interface for reusing node contents */
export interface NodeResultCache {
  get: (node: string, key: string) => string | undefined | Promise<string | undefined>;
  set: (node: string, key: string, value: string) => void | Promise<void>;
  clear: (node?: string) => void | Promise<void>;
}

/** A cache implementation that persists data to a SQLite Database. This adds an `ramus_cache` table to the database */
export function betterSqliteCache(db: Database) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS ramus_cache (node TEXT NOT NULL, key TEXT NOT NULL, value TEXT, created_at int, PRIMARY KEY (node, key))'
  );

  return {
    get: (node: string, key: string) => {
      const data = db
        .prepare<
          unknown[],
          { value: string }
        >(`SELECT value FROM ramus_cache WHERE node = ? AND key = ?`)
        .get(node, key);
      return data?.value;
    },
    set: (node: string, key: string, value: string) => {
      db.prepare(
        `INSERT OR REPLACE INTO ramus_cache (node, key, value, created_at) VALUES (?, ?, ?, ?)`
      ).run(node, key, value, Date.now());
    },
    clear: (node?: string) => {
      if (node) {
        db.prepare(`DELETE FROM ramus_cache WHERE node = ?`).run(node);
      } else {
        db.prepare(`DELETE FROM ramus_cache`).run();
      }
    },
  };
}

/** A cache implementation that holds the data in memory. */
export function memoryCache(): NodeResultCache {
  const cache = new Map<string, Map<string, string>>();
  return {
    get: (node: string, key: string) => cache.get(node)?.get(key),
    set: (node: string, key: string, value: string) => {
      let nodeCache = cache.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        cache.set(node, nodeCache);
      }

      nodeCache.set(key, value);
    },
    clear: (node?: string) => {
      if (node) {
        cache.delete(node);
      } else {
        cache.clear();
      }
    },
  };
}

export function calculateCacheKey(f: Function, data: any, rootInputs: any) {
  return f.toString() + stringify(data) + stringify(rootInputs);
}
