import {
  EnvironmentId,
  ThreadId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@starkfuture/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  hasTask: true,
  toggle: vi.fn(),
  run: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../settings/ScheduledTasksSettings", () => ({
  relativeLabel: () => "later",
  scheduleLabel: () => "daily",
}));
vi.mock("../settings/ScheduledTaskRunsDialog", () => ({ ScheduledTaskRunsDialog: () => null }));
vi.mock("../../state/scheduledTaskRuns", () => ({
  scheduledTaskRunNowClickIds: { begin: () => "click", end: () => undefined },
  useEnvironmentKeepsRunHistory: () => true,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => null,
    setScheduledTaskEnabled: "toggle",
    runScheduledTaskNow: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "toggle" ? state.toggle : state.run),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: state.hasTask ? [task] : [] }, error: null }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (x: unknown) => x,
}));

import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const task = {
  id: ScheduledTaskId.make("task"),
  threadId,
  title: "Daily review",
  enabled: true,
  schedule: { type: "interval", everyMs: 60000 },
  lastRunStatus: "never",
} as ScheduledTask;
let renderer: ReactTestRenderer;
beforeEach(() => {
  state.allowed = true;
  state.hasTask = true;
  state.navigate.mockReset();
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it.each([true, false])("runs scheduled work only with task permission (%s)", async (allowed) => {
  state.allowed = allowed;
  await act(async () => {
    renderer = create(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />);
  });
  const run = renderer.root.findAllByProps({ "aria-label": "Run Daily review now" })[0]!;
  await act(async () => {
    await run.props.onClick();
  });
  expect(state.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("rejects a retained toggle after task permission is revoked", async () => {
  await act(async () => {
    renderer = create(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />);
  });
  const toggle = renderer.root
    .findAllByProps({ "aria-label": "Pause Daily review" })
    .find((node) => node.props.onCheckedChange)!;
  state.allowed = false;
  await act(async () => {
    await toggle.props.onCheckedChange(false);
  });
  expect(state.toggle).not.toHaveBeenCalled();
});

it("does not offer automation setup on a chat with no existing tasks", async () => {
  state.hasTask = false;
  await act(async () => {
    renderer = create(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />);
  });
  expect(renderer.toJSON()).toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
});

it("retains pause and edit controls for an existing automation", async () => {
  await act(async () => {
    renderer = create(<ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />);
  });
  const toggle = renderer.root
    .findAllByProps({ "aria-label": "Pause Daily review" })
    .find((node) => node.props.onCheckedChange)!;
  await act(async () => {
    await toggle.props.onCheckedChange(false);
  });
  expect(state.toggle).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { id: task.id, enabled: false },
  });
  const edit = renderer.root.findAllByProps({ "aria-label": "Edit Daily review" })[0]!;
  await act(async () => {
    edit.props.onClick();
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/settings/scheduled-tasks",
    search: { environmentId, taskId: task.id },
  });
});
