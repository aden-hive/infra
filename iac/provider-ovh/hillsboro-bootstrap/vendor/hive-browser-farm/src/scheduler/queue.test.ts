import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryDueQueue, MemoryProfileLock } from "./queue.ts";

test("only accounts whose time has come are handed out", async () => {
  const q = new MemoryDueQueue();
  await q.schedule("a", 100);
  await q.schedule("b", 500);
  assert.deepEqual(await q.due(200, 10), ["a"]);
});

test("the most overdue account is served first", async () => {
  // Under sustained backlog a fair order is what stops one account starving
  // while others are checked repeatedly.
  const q = new MemoryDueQueue();
  await q.schedule("late", 100);
  await q.schedule("later", 50);
  await q.schedule("recent", 200);
  assert.deepEqual(await q.due(1000, 10), ["later", "late", "recent"]);
});

test("rescheduling replaces rather than duplicates", async () => {
  // The loop reschedules after every lease. Appending instead of replacing
  // would grow the queue without bound and check hot accounts twice.
  const q = new MemoryDueQueue();
  await q.schedule("a", 100);
  await q.schedule("a", 900);
  assert.equal(await q.size(), 1);
  assert.deepEqual(await q.due(500, 10), []);
});

test("a locked profile cannot be locked again", async () => {
  // The core invariant: two browsers driving one LinkedIn session corrupts
  // stored state and is plainly non-human.
  const lock = new MemoryProfileLock(() => 0);
  assert.equal(await lock.acquire("a", 60_000), true);
  assert.equal(await lock.acquire("a", 60_000), false);
});

test("a lock outlives its lease but not forever", async () => {
  // A holder can die mid-lease. Without expiry the account is stranded; with
  // expiry that is too short, the double-drive the lock prevents happens anyway.
  const t = { v: 0 };
  const lock = new MemoryProfileLock(() => t.v);
  await lock.acquire("a", 60_000);
  t.v = 59_000;
  assert.equal(await lock.acquire("a", 60_000), false, "expired while lease was live");
  t.v = 61_000;
  assert.equal(await lock.acquire("a", 60_000), true, "never recovered from a dead holder");
});

test("releasing frees the profile immediately", async () => {
  const lock = new MemoryProfileLock(() => 0);
  await lock.acquire("a", 60_000);
  await lock.release("a");
  assert.equal(await lock.held("a"), false);
  assert.equal(await lock.acquire("a", 60_000), true);
});
