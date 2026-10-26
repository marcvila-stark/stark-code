// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const search = vi.hoisted(() => ({ targetId: null as string | null }));
vi.mock("./settingsLayout", () => ({
  useSettingsSearchTargetId: () => search.targetId,
  useSettingsSearchTarget: () => undefined,
}));

import { FoldedSettingsSection } from "./FoldedSettingsSection";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  search.targetId = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(openRequest = 0) {
  await act(async () => {
    root.render(
      <FoldedSettingsSection
        id="provider-instance-claude-runtime"
        title="Advanced agent settings"
        revealForTargets={["provider-runtime"]}
        openRequest={openRequest}
      >
        <label>
          Binary path
          <input aria-label="Binary path" />
        </label>
      </FoldedSettingsSection>,
    );
  });
}

it("keeps runtime fields quiet until opened, then allows closing them again", async () => {
  await render();
  const trigger = container.querySelector("button")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("input")).toBeNull();
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("input")?.getAttribute("aria-label")).toBe("Binary path");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("reopens a section requested by a page action after the user closes it", async () => {
  await render();
  await render(1);
  const trigger = container.querySelector("button")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await render(2);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

it("opens a folded runtime setting reached from search without reopening after a manual close", async () => {
  await render();
  search.targetId = "provider-runtime";
  await render();
  const trigger = container.querySelector("button")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("input")).not.toBeNull();
  await act(async () => trigger.click());
  await render();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("reopens when a new search requests the same setting after the earlier target was handled", async () => {
  search.targetId = "provider-runtime";
  await render();
  const trigger = container.querySelector("button")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  search.targetId = null;
  await render();
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  search.targetId = "provider-runtime";
  await render();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("input")).not.toBeNull();
});
