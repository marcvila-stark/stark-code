import "fake-indexeddb/auto";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { listPending } from "../src/pending.js";

NodeTest.test("a repeated image URL never falls back to the wrong on-page instance", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><img src="https://cdn.example.com/repeated.png"><img src="https://cdn.example.com/repeated.png"></body></html>',
    { url: "https://example.com/docs" },
  );
  let clicked,
    screenshots = 0;
  const failed = Promise.withResolvers();
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    chrome: {
      runtime: {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        getURL: (path) => "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" + path,
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
      },
      contextMenus: {
        onClicked: {
          addListener: (fn) => {
            clicked = fn;
          },
        },
      },
      commands: { onCommand: { addListener() {} } },
      scripting: { executeScript: async ({ func, args }) => [{ result: func(...args) }] },
      tabs: {
        query: async () => [{ id: 1, url: "https://example.com/docs" }],
        captureVisibleTab: async () => {
          screenshots++;
          throw new Error("Wrong fallback");
        },
      },
      storage: {
        session: {
          set: async (values) => {
            if (values.captureError) failed.resolve(values.captureError);
          },
        },
      },
      action: { async setBadgeText() {}, async openPopup() {} },
    },
  });
  await import("../src/worker.js");
  clicked(
    { menuItemId: "stark-image", frameId: 0, srcUrl: "https://cdn.example.com/repeated.png" },
    { id: 1, windowId: 2, url: "https://example.com/docs", title: "Docs" },
  );
  NodeAssert.match(await failed.promise, /appears more than once/);
  NodeAssert.equal(screenshots, 0);
  NodeAssert.equal((await listPending()).length, 0);
  dom.window.close();
});
