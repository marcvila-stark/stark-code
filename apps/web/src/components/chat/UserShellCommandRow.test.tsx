import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const copy = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("./ShellCommandBlock", () => ({
  ShellCommandBlock: ({ command }: { command: string }) => <code>{command}</code>,
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: copy }));
import {
  UserShellCommandRow,
  userShellStatus,
  type UserShellCommandItem,
} from "./UserShellCommandRow";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  copy.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("streams output into a user row, expands long output and opens the stored full file", async () => {
  const onOpen = vi.fn();
  const item = (output: string, status = "running") =>
    ({
      type: "command_execution",
      source: "user_shell",
      input: "pwd",
      output,
      status,
      ...(status === "completed"
        ? { exitCode: 0, durationMs: 1800, fullOutputPath: "/attachments/shell-output-log.log" }
        : {}),
    }) as UserShellCommandItem;
  const row = (current: UserShellCommandItem) => (
    <UserShellCommandRow command="pwd" respond={false} item={current} onOpenFullOutput={onOpen} />
  );
  await act(async () => {
    renderer = create(row(item("first\n")));
  });
  expect(renderer!.root.findByType("pre").children.join("")).toBe("first\n");
  const output = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");
  await act(async () => renderer!.update(row(item(output, "completed"))));
  expect(renderer!.root.findByType("pre").children.join("")).not.toContain("line 25");
  const button = (label: string) =>
    renderer!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
  await act(async () => button("Show all").props.onClick());
  expect(renderer!.root.findByType("pre").children.join("")).toContain("line 25");
  await act(async () => button("Copy").props.onClick());
  expect(copy).toHaveBeenCalledWith(`pwd\n${output}`);
  await act(async () => button("Full output saved").props.onClick());
  expect(onOpen).toHaveBeenCalledWith("/attachments/shell-output-log.log");
  expect(
    renderer!.root
      .findAllByType("span")
      .flatMap((node) => node.children)
      .join(" ")
      .replace(/\s+/g, " "),
  ).toContain("exit 0 · 1.8s");
  expect(renderer!.root.findByType("p").children.join("")).toContain("next message");
});

it("shows exit, timeout, stopped, failed and queued outcomes", () => {
  const item = (patch: Partial<UserShellCommandItem>) =>
    ({
      type: "command_execution",
      input: "false",
      status: "completed",
      ...patch,
    }) as UserShellCommandItem;
  expect(userShellStatus(item({ exitCode: 1 }))).toBe("exit 1");
  expect(userShellStatus(item({ timedOut: true }))).toBe("timed out");
  expect(userShellStatus(item({ interrupted: true }))).toBe("stopped");
  expect(userShellStatus(item({ status: "failed" }))).toBe("failed to start");
  expect(userShellStatus(null)).toBe("Queued");
});
