import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, type FarmEvent, type EventSink } from "./outbox.ts";

const T0 = 1_700_000_000_000;
const ev = (at: number, unread: number): FarmEvent =>
  ({ kind: "unread_changed", platform: "linkedin", accountId: "dan", unread, previousUnread: null, at });

async function harness(sink: EventSink, now = () => T0) {
  const root = await mkdtemp(join(tmpdir(), "bf-out-"));
  const outbox = new Outbox({ root, sink, now });
  await outbox.init();
  return outbox;
}

test("events survive the process that created them", async () => {
  // An in-memory queue drops exactly the notifications in flight when
  // something breaks, which is when they matter most.
  const root = await mkdtemp(join(tmpdir(), "bf-out-"));
  const sink: EventSink = { deliver: async () => {} };
  const first = new Outbox({ root, sink });
  await first.init();
  await first.enqueue(ev(T0, 3));
  const second = new Outbox({ root, sink });
  assert.equal((await second.pending()).length, 1);
});

test("a failed delivery keeps the events queued", async () => {
  const outbox = await harness({ deliver: async () => { throw new Error("gcp down"); } });
  await outbox.enqueue(ev(T0, 3));
  const result = await outbox.flush();
  assert.equal(result.failed, 1);
  assert.equal((await outbox.pending()).length, 1, "dropped an undelivered event");
});

test("reconnecting flushes the backlog in the order things happened", async () => {
  // A replay that reorders "unread 5" before "unread 3" leaves the control
  // plane with the wrong current state.
  const seen: number[] = [];
  let up = false;
  const outbox = await harness({
    deliver: async (events) => {
      if (!up) throw new Error("down");
      seen.push(...events.map((e) => (e.kind === "unread_changed" ? e.unread : -1)));
    },
  });
  await outbox.enqueue(ev(T0, 3));
  await outbox.enqueue(ev(T0 + 1000, 5));
  await outbox.flush();
  up = true;
  await outbox.flush();
  assert.deepEqual(seen, [3, 5]);
  assert.equal((await outbox.pending()).length, 0);
});

test("events are deleted only after the sink confirms", async () => {
  // At-least-once on purpose: a duplicated notification is noise, a dropped
  // one is a customer message nobody sees.
  let attempts = 0;
  const outbox = await harness({
    deliver: async () => { attempts++; if (attempts === 1) throw new Error("timeout"); },
  });
  await outbox.enqueue(ev(T0, 3));
  await outbox.flush();
  assert.equal((await outbox.pending()).length, 1);
  await outbox.flush();
  assert.equal((await outbox.pending()).length, 0);
  assert.equal(attempts, 2);
});

test("lag reports the age of the oldest stuck event", async () => {
  const outbox = await harness(
    { deliver: async () => { throw new Error("down"); } },
    () => T0 + 120_000,
  );
  await outbox.enqueue(ev(T0, 3));
  assert.equal((await outbox.flush()).lagMs, 120_000);
});

test("a corrupt event does not wedge the queue behind it", async () => {
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "bf-out-"));
  const delivered: FarmEvent[] = [];
  const outbox = new Outbox({ root, sink: { deliver: async (e) => { delivered.push(...e); } } });
  await outbox.init();
  await writeFile(join(root, "outbox", "1700000000000-00000.json"), "{not json");
  await outbox.enqueue(ev(T0 + 5000, 7));
  await outbox.flush();
  assert.equal(delivered.length, 1);
  assert.equal((await outbox.pending()).length, 0);
});

test("an empty outbox is not an error", async () => {
  const outbox = await harness({ deliver: async () => { throw new Error("should not be called"); } });
  assert.deepEqual(await outbox.flush(), { delivered: 0, failed: 0, lagMs: 0 });
});
