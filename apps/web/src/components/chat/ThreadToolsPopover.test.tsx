// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ThreadToolsPopover } from "./ThreadToolsPopover";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!element) throw new Error(`Button missing: ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

it.each(["Workspace", "Pages", "Shell mode"])(
  "dismisses Thread tools before opening %s",
  async (label) => {
    const openSurface = vi.fn();
    await act(async () =>
      root.render(
        <ThreadToolsPopover
          actions={(closeTools) => (
            <Button
              onClick={() => {
                closeTools();
                openSurface();
              }}
            >
              {label}
            </Button>
          )}
        />,
      ),
    );
    await click("Thread tools");
    expect(button("Thread tools").getAttribute("aria-expanded")).toBe("true");
    await click(label);
    expect(openSurface).toHaveBeenCalledOnce();
    expect(button("Thread tools").getAttribute("aria-expanded")).toBe("false");
  },
);

it("keeps the parent and MCP tool mounted while its nested popover is open", async () => {
  const unmounted = vi.fn();
  function McpTool() {
    const [open, setOpen] = useState(false);
    useEffect(
      () => () => {
        unmounted();
      },
      [],
    );
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button>MCP</Button>} />
        <PopoverPopup>
          <p>MCP connected</p>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </PopoverPopup>
      </Popover>
    );
  }
  await act(async () => root.render(<ThreadToolsPopover tools={<McpTool />} />));
  await click("Thread tools");
  await click("MCP");
  expect(button("Thread tools").getAttribute("aria-expanded")).toBe("true");
  expect(button("MCP").getAttribute("aria-expanded")).toBe("true");
  expect(document.body.textContent).toContain("MCP connected");
  expect(unmounted).not.toHaveBeenCalled();
  await click("Done");
  expect(button("Thread tools").getAttribute("aria-expanded")).toBe("true");
  expect(button("MCP").getAttribute("aria-expanded")).toBe("false");
  expect(unmounted).not.toHaveBeenCalled();
});
