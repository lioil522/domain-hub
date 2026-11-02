import type { InvocationCounter } from "../services/invocation-budget";

type StatementInfo = { raw: D1PreparedStatement; identity: D1Database; counter: InvocationCounter };
type DatabaseInfo = { raw: D1Database; counter: InvocationCounter };
// Metadata only, never a shared invocation budget or schema flag on the raw DB.
const statements = new WeakMap<D1PreparedStatement, StatementInfo>();
const databases = new WeakMap<D1Database, DatabaseInfo>();

export function databaseIdentity(db: D1Database): D1Database { return databases.get(db)?.raw ?? db; }
export function databaseBudget(db: D1Database): InvocationCounter | undefined { return databases.get(db)?.counter; }

class BudgetStatement implements D1PreparedStatement {
  constructor(private readonly info: StatementInfo) { statements.set(this, info); }
  bind(...values: unknown[]): D1PreparedStatement {
    return new BudgetStatement({ ...this.info, raw: this.info.raw.bind(...values) });
  }
  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(column?: string): Promise<T | null> {
    this.info.counter.consume("d1");
    return column === undefined ? this.info.raw.first<T>() : this.info.raw.first<T>(column);
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.info.counter.consume("d1");
    return this.info.raw.all<T>();
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.info.counter.consume("d1");
    return this.info.raw.run<T>();
  }
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    this.info.counter.consume("d1");
    return options?.columnNames ? this.info.raw.raw<T>({ columnNames: true }) : this.info.raw.raw<T>(options as { columnNames?: false } | undefined);
  }
}

/** No proxies or detached receiver calls: D1 native methods keep their receiver.
 * Re-wrapping replaces the counter (does not double count). A batch accepts only
 * statements from the same physical DB AND invocation/reservation context.
 */
export function withBudgetD1(db: D1Database, counter: InvocationCounter): D1Database {
  const identity = databaseIdentity(db);
  const wrap = (raw: D1PreparedStatement) => new BudgetStatement({ raw, identity, counter });
  const batch = async <T>(target: D1Database | D1DatabaseSession, entries: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const raw = entries.map(entry => {
      const info = statements.get(entry);
      if (!info || info.identity !== identity || info.counter !== counter) throw new Error("Cross-database or cross-invocation D1 batch");
      return info.raw;
    });
    counter.consume("d1");
    return target.batch<T>(raw);
  };
  const wrapped: D1Database = {
    prepare: query => wrap(identity.prepare(query)),
    batch: <T = unknown>(entries: D1PreparedStatement[]) => batch<T>(identity, entries),
    exec: async query => { counter.consume("d1"); return identity.exec(query); },
    dump: async () => { counter.consume("d1"); return identity.dump(); },
    withSession: constraint => {
      const session = identity.withSession(constraint);
      return {
        prepare: query => wrap(session.prepare(query)),
        batch: <T = unknown>(entries: D1PreparedStatement[]) => batch<T>(session, entries),
        getBookmark: () => session.getBookmark(),
      };
    },
  };
  databases.set(wrapped, { raw: identity, counter });
  return wrapped;
}
