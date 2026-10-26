import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type SavedPermissionRuleFile } from "@starkfuture/contracts";
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    disabled: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
import { PermissionRuleFileList } from "./PermissionRulesSettings";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("opens only the server-provided file and forgets only the chosen opaque rule id with a settings grant", async () => {
  const file = {
    providerInstanceId: ProviderInstanceId.make("claude"),
    provider: "claudeAgent",
    scope: "worktree",
    path: "/worktree/.claude/settings.local.json",
    exists: true,
    rules: [{ id: "revision:1", text: "Bash(npm test)" }],
  } satisfies SavedPermissionRuleFile;
  const onOpen = vi.fn();
  const onForget = vi.fn();
  const render = (canForget: boolean) => (
    <PermissionRuleFileList
      files={[file]}
      canForget={canForget}
      canOpen
      busy={false}
      onOpen={onOpen}
      onForget={onForget}
    />
  );
  await act(async () => {
    renderer = create(render(false));
  });
  expect(renderer!.root.findAllByType("button")).toHaveLength(1);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(onOpen).toHaveBeenCalledWith(file.path);
  await act(async () => renderer!.update(render(true)));
  await act(async () => renderer!.root.findAllByType("button")[1]!.props.onClick());
  expect(onForget).toHaveBeenCalledWith(file, "revision:1");
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
});
