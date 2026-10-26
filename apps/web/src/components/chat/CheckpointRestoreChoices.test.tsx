import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  AlertDialogClose: () => <button>Cancel</button>,
}));
import { CheckpointRestoreChoices } from "./CheckpointRestoreChoices";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const base = () => ({
  shared: true,
  preview: null,
  pending: true,
  error: null,
  busy: false,
  canOperate: true,
  onCodeAndChat: vi.fn(),
  onChatOnly: vi.fn(),
  onCodeOnly: vi.fn(),
});

it("waits for a preview, shows retained-file reasons, and enables only meaningful restore choices", async () => {
  const props: ComponentProps<typeof CheckpointRestoreChoices> = base();
  await act(async () => {
    renderer = create(<CheckpointRestoreChoices {...props} />);
  });
  expect(button("Restore code and chat").props.disabled).toBe(true);
  expect(button("Restore chat only").props.disabled).toBe(false);
  const preview = {
    restorable: ["a.ts", "new.ts"],
    conflicts: [{ path: "owner.ts", reason: "changed since" }],
    untracked: ["shell.ts"],
    insertions: 2,
    deletions: 1,
  };
  await act(async () =>
    renderer!.update(<CheckpointRestoreChoices {...props} pending={false} preview={preview} />),
  );
  expect(renderer!.root.findAllByType("p")[0]!.children.join("")).toContain(
    "2 files the agent edited (+2 / -1)",
  );
  expect(renderer!.root.findAllByType("li").map((node) => node.children.join(""))).toEqual([
    "owner.ts: changed since",
    "shell.ts: not tracked by edit tools",
  ]);
  expect(button("Restore code and chat").props.disabled).toBe(false);
  await act(async () => button("Restore code only").props.onClick());
  expect(props.onCodeOnly).toHaveBeenCalledOnce();
  expect(props.onChatOnly).not.toHaveBeenCalled();
  expect(props.onCodeAndChat).not.toHaveBeenCalled();
  await act(async () =>
    renderer!.update(
      <CheckpointRestoreChoices
        {...props}
        pending={false}
        preview={{ ...preview, restorable: [], reason: "All files changed since." }}
      />,
    ),
  );
  expect(button("Restore code only").props.disabled).toBe(true);
  expect(button("Restore code and chat").props.disabled).toBe(true);
  expect(button("Restore chat only").props.disabled).toBe(false);
});

it("keeps isolated checkout restore available and disables all changes for a viewer or an in-flight restore", async () => {
  const props = base();
  await act(async () => {
    renderer = create(<CheckpointRestoreChoices {...props} shared={false} pending={false} />);
  });
  expect(button("Restore code and chat").props.disabled).toBe(false);
  await act(async () =>
    renderer!.update(<CheckpointRestoreChoices {...props} canOperate={false} pending={false} />),
  );
  for (const label of ["Restore code and chat", "Restore chat only", "Restore code only"])
    expect(button(label).props.disabled).toBe(true);
  await act(async () =>
    renderer!.update(<CheckpointRestoreChoices {...props} busy pending={false} />),
  );
  expect(button("Restore chat only").props.disabled).toBe(true);
});
