// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, type ProjectEntry } from "@starkfuture/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  entries: [] as ProjectEntry[],
  error: null as string | null,
  isPending: false,
  searchedQuery: "",
  search: vi.fn(),
}));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: (...args: unknown[]) => {
    state.search(...args);
    return { ...state, truncated: false };
  },
}));

import { ComposerContextPickerDialog } from "./ComposerContextPickerDialog";
import { isInsideComposerFloatingLayer } from "./composerEventScope";

let root: Root;
let container: HTMLDivElement;
const selected = vi.fn<(path: string) => boolean | void>();
const send = vi.fn();
const composerKey = vi.fn();
const environmentId = EnvironmentId.make("remote-test");

function Harness(props: { kind?: "file" | "directory"; open?: boolean; cwd?: string }) {
  const [open, setOpen] = useState(props.open ?? true);
  return (
    <form onSubmit={send} onKeyDown={composerKey}>
      <ComposerContextPickerDialog
        open={open}
        onOpenChange={setOpen}
        environmentId={environmentId}
        cwd={props.cwd ?? "/remote/work"}
        kind={props.kind ?? "directory"}
        onSelect={selected}
      />
    </form>
  );
}
const render = (props: Parameters<typeof Harness>[0] = {}) =>
  act(() => root.render(<Harness {...props} />));
const option = (path: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent === path,
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.entries = [
    { kind: "directory", path: "docs" },
    { kind: "file", path: "docs/readme.md" },
  ];
  state.error = null;
  state.isPending = false;
  state.searchedQuery = "";
  state.search.mockClear();
  selected.mockReset();
  send.mockReset();
  composerKey.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("browses folders in the destination environment without uploading their contents", async () => {
  await render();
  expect(state.search).toHaveBeenCalledWith(
    { environmentId, cwd: "/remote/work", kind: "directory", query: "" },
    100,
    { allowEmptyQuery: true },
  );
  expect(option("docs/readme.md")).toBeUndefined();
  expect(document.body.textContent).toContain("Its contents are not uploaded");
  const popup = document.querySelector('[data-slot="command-dialog-popup"]');
  expect(isInsideComposerFloatingLayer(popup)).toBe(true);
  expect(isInsideComposerFloatingLayer(popup?.querySelector("input") ?? null)).toBe(true);
  await act(() => option("docs")!.click());
  expect(selected).toHaveBeenCalledExactlyOnceWith("docs");
  expect(document.querySelector('[data-testid="composer-context-picker"]')).toBeNull();
});

it("does not expose stale paths while a new search is pending", async () => {
  state.isPending = true;
  await render({ kind: "file" });
  expect(option("docs/readme.md")).toBeUndefined();
  expect(selected).not.toHaveBeenCalled();
});

it("does not expose cached paths after access is denied", async () => {
  state.error = "This connection cannot search host files.";
  await render({ kind: "file" });
  expect(option("docs/readme.md")).toBeUndefined();
  expect(document.body.textContent).toContain(state.error);
  expect(selected).not.toHaveBeenCalled();
});

it("keeps the picker open when the composer rejects a reference", async () => {
  selected.mockReturnValue(false);
  await render();
  await act(() => option("Current workspace folder")!.click());
  expect(selected).toHaveBeenCalledWith("/remote/work");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("composer is busy");
  expect(option("docs")).toBeDefined();
});

it("does not search the filesystem when closed", async () => {
  await render({ open: false });
  expect(state.search).not.toHaveBeenCalled();
});

it("keeps Enter inside the picker rather than submitting the message", async () => {
  await render({ kind: "file" });
  const input = document.querySelector<HTMLInputElement>("input")!;
  await act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  composerKey.mockClear();
  await act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  expect(selected).toHaveBeenCalledExactlyOnceWith("docs/readme.md");
  expect(send).not.toHaveBeenCalled();
  expect(composerKey).not.toHaveBeenCalled();
});
