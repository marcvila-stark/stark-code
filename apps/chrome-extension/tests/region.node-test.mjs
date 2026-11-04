import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { beginRegionSelection } from "../src/region.js";

function fixture() {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="source">Source</button></body></html>',
    { url: "https://example.com" },
  );
  let shadow;
  const attach = dom.window.HTMLElement.prototype.attachShadow;
  dom.window.HTMLElement.prototype.attachShadow = function (options) {
    shadow = attach.call(this, options);
    return shadow;
  };
  const messages = [],
    sent = Promise.withResolvers();
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    innerWidth: 1200,
    innerHeight: 800,
    requestAnimationFrame: (fn) => queueMicrotask(() => fn(0)),
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          sent.resolve(message);
        },
      },
    },
  });
  beginRegionSelection("region-fixture");
  const overlay = shadow.querySelector(".overlay");
  overlay.setPointerCapture = () => {};
  function pointer(type, x, y) {
    const event = new dom.window.MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    overlay.dispatchEvent(event);
  }
  pointer("pointerdown", 10, 20);
  pointer("pointermove", 110, 120);
  pointer("pointerup", 110, 120);
  return { dom, shadow, overlay, messages, sent };
}
NodeTest.test(
  "Enter on focused Cancel remains a native cancellation, never a region confirmation",
  async () => {
    const f = fixture();
    f.shadow.querySelector("#cancel").focus();
    const key = new f.dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(key);
    NodeAssert.equal(key.defaultPrevented, false);
    f.shadow.querySelector("#cancel").click();
    NodeAssert.equal((await f.sent.promise).type, "region-cancel");
    NodeAssert.equal(f.messages.length, 1);
    f.dom.window.close();
  },
);
NodeTest.test(
  "Enter on the region overlay confirms the exact drawn viewport rectangle",
  async () => {
    const f = fixture();
    f.overlay.focus();
    document.dispatchEvent(
      new f.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    const result = await f.sent.promise;
    NodeAssert.equal(result.type, "region-result");
    NodeAssert.deepEqual(result.rect, { x: 10, y: 20, width: 100, height: 100 });
    NodeAssert.deepEqual(result.viewport, { width: 1200, height: 800 });
    NodeAssert.equal(document.querySelector("body").children.length, 1);
    f.dom.window.close();
  },
);
