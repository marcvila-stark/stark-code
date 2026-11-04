import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { RuntimeRequestId, type ProviderApprovalOption } from "@starkfuture/contracts";
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "data-default-choice"?: boolean;
  }) => (
    <button
      disabled={disabled}
      onClick={onClick}
      data-default-choice={props["data-default-choice"]}
    >
      {children}
    </button>
  ),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <em>{children}</em>,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: {
    value: string;
    autoFocus?: boolean;
    onChange: (event: { target: { value: string } }) => void;
  }) => <textarea value={props.value} autoFocus={props.autoFocus} onChange={props.onChange} />,
}));
/** Where each closing menu said focus should go, in close order. */
const menuFinalFocus = vi.hoisted(() => [] as unknown[]);
vi.mock("../ui/menu", async () => {
  const { useLayoutEffect, useRef } = await vi.importActual<typeof import("react")>("react");
  return {
    Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    // The trigger stands in as an <i>, so it is not one of the choice buttons.
    MenuTrigger: ({ ref }: { ref?: React.Ref<HTMLElement> }) => <i ref={ref} />,
    // Like Base UI, the popup asks where focus goes as it unmounts.
    MenuPopup: function MenuPopup({
      children,
      finalFocus,
    }: {
      children: React.ReactNode;
      finalFocus?: () => boolean;
    }) {
      const latest = useRef(finalFocus);
      latest.current = finalFocus;
      useLayoutEffect(
        () => () => {
          menuFinalFocus.push(latest.current === undefined ? true : latest.current());
        },
        [],
      );
      return <section>{children}</section>;
    },
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
  };
});
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
const requestId = RuntimeRequestId.make("approval");
const text = (node: { children: ReadonlyArray<unknown> }): string =>
  node.children
    .map((child) =>
      typeof child === "string" ? child : text(child as { children: ReadonlyArray<unknown> }),
    )
    .join("");
const buttons = () => renderer!.root.findAllByType("button");
/** A choice's own label: its first text-only span, or the button text when it has none. */
const label = (node: ReturnType<typeof buttons>[number]) => {
  const span = node
    .findAllByType("span")
    .find((candidate) => candidate.children.every((child) => typeof child === "string"));
  return span ? text(span) : text(node);
};
const button = (label: string) => buttons().find((candidate) => text(candidate).startsWith(label))!;

it("shows a saved choice's exact rule, but lets it be picked only with the settings grant", async () => {
  const onRespond = vi.fn().mockResolvedValue(undefined);
  const options = [
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Approve" },
    {
      decision: "acceptForSession",
      label: "Allow for this session",
      detail: "Edits allowed without asking until your next message",
    },
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
  const saved = button("Always allow");
  expect(saved.props.disabled).toBe(true);
  expect(text(saved)).toContain("Needs settings permission");
  expect(text(saved)).toContain(options[3]!.rulePreview![0]);
  expect(text(button("Allow for this session"))).toContain(options[2]!.detail);
  // The label already says how long it lasts; only the saved row carries a tag.
  expect(renderer!.root.findAllByType("em").map(text)).toEqual(["Saved"]);
  await act(async () => saved.props.onClick());
  expect(onRespond).not.toHaveBeenCalled();
  await act(async () => renderer!.update(render(true)));
  expect(button("Always allow").props.disabled).toBe(false);
  // The server's warning is the saved row's one location line, with the warning mark on it.
  expect(text(button("Always allow")).split("Runs outside the sandbox.")).toHaveLength(2);
  const warningLine = button("Always allow")
    .findAllByType("span")
    .find((span) => text(span) === "Runs outside the sandbox.")!;
  expect(warningLine.findAllByType("svg")).toHaveLength(1);
  expect(button("Always allow").findAllByType("svg")).toHaveLength(1);
  await act(async () => button("Always allow").props.onClick());
  expect(onRespond).toHaveBeenCalledWith(requestId, "acceptAlways", {});
  await act(async () => renderer!.update(render(true, false)));
  await act(async () => button("Always allow").props.onClick());
  expect(onRespond).toHaveBeenCalledTimes(1);
});

it("sends the server's option id and a typed reason with a decline", async () => {
  const onRespond = vi.fn().mockResolvedValue(undefined);
  const options = [
    { optionId: "once:0", decision: "accept", label: "Allow once", effect: "allow" },
    {
      optionId: "session:1",
      decision: "acceptForSession",
      label: "Allow for this session",
      scope: "session",
    },
    { optionId: "deny:2", decision: "decline", label: "Decline", acceptsFeedback: true },
    {
      optionId: "deny-stop:3",
      decision: "cancel",
      label: "Decline and stop",
      acceptsFeedback: true,
    },
  ] satisfies ProviderApprovalOption[];
  await act(async () => {
    renderer = create(
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={false}
        canRespond
        options={options}
        defaultToNo
        onRespondToApproval={onRespond}
      />,
    );
  });
  expect(buttons().map(label)).toEqual([
    "Decline",
    "Allow once",
    "Allow for this session",
    "Decline and stop",
    "Decline with a reason…",
  ]);
  expect(button("Decline").props["data-default-choice"]).toBe(true);
  expect(button("Allow once").props["data-default-choice"]).toBeUndefined();
  await act(async () => button("Allow for this session").props.onClick());
  expect(onRespond).toHaveBeenLastCalledWith(requestId, "acceptForSession", {
    optionId: "session:1",
  });
  await act(async () => button("Decline with a reason").props.onClick());
  await act(async () =>
    renderer!.root.findByType("textarea").props.onChange({ target: { value: " Wrong folder " } }),
  );
  await act(async () => button("Decline and stop").props.onClick());
  expect(onRespond).toHaveBeenLastCalledWith(requestId, "cancel", {
    optionId: "deny-stop:3",
    feedback: "Wrong folder",
  });
});

it("offers only the legacy decisions when an older server sends no list", async () => {
  await act(async () => {
    renderer = create(
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={false}
        canRespond
        onRespondToApproval={vi.fn()}
      />,
    );
  });
  expect(buttons().map(label)).toEqual([
    "Decline",
    "Allow once",
    "Allow for this session",
    "Decline and stop",
  ]);
});

const feedbackOptions = [
  { optionId: "once:0", decision: "accept", label: "Allow once" },
  { optionId: "deny:1", decision: "decline", label: "Decline", acceptsFeedback: true },
] satisfies ProviderApprovalOption[];

it("keeps each pending request's decline reason to that request", async () => {
  const onRespond = vi.fn().mockResolvedValue(undefined);
  const first = RuntimeRequestId.make("first");
  const second = RuntimeRequestId.make("second");
  const render = (id: RuntimeRequestId) => (
    <ComposerPendingApprovalActions
      requestId={id}
      isResponding={false}
      canRespond
      options={feedbackOptions}
      onRespondToApproval={onRespond}
    />
  );
  await act(async () => {
    renderer = create(render(first));
  });
  await act(async () => button("Decline with a reason").props.onClick());
  await act(async () =>
    renderer!.root.findByType("textarea").props.onChange({ target: { value: "Wrong folder" } }),
  );
  // The next request opens on its own buttons, and its editor starts empty.
  await act(async () => renderer!.update(render(second)));
  expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  await act(async () => button("Decline with a reason").props.onClick());
  expect(renderer!.root.findByType("textarea").props.value).toBe("");
  await act(async () => button("Decline").props.onClick());
  expect(onRespond).toHaveBeenLastCalledWith(second, "decline", { optionId: "deny:1" });
  // The first request still has the reason typed for it.
  await act(async () => renderer!.update(render(first)));
  await act(async () => button("Decline with a reason").props.onClick());
  expect(renderer!.root.findByType("textarea").props.value).toBe("Wrong folder");
  await act(async () => button("Decline").props.onClick());
  expect(onRespond).toHaveBeenLastCalledWith(first, "decline", {
    optionId: "deny:1",
    feedback: "Wrong folder",
  });
});

it("moves keyboard focus into the reason editor and back to the menu trigger", async () => {
  const trigger = { focus: vi.fn() };
  await act(async () => {
    renderer = create(
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={false}
        canRespond
        options={feedbackOptions}
        onRespondToApproval={vi.fn()}
      />,
      { createNodeMock: (element) => (element.type === "i" ? trigger : null) },
    );
  });
  menuFinalFocus.length = 0;
  // Closing into the reason editor leaves focus to the editor, which takes it on mount.
  await act(async () => button("Decline with a reason").props.onClick());
  expect(menuFinalFocus).toEqual([false]);
  expect(renderer!.root.findByType("textarea").props.autoFocus).toBe(true);
  expect(trigger.focus).not.toHaveBeenCalled();
  await act(async () => button("Back").props.onClick());
  expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  expect(trigger.focus).toHaveBeenCalledTimes(1);
  // Any other close of the menu hands focus back to its trigger as usual.
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(menuFinalFocus).toEqual([false, true]);
});

it("shows that the agent offered no choices, with nothing to press", async () => {
  await act(async () => {
    renderer = create(
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={false}
        canRespond
        options={[]}
        onRespondToApproval={vi.fn()}
      />,
    );
  });
  expect(buttons()).toHaveLength(0);
  expect(renderer!.root.findAllByType("i")).toHaveLength(0);
  expect(text(renderer!.root.findByProps({ role: "note" }))).toBe(
    "No choices offered. The agent offered no choices for this request, so it can't be answered. It closes when the agent stops waiting.",
  );
});
