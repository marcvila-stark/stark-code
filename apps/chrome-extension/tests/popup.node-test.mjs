import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { JSDOM } from "jsdom";

NodeTest.test(
  "latest note is dispatched while the popup is alive, without waiting for an earlier save reply",
  async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><section id="panel"></section><div id="announcement"></div></body></html>',
      { url: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html" },
    );
    const ready = Promise.withResolvers(),
      writes = [];
    const target = {
      kind: "thread",
      environmentId: "env",
      projectId: "project",
      threadId: "chosen",
    };
    const record = {
      capture: {
        version: 1,
        id: "note-fixture",
        kind: "text",
        pageUrl: "https://example.com/docs",
        pageTitle: "Docs",
        capturedAt: "2026-11-02",
        text: "Quote",
        note: "",
      },
      target,
      targetLabel: "Chosen",
      projectLabel: "Project",
      stage: "review",
    };
    const observer = new dom.window.MutationObserver(() => {
      if (document.querySelector(".device")?.textContent === "Connected") ready.resolve();
    });
    Object.assign(globalThis, {
      document: dom.window.document,
      window: dom.window,
      addEventListener: dom.window.addEventListener.bind(dom.window),
      chrome: {
        runtime: {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sendMessage: (message) => {
            if (message.type === "state")
              return Promise.resolve({
                ok: true,
                result: structuredClone({
                  record,
                  records: [{ id: record.capture.id }],
                  extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                }),
              });
            if (message.type === "catalog")
              return Promise.resolve({ ok: true, result: { destinations: [], projects: [] } });
            if (message.type === "save") {
              const reply = Promise.withResolvers();
              writes.push({ message, reply });
              return reply.promise;
            }
            throw new Error("Unexpected message " + message.type);
          },
        },
      },
    });
    observer.observe(document.querySelector("#panel"), { subtree: true, childList: true });
    await import("../src/popup.js");
    await ready.promise;
    const input = document.querySelector("#note");
    input.value = "First note";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await Promise.resolve();
    NodeAssert.equal(writes.length, 1);
    input.value = "Final note before closing";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await Promise.resolve();
    NodeAssert.equal(writes.length, 2);
    NodeAssert.equal(writes[1].message.note, "Final note before closing");
    dom.window.close();
    observer.disconnect();
    for (const item of writes) item.reply.resolve({ ok: true });
  },
);
