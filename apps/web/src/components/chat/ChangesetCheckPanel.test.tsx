// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@starkfuture/contracts";
const state = vi.hoisted(() => ({ allowed: true, check: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/changesetCheck", () => ({ checkChangesets: { permissionAtom: () => null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.check }));
import { ChangesetCheckPanel } from "./ChangesetCheckPanel";
let root: Root, el: HTMLDivElement;
const draft = vi.fn();
const render = () =>
  act(() => {
    root.render(
      <ChangesetCheckPanel
        threadRef={{
          environmentId: EnvironmentId.make("local"),
          threadId: ThreadId.make("thread"),
        }}
        cwd="/workspace"
        onDraftFix={draft}
      />,
    );
  });
const click = (label: string) =>
  act(async () => {
    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button).toBeDefined();
    button!.click();
  });
beforeEach(() => {
  state.allowed = true;
  state.check.mockReset();
  draft.mockReset();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});
it("does not run on mount; shows missing coverage and only drafts a request after a click", async () => {
  state.check.mockResolvedValue({
    _tag: "Success",
    value: {
      checkedAt: "2026-10-20T10:00:00Z",
      base: "Uncommitted changes",
      warnings: [],
      packages: [
        {
          name: "@starkfuture/types",
          directory: "packages/types",
          changesets: [],
          staged: true,
          stagedCovered: false,
        },
      ],
    },
  });
  render();
  expect(state.check).not.toHaveBeenCalled();
  await click("Check changesets");
  expect(el.textContent).toContain("Missing changeset");
  expect(draft).not.toHaveBeenCalled();
  await click("Draft a fix request");
  expect(draft.mock.calls[0]?.[0]).toContain("Ask me before writing or staging anything");
  expect(state.check).toHaveBeenCalledTimes(1);
});
it("disables inspection without filesystem permission", async () => {
  state.allowed = false;
  render();
  await click("Check changesets");
  expect(state.check).not.toHaveBeenCalled();
});
it("checks a chosen nested repository without creating another workspace", async () => {
  state.check.mockResolvedValue({
    _tag: "Success",
    value: {
      checkedAt: "2026-10-20T10:00:00Z",
      base: "Uncommitted changes",
      warnings: [],
      packages: [],
    },
  });
  render();
  await act(async () => {
    const input = el.querySelector<HTMLInputElement>('input[name="repository"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "/workspace/backend",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Check changesets");
  expect(state.check).toHaveBeenCalledWith({
    environmentId: "local",
    input: { cwd: "/workspace/backend" },
  });
});
it("holds another click while a check is running", async () => {
  let done!: (value: unknown) => void;
  state.check.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  render();
  await click("Check changesets");
  await click("Checking…");
  expect(state.check).toHaveBeenCalledTimes(1);
  await act(async () =>
    done({
      _tag: "Success",
      value: {
        checkedAt: "2026-10-20T10:00:00Z",
        base: "Uncommitted changes",
        warnings: [],
        packages: [],
      },
    }),
  );
  expect(el.textContent).toContain("No changed publishable package");
});
