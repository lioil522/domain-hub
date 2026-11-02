// Test-only entry. No real upstream traffic, triggers, or live credentials.
import { runHttpInvocation, runScheduledInvocation } from "../../src/index";
import { DatabaseManager } from "../../src/db";
import type { Bindings } from "../../src/routes/types";
import { InvocationBudget } from "../../src/services/invocation-budget";
import { withBudgetD1 } from "../../src/db/budget-d1";
import { invocationFetch } from "../../src/services/invocation-fetch";
import { createSyncTask, getSyncTask, claimSyncTask, commitSyncSlice, syncFence } from "../../src/db/dao/sync-task-dao";
import { AppError } from "../../src/errors";

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const query = new URL(request.url).searchParams;
    const operation = query.get("op");
    const budget = new InvocationBudget({ d1: Number(query.get("d1") ?? 40), external: Number(query.get("external") ?? 40) });
    const db = withBudgetD1(env.DB, budget);
    if (operation === "automation-init") {
      const manager = new DatabaseManager(env.DB);
      if (!(await manager.ensureTables())) throw new Error("offline automation bootstrap failed");
      await env.DB.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'offline','offline-key','plain:b2ZmbGluZS1zZWNyZXQ=',?)").bind(query.get("provider") ?? "dnshe").run();
      return Response.json({ token: await manager.createSession() });
    }
    if (operation === "automation-http") {
      const response = await runHttpInvocation(new Request(`https://fixture.invalid${query.get("path") ?? "/api/accounts/1/sync-step"}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(query.get("token") ? { Authorization: `Bearer ${query.get("token")}` } : {}) },
        body: request.method === "POST" ? await request.text() : query.get("body") ?? '{"manual":true}',
      }), env, ctx, budget);
      return Response.json({ status: response.status, body: await response.json(), budget: budget.snapshot() });
    }
    if (operation === "automation-cron") {
      await runScheduledInvocation(env, budget);
      return Response.json({ budget: budget.snapshot() });
    }
    if (operation === "http") {
      const response = await runHttpInvocation(new Request("https://fixture.invalid/api/accounts", {
        headers: query.get("auth") ? { Authorization: "Bearer sess_offline-missing" } : {},
      }), env, ctx, budget);
      return Response.json({ status: response.status, body: await response.json(), budget: budget.snapshot() });
    }
    if (operation === "fetch") {
      try {
        const response = await invocationFetch("https://first.invalid/start", { headers: { "X-API-Key": "offline-key" } }, budget);
        return Response.json({ status: response.status, budget: budget.snapshot() });
      } catch (error) {
        return Response.json({ code: error instanceof AppError ? error.code : "unexpected", budget: budget.snapshot() });
      }
    }
    if (operation === "d1") {
      await db.exec("CREATE TABLE IF NOT EXISTS budget_fixture(id INTEGER PRIMARY KEY)");
      const session = db.withSession("first-primary");
      await session.batch([session.prepare("INSERT INTO budget_fixture VALUES(?)").bind(1), session.prepare("INSERT INTO budget_fixture VALUES(?)").bind(2)]);
      const first = await session.prepare("SELECT id FROM budget_fixture ORDER BY id").first<number>("id");
      const rows = await db.prepare("SELECT id FROM budget_fixture ORDER BY id").raw({ columnNames: true });
      let failed = false;
      try { await db.batch([db.prepare("INSERT INTO budget_fixture VALUES(3)"), db.prepare("INSERT INTO missing_table VALUES(1)")]); }
      catch { failed = true; }
      const count = await db.prepare("SELECT COUNT(*) AS n FROM budget_fixture").first<number>("n");
      return Response.json({ first, rows, count, failed, bookmark: session.getBookmark(), budget: budget.snapshot() });
    }
    if (!(await new DatabaseManager(env.DB).ensureTables())) throw new Error("fixture bootstrap failed");
    if (operation === "task-create") {
      await env.DB.prepare("INSERT INTO accounts(id,alias,api_key,api_secret,provider) VALUES(1,'offline','key','secret','cloudflare')").run();
      const created = await createSyncTask(db, { id: "runtime-task", generation: "runtime-generation", accountId: 1, provider: "cloudflare", revision: 1, mode: "full" });
      return Response.json({ created, task: await getSyncTask(db, "runtime-task"), budget: budget.snapshot() });
    }
    if (operation === "task-claim") {
      const task = await getSyncTask(db, "runtime-task");
      if (!task) throw new Error("missing task");
      return Response.json({ task: await claimSyncTask(db, task, query.get("owner") ?? "runtime-owner"), budget: budget.snapshot() });
    }
    if (operation === "task-commit") {
      const fence = JSON.parse(query.get("fence")!);
      let code = "ok";
      try {
        await commitSyncSlice(db, fence, { phase: "list", cursor: '{"page":2}' }, [{ kind: "list", shard: "zones", page: 1, payload: "[]" }], [{ kind: "seen", domain_id: "a" }]);
      } catch (error) { code = error instanceof AppError ? error.code : "storage_error"; }
      return Response.json({ code, task: await getSyncTask(env.DB, "runtime-task"), budget: budget.snapshot() });
    }
    return new Response(null, { status: 404 });
  },
};
