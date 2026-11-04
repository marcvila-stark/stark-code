import "fake-indexeddb/auto";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { readPending, savePending, deletePending, listPending } from "../src/pending.js";

const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  origin = `chrome-extension://${extensionId}/`;
const session = new Map();
let listener, nativeHandler;
globalThis.chrome = {
  runtime: {
    id: extensionId,
    getURL: (path) => origin + path,
    onInstalled: { addListener() {} },
    onMessage: {
      addListener: (fn) => {
        listener = fn;
      },
    },
    sendNativeMessage: async (host, message) => {
      NodeAssert.equal(host, "com.starkcode.capture");
      return nativeHandler(message);
    },
  },
  action: { async setBadgeText() {}, async openPopup() {} },
  storage: {
    session: {
      async get(keys) {
        return Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys])
            .filter((key) => session.has(key))
            .map((key) => [key, session.get(key)]),
        );
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) session.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) session.delete(key);
      },
    },
  },
  contextMenus: { onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
};
await import("../src/worker.js");
const sender = { id: extensionId, url: origin + "popup.html" };
const call = (message) =>
  new Promise((resolve) => {
    NodeAssert.equal(listener(message, sender, resolve), true);
  });
const source = {
  version: 1,
  kind: "text",
  pageUrl: "https://example.com/docs",
  pageTitle: "Docs",
  capturedAt: "2026-11-02T00:00:00.000Z",
  text: "A selected quote\n✓",
  note: "Use this reference",
};
const target = { kind: "thread", environmentId: "env", projectId: "project", threadId: "chosen" };
const record = (id) => ({
  capture: { ...source, id },
  target,
  targetLabel: "Chosen chat",
  projectLabel: "Project · This Mac",
  stage: "review",
  updatedAt: 1,
});
async function clear() {
  for (const item of await listPending()) await deletePending(item.capture.id);
  session.clear();
}

NodeTest.test("other extension origins cannot read captures", () => {
  NodeAssert.equal(
    listener({ type: "state" }, { id: "other", url: "https://example.com" }, () =>
      NodeAssert.fail("Untrusted sender received data"),
    ),
    false,
  );
});
NodeTest.test(
  "delivery pins payload before native dispatch and blocks a concurrent destination edit",
  async () => {
    await clear();
    await savePending(record("pinned"));
    let accept, arrived;
    const dispatched = new Promise((resolve) => {
      arrived = resolve;
    });
    nativeHandler = (message) =>
      new Promise((resolve) => {
        NodeAssert.deepEqual(message.delivery.target, target);
        NodeAssert.equal(message.delivery.capture.text, source.text);
        accept = resolve;
        arrived();
      });
    const delivery = call({ type: "deliver", id: "pinned" });
    await dispatched;
    NodeAssert.equal((await readPending("pinned")).stage, "pending");
    const edit = call({
      type: "save",
      id: "pinned",
      note: "changed",
      target: { ...target, threadId: "wrong" },
    });
    accept({ ok: true, result: { id: "pinned", state: "pending", message: "Waiting" } });
    NodeAssert.equal((await delivery).result.state, "pending");
    NodeAssert.equal((await edit).ok, false);
    NodeAssert.deepEqual((await readPending("pinned")).target, target);
  },
);
NodeTest.test(
  "a lost native reply keeps bytes and retry uses the same identity until a saved receipt",
  async () => {
    await clear();
    await savePending(record("retry"));
    const requests = [];
    nativeHandler = async (message) => {
      requests.push(message);
      if (requests.length === 1) throw new Error("Lost native reply");
      return { ok: true, result: { id: "retry", state: "saved", message: "Saved" } };
    };
    NodeAssert.equal((await call({ type: "deliver", id: "retry" })).ok, false);
    NodeAssert.equal((await readPending("retry")).capture.text, source.text);
    NodeAssert.equal((await call({ type: "deliver", id: "retry" })).result.state, "saved");
    NodeAssert.deepEqual(requests[0], requests[1]);
    NodeAssert.equal(await readPending("retry"), null);
    NodeAssert.equal(session.get("lastReceipt").label, "Chosen chat");
  },
);
NodeTest.test("pending renderer claim cannot be retargeted or silently deleted", async () => {
  await clear();
  await savePending({ ...record("claimed"), stage: "pending" });
  nativeHandler = async () => ({
    ok: true,
    result: { id: "claimed", state: "pending", message: "Stark is saving this capture." },
  });
  NodeAssert.equal((await call({ type: "cancel-delivery", id: "claimed" })).ok, false);
  NodeAssert.equal((await call({ type: "delete", id: "claimed" })).ok, false);
  NodeAssert.deepEqual((await readPending("claimed")).target, target);
});
NodeTest.test(
  "confirmed cancellation replaces identity, preserving note, before another target is chosen",
  async () => {
    await clear();
    await savePending({ ...record("canceled"), stage: "pending" });
    nativeHandler = async () => ({
      ok: true,
      result: { id: "canceled", state: "discarded", message: "Canceled" },
    });
    NodeAssert.equal((await call({ type: "cancel-delivery", id: "canceled" })).ok, true);
    NodeAssert.equal(await readPending("canceled"), null);
    const [next] = await listPending();
    NodeAssert.notEqual(next.capture.id, "canceled");
    NodeAssert.equal(next.capture.note, source.note);
    NodeAssert.equal(next.target, null);
    NodeAssert.equal(next.stage, "review");
  },
);

NodeTest.test(
  "trusted extension UI also works in a tab, while page content scripts remain rejected",
  async () => {
    const response = await new Promise((resolve) => {
      NodeAssert.equal(listener({ type: "state" }, { ...sender, tab: { id: 1 } }, resolve), true);
    });
    NodeAssert.equal(response.ok, true);
    NodeAssert.equal(
      listener(
        { type: "state" },
        { id: extensionId, url: "https://example.com", tab: { id: 1 } },
        () => NodeAssert.fail("Page script received captures"),
      ),
      false,
    );
  },
);
