// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { FinishEvidenceCard } from "./FinishEvidenceCard";
import type { FinishEvidence } from "./finishEvidence";

let root: Root;
let container: HTMLDivElement;
const evidence: FinishEvidence = {
  runId: "reply-one",
  runStatus: "completed",
  completedAt: "2026-10-22T12:00:00Z",
  commands: [
    {
      id: "check",
      command: "npm test",
      isCheck: true,
      outcome: "exit-zero",
      exitCode: 0,
      startedAt: "2026-10-22T11:59:00Z",
      completedAt: "2026-10-22T11:59:30Z",
      freshness: "no-later-reported-edits",
      laterFiles: [],
    },
    {
      id: "unknown",
      command: "git status",
      isCheck: false,
      outcome: "unknown",
      exitCode: null,
      startedAt: null,
      completedAt: null,
      freshness: "no-later-reported-edits",
      laterFiles: [],
    },
  ],
  files: [],
  unconfirmedFileChanges: 0,
  failedCount: 0,
  unknownCount: 1,
  zeroExitChecks: 1,
  staleChecks: 0,
  unknownTimingChecks: 0,
};

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
async function render(value: FinishEvidence | null = evidence) {
  await act(() => root.render(<FinishEvidenceCard evidence={value} />));
}
function trigger() {
  return container.querySelector<HTMLButtonElement>('[aria-label="Reply details"]')!;
}
async function open() {
  trigger().focus();
  await act(() => trigger().click());
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

it("keeps uncertain activity out of the transcript until requested, then shows literal results", async () => {
  await render();
  expect(container.textContent).toBe("Details");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const popup = await open();
  expect(popup).not.toBeNull();
  expect(container.contains(popup)).toBe(false);
  expect(popup.textContent).toContain("npm test");
  expect(popup.textContent).toContain("Exit 0");
  expect(popup.textContent).toContain("git status");
  expect(popup.textContent).toContain("One command has no recorded final result.");
  expect(popup.textContent).toContain("Exit code not reported");
  expect(popup.textContent).not.toContain("tests passed");
  expect(popup.querySelector('[class*="text-warning"]')).toBeNull();
});

it("closes with Escape and the close button, keeping the original trigger available", async () => {
  await render();
  const popup = await open();
  await act(() =>
    popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await open();
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close reply details"]')!;
  await act(() => close.click());
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

it("retains failed and outdated check results without putting a warning on the transcript", async () => {
  await render({
    ...evidence,
    failedCount: 1,
    staleChecks: 1,
    commands: [
      { ...evidence.commands[0]!, outcome: "failed", exitCode: 2 },
      { ...evidence.commands[0]!, id: "stale", freshness: "changed", laterFiles: ["app.ts"] },
    ],
  });
  expect(container.textContent).toBe("Details");
  const popup = await open();
  expect(popup.textContent).toContain("Exit 2 · failure reported");
  expect(popup.textContent).toContain("Those results may not cover the final edits.");
  expect(popup.textContent).toContain("Files edited later: app.ts");
});

it("closes old details when switching replies and renders nothing without recorded activity", async () => {
  await render();
  await open();
  await render({ ...evidence, runId: "reply-two" });
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await render(null);
  expect(container.textContent).toBe("");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
