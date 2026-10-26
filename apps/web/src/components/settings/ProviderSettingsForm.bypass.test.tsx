// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@starkfuture/contracts";
import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "../../confirmDialog";
import { providerClients } from "./providerDriverMeta";

// Scope/layout is unrelated to the account confirmation. Keep the real form,
// Switch and confirmation queue so these clicks exercise the save boundary.
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control, children }: { control: ReactNode; children?: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));

import { ProviderSettingsForm } from "./ProviderSettingsForm";

let root: Root;
let container: HTMLDivElement;
const saved = vi.fn();
const definition = providerClients.get(ProviderDriverKind.make("claudeAgent"))!;
type Variant = "card" | "dialog" | "settings";

function Account({ variant, initiallyEnabled }: { variant: Variant; initiallyEnabled: boolean }) {
  const [value, setValue] = useState<Record<string, unknown> | undefined>({
    binaryPath: "/opt/company/claude",
    ...(initiallyEnabled ? { allowBypassPermissions: true } : {}),
  });
  return (
    <ProviderSettingsForm
      definition={definition}
      value={value}
      idPrefix="claude-account"
      variant={variant}
      onChange={(next) => {
        saved(next);
        setValue(next);
      }}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetConfirmDialogForTests();
  saved.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    resetConfirmDialogForTests();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(variant: Variant, initiallyEnabled = false) {
  await act(async () => root.render(<Account {...{ variant, initiallyEnabled }} />));
}

function bypassSwitch() {
  const control = container.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Allow Bypass permissions"]',
  );
  if (!control) throw new Error("Bypass switch was not rendered");
  return control;
}

async function clickBypass() {
  await act(async () => bypassSwitch().click());
}

describe.each(["card", "dialog", "settings"] as const)("Bypass opt-in in %s layout", (variant) => {
  it("waits for confirmation before enabling the account and preserves its other settings", async () => {
    registerConfirmDialogHost();
    await render(variant);
    await clickBypass();
    expect(saved).not.toHaveBeenCalled();
    expect(bypassSwitch().getAttribute("aria-checked")).toBe("false");
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      variant: "destructive",
    });
    await act(async () => respondToConfirmDialog(true));
    expect(saved).toHaveBeenCalledExactlyOnceWith({
      binaryPath: "/opt/company/claude",
      allowBypassPermissions: true,
    });
    expect(bypassSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("leaves the account unchanged when confirmation is cancelled", async () => {
    registerConfirmDialogHost();
    await render(variant);
    await clickBypass();
    await act(async () => respondToConfirmDialog(false));
    expect(saved).not.toHaveBeenCalled();
    expect(bypassSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("turns Bypass off immediately without a confirmation host", async () => {
    await render(variant, true);
    await clickBypass();
    expect(saved).toHaveBeenCalledExactlyOnceWith({ binaryPath: "/opt/company/claude" });
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    expect(bypassSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("keeps Bypass off when no confirmation host is available", async () => {
    await render(variant);
    await clickBypass();
    expect(saved).not.toHaveBeenCalled();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    expect(bypassSwitch().getAttribute("aria-checked")).toBe("false");
  });
});

it("cancels an outstanding opt-in if its confirmation host disappears", async () => {
  const removeHost = registerConfirmDialogHost();
  await render("settings");
  await clickBypass();
  await act(async () => removeHost());
  expect(saved).not.toHaveBeenCalled();
  expect(bypassSwitch().getAttribute("aria-checked")).toBe("false");
});
