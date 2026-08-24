import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.ts";

const entry = (actor: string, accountId: string, at: number) => ({
  at, actor, accountId, action: "send_message", outcome: "ok" as const, target: "in/someone",
});

test("who acted as which account is recorded", async () => {
  // Once an operator can send as any account from a panel, "who sent that"
  // needs an answer that is not "one of us".
  const log = new AuditLog(await mkdtemp(join(tmpdir(), "bf-audit-")));
  await log.record(entry("staff@open-hive.com", "dan", 1000));
  const [seen] = await log.recent();
  assert.equal(seen?.actor, "staff@open-hive.com");
  assert.equal(seen?.accountId, "dan");
});

test("history is newest first and survives many entries", async () => {
  const log = new AuditLog(await mkdtemp(join(tmpdir(), "bf-audit-")));
  for (let i = 0; i < 120; i++) await log.record(entry("a@b.c", `acct-${i}`, i));
  const recent = await log.recent(10);
  assert.equal(recent.length, 10);
  assert.equal(recent[0]?.accountId, "acct-119");
});

test("a torn final line does not hide the rest of the history", async () => {
  // Appends are not atomic across a kill; losing the whole audit trail because
  // the last write was cut short would defeat the point.
  const root = await mkdtemp(join(tmpdir(), "bf-audit-"));
  const log = new AuditLog(root);
  await log.record(entry("a@b.c", "dan", 1000));
  await appendFile(join(root, "audit.jsonl"), '{"at":2000,"actor":"trunc');
  const recent = await log.recent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.accountId, "dan");
});

test("an empty log is not an error", async () => {
  const log = new AuditLog(await mkdtemp(join(tmpdir(), "bf-audit-")));
  assert.deepEqual(await log.recent(), []);
});
