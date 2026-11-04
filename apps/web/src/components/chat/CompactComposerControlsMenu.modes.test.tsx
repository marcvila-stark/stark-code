import { useState, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode, ProviderInteractionMode } from "@starkfuture/contracts";

vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: () => null,
  MenuSeparator: () => null,
  MenuRadioGroup: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  MenuRadioItem: ({
    value,
    disabled,
    children,
  }: {
    value: string;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));
vi.mock("./composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./useComposerMenuState", () => ({ useComposerMenuState: () => [false, () => {}] }));
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { runtimeModeOptionsForProvider } from "./runtimeModeConfig";

let renderer: ReactTestRenderer | undefined;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join(" ");
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("selects native Claude modes and leaves Plan when Manual or Auto is selected", async () => {
  function Composer() {
    const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
    const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
    return (
      <>
        <output>
          {runtimeMode}:{interactionMode}
        </output>
        <CompactComposerControlsMenu
          combinePlanMode
          showInteractionModeToggle
          runtimeMode={runtimeMode}
          interactionMode={interactionMode}
          runtimeModeOptions={runtimeModeOptionsForProvider("claudeAgent")}
          canWriteSettings
          onRuntimeModeChange={(mode) => {
            setRuntimeMode(mode);
            return true;
          }}
          onToggleInteractionMode={() =>
            setInteractionMode((mode) => (mode === "plan" ? "default" : "plan"))
          }
        />
      </>
    );
  }
  await act(async () => {
    renderer = create(<Composer />);
  });
  expect(renderer!.root.findAllByType("select")).toHaveLength(1);
  expect(renderer!.root.findAllByType("option").map((option) => text(option))).toEqual([
    "Manual",
    "Accept edits",
    "Auto",
    "Plan",
    "Bypass permissions",
  ]);
  for (const [mode, expected] of [
    ["auto", "auto:default"],
    ["plan", "auto:plan"],
    ["approval-required", "approval-required:default"],
    ["plan", "approval-required:plan"],
    ["auto", "auto:default"],
    ["auto-accept-edits", "auto-accept-edits:default"],
    ["full-access", "full-access:default"],
  ]) {
    await act(async () =>
      renderer!.root.findByType("select").props.onChange({ target: { value: mode } }),
    );
    expect(renderer!.root.findByType("output").children.join("")).toBe(expected);
    expect(renderer!.root.findByType("select").props.value).toBe(mode);
  }
});

it.each([false, true])(
  "keeps the compact picker in Plan until Bypass is accepted=%s",
  async (accepted) => {
    let confirm!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    function Composer() {
      const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
      const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("plan");
      return (
        <>
          <output>
            {runtimeMode}:{interactionMode}
          </output>
          <CompactComposerControlsMenu
            combinePlanMode
            showInteractionModeToggle
            runtimeMode={runtimeMode}
            interactionMode={interactionMode}
            runtimeModeOptions={runtimeModeOptionsForProvider("claudeAgent")}
            canWriteSettings
            onRuntimeModeChange={async (mode) => {
              const confirmed = await pending;
              if (confirmed) setRuntimeMode(mode);
              return confirmed;
            }}
            onToggleInteractionMode={() =>
              setInteractionMode((mode) => (mode === "plan" ? "default" : "plan"))
            }
          />
        </>
      );
    }
    await act(async () => {
      renderer = create(<Composer />);
    });
    await act(async () =>
      renderer!.root.findByType("select").props.onChange({ target: { value: "full-access" } }),
    );
    expect(renderer!.root.findByType("select").props.value).toBe("plan");
    expect(renderer!.root.findByType("output").children.join("")).toBe("approval-required:plan");
    await act(async () => confirm(accepted));
    expect(renderer!.root.findByType("select").props.value).toBe(accepted ? "full-access" : "plan");
    expect(renderer!.root.findByType("output").children.join("")).toBe(
      accepted ? "full-access:default" : "approval-required:plan",
    );
  },
);

it("disables the wider modes without the settings permission and never sends them", async () => {
  const onRuntimeModeChange = vi.fn(() => true);
  await act(async () => {
    renderer = create(
      <CompactComposerControlsMenu
        combinePlanMode
        showInteractionModeToggle
        runtimeMode="approval-required"
        interactionMode="default"
        runtimeModeOptions={runtimeModeOptionsForProvider("claudeAgent")}
        canWriteSettings={false}
        onRuntimeModeChange={onRuntimeModeChange}
        onToggleInteractionMode={() => {}}
      />,
    );
  });
  expect(
    renderer!.root
      .findAllByType("option")
      .map((option) => [text(option), option.props.disabled === true]),
  ).toEqual([
    ["Manual", false],
    ["Accept edits Needs settings permission", true],
    ["Auto Needs settings permission", true],
    ["Plan", false],
    ["Bypass permissions Needs settings permission", true],
  ]);
  await act(async () =>
    renderer!.root.findByType("select").props.onChange({ target: { value: "auto" } }),
  );
  expect(onRuntimeModeChange).not.toHaveBeenCalled();
});
