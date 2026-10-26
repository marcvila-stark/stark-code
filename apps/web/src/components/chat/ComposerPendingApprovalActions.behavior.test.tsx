import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { RuntimeRequestId, type ProviderApprovalOption } from "@starkfuture/contracts";
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({
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
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("requires the settings grant, shows exact rule and warning before the remembered approval click", async () => {
  const onRespond = vi.fn().mockResolvedValue(undefined);
  const requestId = RuntimeRequestId.make("approval");
  const options = [
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Approve" },
    { decision: "acceptForSession", label: "Allow for this session" },
    {
      decision: "acceptAlways",
      label: "Always allow (Codex, every project)",
      rulePreview: ['prefix_rule(pattern=["npm","test"], decision="allow")'],
      warning: "Runs outside the sandbox.",
    },
  ] satisfies ProviderApprovalOption[];
  const render = (canRemember: boolean, canRespond = true) => (
    <ComposerPendingApprovalActions
      requestId={requestId}
      isResponding={false}
      canRespond={canRespond}
      canRemember={canRemember}
      options={options}
      onRespondToApproval={onRespond}
    />
  );
  await act(async () => {
    renderer = create(render(false));
  });
  expect(renderer!.root.findAllByType("code")).toHaveLength(0);
  expect(renderer!.root.findAllByType("button")).toHaveLength(3);
  await act(async () => renderer!.update(render(true)));
  expect(renderer!.root.findByType("code").children.join("")).toBe(options[3]!.rulePreview![0]);
  expect(
    renderer!.root
      .findAllByType("span")
      .some((span) => span.children.join("") === "Runs outside the sandbox."),
  ).toBe(true);
  await act(async () => renderer!.root.findAllByType("button")[3]!.props.onClick());
  expect(onRespond).toHaveBeenCalledWith(requestId, "acceptAlways");
  await act(async () => renderer!.update(render(true, false)));
  await act(async () => renderer!.root.findAllByType("button")[3]!.props.onClick());
  expect(onRespond).toHaveBeenCalledTimes(1);
});
