// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { pagesWebsitePresentation } from "./pagesWebsitePresentation";

let host: HTMLDivElement;
const bounds = (element: HTMLElement, x: number, y: number, width: number, height: number) =>
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(x, y, width, height));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("innerWidth", 1200);
  vi.stubGlobal("innerHeight", 800);
  bounds(host, 700, 120, 500, 680);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("clips a native Pages view to the visible app viewport", () => {
  bounds(host, 700, 120, 800, 900);
  expect(pagesWebsitePresentation(host, true)).toEqual({
    x: 700,
    y: 120,
    width: 500,
    height: 680,
    visible: true,
  });
});

it("hides the native surface for inactive or hidden panels without discarding it", () => {
  expect(pagesWebsitePresentation(host, false).visible).toBe(false);
  host.hidden = true;
  expect(pagesWebsitePresentation(host, true).visible).toBe(false);
  host.hidden = false;
  expect(pagesWebsitePresentation(host, true).visible).toBe(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  expect(pagesWebsitePresentation(host, true).visible).toBe(false);
});

it("uncovers overlapping menus, but keeps Pages visible beside unrelated controls", () => {
  const menu = document.createElement("div");
  menu.dataset.slot = "menu-popup";
  document.body.append(menu);
  bounds(menu, 20, 80, 200, 300);
  expect(pagesWebsitePresentation(host, true).visible).toBe(true);
  bounds(menu, 680, 80, 240, 300);
  expect(pagesWebsitePresentation(host, true).visible).toBe(false);
  expect(pagesWebsitePresentation(host, true).captureSnapshot).toBe(true);
  expect(pagesWebsitePresentation(host, false).captureSnapshot).toBeUndefined();
  menu.hidden = true;
  expect(pagesWebsitePresentation(host, true).visible).toBe(true);
  expect(pagesWebsitePresentation(host, true).captureSnapshot).toBeUndefined();
  menu.hidden = false;
  menu.dataset.endingStyle = "";
  expect(pagesWebsitePresentation(host, true).visible).toBe(true);
  delete menu.dataset.endingStyle;
  menu.dataset.closed = "";
  expect(pagesWebsitePresentation(host, true).visible).toBe(true);
});

it("keeps the surface visible inside its own expanded dialog", () => {
  const dialog = document.createElement("div");
  dialog.dataset.slot = "dialog-popup";
  document.body.append(dialog);
  dialog.append(host);
  bounds(dialog, 0, 0, 1200, 800);
  expect(pagesWebsitePresentation(host, true).visible).toBe(true);
  const otherDialog = document.createElement("div");
  otherDialog.dataset.slot = "dialog-popup";
  document.body.append(otherDialog);
  bounds(otherDialog, 600, 200, 500, 400);
  expect(pagesWebsitePresentation(host, true).visible).toBe(false);
});
