// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@starkfuture/contracts";
import { DraftId } from "../../composerDraftStore";
import {
  sidebarAccountContextKey,
  usePublishSidebarAccountContext,
  useSidebarAccountContexts,
  type SidebarAccountContext,
} from "./sidebarAccountContext";

afterEach(() => {
  useSidebarAccountContexts.setState({ contexts: {} });
  vi.unstubAllGlobals();
});
it("scopes same-named threads by computer and keeps a draft separate from server history", () => {
  const threadId = ThreadId.make("thread");
  expect(
    sidebarAccountContextKey({
      kind: "server",
      threadRef: { environmentId: EnvironmentId.make("remote"), threadId },
    }),
  ).not.toBe(
    sidebarAccountContextKey({
      kind: "server",
      threadRef: { environmentId: EnvironmentId.make("local"), threadId },
    }),
  );
  expect(sidebarAccountContextKey({ kind: "draft", draftId: DraftId.make("thread") })).toBe(
    "draft:thread",
  );
});
it("publishes provider changes and removes obsolete context on navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const base: SidebarAccountContext = {
    environmentId: EnvironmentId.make("remote"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    entries: [],
    unavailableReason: null,
    getModelDisabledReason: () => null,
    onSelect: vi.fn(),
  };
  function Publisher({ route, context }: { route: string; context: SidebarAccountContext }) {
    usePublishSidebarAccountContext(route, context);
    return null;
  }
  await act(() => root.render(<Publisher route="draft:one" context={base} />));
  expect(useSidebarAccountContexts.getState().contexts["draft:one"]?.instanceId).toBe(
    "claudeAgent",
  );
  await act(() =>
    root.render(
      <Publisher
        route="draft:one"
        context={{ ...base, instanceId: ProviderInstanceId.make("codex") }}
      />,
    ),
  );
  expect(useSidebarAccountContexts.getState().contexts["draft:one"]?.instanceId).toBe("codex");
  await act(() =>
    root.render(
      <Publisher
        route="draft:two"
        context={{ ...base, environmentId: EnvironmentId.make("other") }}
      />,
    ),
  );
  expect(useSidebarAccountContexts.getState().contexts["draft:one"]).toBeUndefined();
  expect(useSidebarAccountContexts.getState().contexts["draft:two"]?.environmentId).toBe("other");
  await act(() => root.unmount());
  expect(useSidebarAccountContexts.getState().contexts).toEqual({});
});
