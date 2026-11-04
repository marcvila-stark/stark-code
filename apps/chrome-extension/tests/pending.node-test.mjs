import "fake-indexeddb/auto";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { listPending, readPending, savePending, deletePending } from "../src/pending.js";
const capture = {
  version: 1,
  id: "store-fixture",
  kind: "text",
  pageUrl: "https://example.com/docs",
  pageTitle: "Docs",
  capturedAt: "2026-11-02T00:00:00.000Z",
  text: "Exact source\n✓",
  note: "Existing note",
};
const record = {
  capture,
  target: {
    kind: "thread",
    environmentId: "environment",
    projectId: "project",
    threadId: "thread",
  },
  stage: "review",
  updatedAt: 1,
};
NodeTest.test(
  "pending bytes, note and chosen target round-trip; invalid updates leave durable capture intact",
  async () => {
    await savePending(record);
    NodeAssert.deepEqual(await readPending(capture.id), record);
    await NodeAssert.rejects(
      savePending({ ...record, capture: { ...capture, note: "x".repeat(1001) } }),
    );
    NodeAssert.deepEqual(await readPending(capture.id), record);
    await deletePending(capture.id);
    NodeAssert.equal(await readPending(capture.id), null);
  },
);
NodeTest.test(
  "retake atomically replaces one item in a full queue and preserves the rest",
  async () => {
    for (let i = 0; i < 20; i++)
      await savePending({ ...record, capture: { ...capture, id: `queue-${i}` }, updatedAt: i });
    await NodeAssert.rejects(
      savePending({ ...record, capture: { ...capture, id: "overflow" } }),
      /20 pending/,
    );
    const retake = {
      ...record,
      capture: { ...capture, id: "retaken", text: "New region reference" },
      updatedAt: 21,
    };
    await savePending(retake, "queue-0");
    NodeAssert.equal(await readPending("queue-0"), null);
    NodeAssert.deepEqual(await readPending("retaken"), retake);
    NodeAssert.equal((await listPending()).length, 20);
    for (const item of await listPending()) await deletePending(item.capture.id);
  },
);

NodeTest.test(
  "a stale retake cannot replace a capture that became a pending delivery",
  async () => {
    const original = { ...record, capture: { ...capture, id: "race-original" } };
    await savePending(original);
    await savePending({ ...original, stage: "pending", updatedAt: 2 });
    const replacement = { ...record, capture: { ...capture, id: "race-retake" } };
    await NodeAssert.rejects(
      savePending(replacement, original.capture.id, original),
      /earlier capture changed/,
    );
    NodeAssert.equal((await readPending(original.capture.id)).stage, "pending");
    NodeAssert.equal(await readPending(replacement.capture.id), null);
    await deletePending(original.capture.id);
  },
);
