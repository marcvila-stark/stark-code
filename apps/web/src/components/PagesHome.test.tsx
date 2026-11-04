// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  projects: [] as { id: string; environmentId: string; workspaceRoot: string; title: string }[],
  navigate: vi.fn(),
  websiteMount: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("./pagesWebsiteEnvironment", () => ({ usePagesWebsiteEnvironment: () => "local" }));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./PagesWebsiteView", () => ({
  PagesWebsiteView: ({ active }: { active: boolean }) => {
    useEffect(() => {
      state.websiteMount();
    }, []);
    return (
      <div aria-label="Company website" data-active={active}>
        Company website
      </div>
    );
  },
}));
vi.mock("./PublishedStarkPages", () => ({ PublishedStarkPages: () => <div>Company library</div> }));
vi.mock("./StarkPagesSidebar", () => ({
  StarkPagesSidebar: ({ projectRoot }: { projectRoot: string }) => (
    <div>Local folder: {projectRoot}</div>
  ),
}));
import { PagesHome } from "./PagesHome";
let root: Root;
let host: HTMLDivElement;
async function click(label: string) {
  const target = [...document.querySelectorAll<HTMLElement>('button,[role="option"]')].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  );
  if (!target) throw new Error(`Missing ${label}`);
  await act(() => target.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { pagesWebsite: {} },
  });
  state.projects = [];
  state.navigate.mockReset();
  state.websiteMount.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("opens Company Pages before any chat or folder exists without navigating or creating a chat", async () => {
  await act(() => root.render(<PagesHome />));
  expect(
    document.querySelector('[aria-label="Company website"]')?.getAttribute("data-active"),
  ).toBe("true");
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.websiteMount).toHaveBeenCalledTimes(1);
});
it("uses an explicitly selected local folder and never exposes a remote folder to desktop file access", async () => {
  state.projects = [
    { id: "work", environmentId: "local", workspaceRoot: "/work", title: "Work" },
    { id: "remote", environmentId: "remote", workspaceRoot: "/server/private", title: "Remote" },
  ];
  await act(() => root.render(<PagesHome folder="/server/private" />));
  await click("Choose Pages source");
  await click("Local pages");
  expect(document.body.textContent).toContain("Choose the folder whose pages");
  expect(document.body.textContent).not.toContain("Local folder: /server/private");
  await click("Local pages folder");
  expect(document.body.textContent).not.toContain("Remote ·");
  await click("Work · /work");
  expect(document.body.textContent).toContain("Local folder: /work");
  expect(state.navigate).not.toHaveBeenCalled();
  await click("Choose Pages source");
  await click("Company pages");
  expect(state.websiteMount).toHaveBeenCalledTimes(1);
});
