import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

import { htmlRenderShortcutsMessage, injectHtmlRenderBootstrap } from "./htmlRender.ts";

function keyboardBridge() {
  type Listener = { callback: (event: unknown) => void; capture: boolean };
  const listeners = new Map<string, Listener[]>();
  const postMessage = vi.fn();
  const parent = { postMessage };
  const window = {
    parent,
    addEventListener(type: string, callback: Listener["callback"], capture = false) {
      listeners.set(type, [...(listeners.get(type) ?? []), { callback, capture }]);
    },
    removeEventListener(type: string, callback: Listener["callback"]) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((listener) => listener.callback !== callback),
      );
    },
  };
  const bootstrap = injectHtmlRenderBootstrap("<p>Preview</p>").match(
    /<script>([\s\S]*?)<\/script>/,
  )?.[1];
  expect(bootstrap).toBeDefined();
  NodeVM.runInNewContext(bootstrap!, {
    window,
    document: { getElementById: () => ({}), addEventListener: () => {} },
    location: { hash: "" },
    setTimeout: () => {},
  });
  return {
    postMessage,
    allowEscape() {
      const data = htmlRenderShortcutsMessage(
        [{ key: "escape", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }],
        [],
      );
      for (const listener of listeners.get("message") ?? [])
        listener.callback({ source: parent, data });
    },
    press(
      options: { handled?: boolean; trusted?: boolean; composing?: boolean; input?: boolean } = {},
    ) {
      const event = {
        key: "Escape",
        code: "Escape",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        repeat: false,
        isTrusted: options.trusted ?? true,
        isComposing: options.composing ?? false,
        defaultPrevented: false,
        getModifierState: () => false,
        composedPath: () => [{ tagName: options.input === false ? "BUTTON" : "INPUT" }],
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of listeners.get("keydown") ?? [])
        if (listener.capture) listener.callback(event);
      if (options.handled) event.preventDefault();
      for (const listener of listeners.get("keydown") ?? [])
        if (!listener.capture) listener.callback(event);
    },
  };
}

it("forwards an unhandled Escape from a text field only when the host advertises it", () => {
  const bridge = keyboardBridge();
  bridge.press();
  expect(bridge.postMessage).not.toHaveBeenCalled();
  bridge.allowEscape();
  bridge.press();
  expect(bridge.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "stark-code/notifications/keydown",
      params: expect.objectContaining({ key: "Escape", code: "Escape" }),
    }),
    "*",
  );
});

it.each([{ handled: true }, { trusted: false }, { composing: true }])(
  "keeps page-handled, untrusted and composing keys inside the preview: %j",
  (options) => {
    const bridge = keyboardBridge();
    bridge.allowEscape();
    bridge.press(options);
    expect(bridge.postMessage).not.toHaveBeenCalled();
  },
);
