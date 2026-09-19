import assert from "node:assert/strict";
import { test } from "node:test";
import { BackupService } from "../../src/services/backup-service";

// Exercise pure diff logic without creating a database binding.
const service = Object.create(BackupService.prototype) as BackupService;

test("backup diff reports add/update/remove without performing deletes", () => {
  const diff = service.diff(
    { version: 1, exported_at: "now", data: { accounts: [{ id: 1, alias: "old" }, { id: 2, alias: "keep" }] } },
    { version: 1, exported_at: "now", data: { accounts: [{ id: 1, alias: "new" }, { id: 3, alias: "add" }] } },
  );
  const accounts = diff.tables.find((item) => item.table === "accounts");
  assert.deepEqual(accounts && { add: accounts.add, update: accounts.update, remove: accounts.remove }, { add: 1, update: 1, remove: 1 });
  assert.equal(diff.totalConflicts, 0);
});
