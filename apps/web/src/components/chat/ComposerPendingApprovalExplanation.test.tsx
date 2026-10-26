// @vitest-environment jsdom
import { RuntimeRequestId } from "@starkfuture/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { type PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

let root: Root;
let container: HTMLDivElement;
const approval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval"),
  requestKind: "command",
  createdAt: "2026-10-20T00:00:00Z",
  detail: "git status",
  responseCapability: "live",
};
const render = (next: PendingApproval) =>
  act(() => root.render(<ComposerPendingApprovalPanel approval={next} pendingCount={1} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("never interprets an agent's benign prose as the command awaiting approval", async () => {
  await render(approval);
  expect(container.querySelector('[aria-label="Command explanation"]')?.textContent).toContain(
    "details are unavailable",
  );
  await render({ ...approval, command: "git reset --hard HEAD" });
  expect(container.querySelector('[aria-label="Exact command"]')?.textContent).toBe(
    "git reset --hard HEAD",
  );
  expect(container.querySelector('[aria-label="Command explanation"]')?.textContent).toContain(
    "Uncommitted changes can be lost",
  );
  expect(container.querySelector('[aria-label="Command"]')?.textContent).toBe("git status");
});

it("updates warnings with the pending command and removes them for non-live or non-command requests", async () => {
  await render({ ...approval, command: "git clean -fdx" });
  expect(container.textContent).toContain("Caution:");
  await render({ ...approval, command: "git status" });
  expect(container.textContent).not.toContain("Caution:");
  expect(container.textContent).toContain("Shows which files");
  await render({ ...approval, responseCapability: "not_resumable", command: "git status" });
  expect(container.querySelector('[aria-label="Command explanation"]')).toBeNull();
  expect(container.textContent).toContain("Provider process is gone");
  await render({ ...approval, requestKind: "file-read" });
  expect(container.querySelector('[aria-label="Command explanation"]')).toBeNull();
});

it("keeps the destructive part visible while allowing the user to inspect all steps", async () => {
  await render({ ...approval, command: "git status && rm -rf build" });
  expect(container.textContent).toContain("Deletes the selected files");
  expect(container.textContent).not.toContain("Shows which files");
  const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
  await act(() => disclosure.click());
  expect(container.textContent).toContain("Shows which files");
  expect(container.textContent).toContain("Affected files have not been checked");
  await render({ ...approval, requestId: RuntimeRequestId.make("next"), command: "git status" });
  expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
});
