/** Test-only async D1 boundary faults; SQL still executes against SQLite/workerd. */
export function coordinationFault(db: D1Database,
  intercept: (sql: string, method: string, execute: () => Promise<unknown>) => Promise<unknown>): D1Database {
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (key === "first") return (column?: string) => intercept(sql, "first", () => column === undefined ? target.first() : target.first(column));
      if (key === "run") return () => intercept(sql, "run", () => target.run());
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch") return (statements: D1PreparedStatement[]) => intercept("", "batch", () => target.batch(statements));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
