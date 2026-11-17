import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { DatabaseManager } from "../../src/db";
import { createD1FromSqlite } from "../../server/d1-sqlite";

export const TEST_AES_KEY = "security-regression-test-key";
export const TEST_PASSWORD = "local-test-password";

export async function testDatabase(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  const d1 = createD1FromSqlite(sqlite);
  const manager = new DatabaseManager(d1, TEST_AES_KEY);
  assertSchema(await manager.ensureTables());
  t.after(() => sqlite.close());
  return { sqlite, d1, manager };
}

function assertSchema(ready: boolean) {
  if (!ready) throw new Error("Test schema initialization failed");
}

/** Preserve immutable bind() while injecting an error into a selected SQL operation. */
export function failDatabaseOperation(db: D1Database, matches: (sql: string) => boolean, operation: string): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!matches(sql)) return statement;
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
          get(stmt, key) {
            if (key === operation) return async () => { throw new Error("Injected database failure"); };
            if (key === "bind") return (...values: unknown[]) => wrap(stmt.bind(...values));
            const value = Reflect.get(stmt, key);
            return typeof value === "function" ? value.bind(stmt) : value;
          },
        });
        return wrap(statement);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
