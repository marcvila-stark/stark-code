// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ copy: vi.fn(), show: vi.fn() }));
vi.mock("../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
import { NativeMcpReloadControl } from "./NativeMcpReloadControl";
let root: Root;
let container: HTMLDivElement;
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === text,
  );
  if (!found) throw new Error(`Button missing: ${text}`);
  return found;
};
const click = (text: string) => act(async () => button(text).click());
async function render(driver: string) {
  await act(() =>
    root.render(<NativeMcpReloadControl driver={driver} onShowTerminal={state.show} />),
  );
  await click(driver === "codex" ? "Connections" : "Reload plugins");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.copy.mockReset().mockResolvedValue(undefined);
  state.show.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("offers an explicit Claude plugin reload command without running it or forcing cache changes", async () => {
  await render("claudeAgent");
  expect(state.copy).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("does not download plugin updates");
  expect(document.body.textContent).not.toContain("/reload-plugins --force");
  expect(document.body.textContent).not.toContain("/mcp reconnect all");
  await click("Copy /reload-plugins");
  expect(state.copy).toHaveBeenLastCalledWith("/reload-plugins", "native MCP command");
  expect(document.body.textContent).toContain("It has not been run.");
  expect(state.show).not.toHaveBeenCalled();
  await click("Copy /mcp");
  expect(state.copy).toHaveBeenLastCalledWith("/mcp", "native MCP command");
  expect(document.body.textContent).toContain("It has not been run.");
  expect(state.show).not.toHaveBeenCalled();
  await click("Show terminal");
  expect(state.show).toHaveBeenCalledExactlyOnceWith();
});
it("explains Codex's individual reconnect limitation and offers only its inspection command", async () => {
  await render("codex");
  expect(document.body.textContent).toContain(
    "no live MCP reload command in this terminal",
  );
  expect(document.body.textContent).not.toContain("/reload-plugins");
  expect(document.body.textContent).not.toContain("/mcp reconnect");
  await click("Copy /mcp");
  expect(state.copy).toHaveBeenCalledExactlyOnceWith("/mcp", "native MCP command");
  expect(state.show).not.toHaveBeenCalled();
});
it("coalesces repeated copy clicks and reports a clipboard failure honestly", async () => {
  let reject: (reason: Error) => void = () => {};
  state.copy.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await render("claudeAgent");
  await act(() => {
    button("Copy /mcp").click();
    button("Copy /mcp").click();
  });
  expect(state.copy).toHaveBeenCalledTimes(1);
  await act(() => reject(new Error("Clipboard unavailable")));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(state.show).not.toHaveBeenCalled();
});
