import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@starkfuture/contracts";

const testState = vi.hoisted(() => ({
  addToast: vi.fn((_toast: unknown) => "toast-1"),
  closeToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast, close: testState.closeToast },
  stackedThreadToast: (options: unknown) => options,
}));
vi.mock("../localApi", () => ({ ensureLocalApi: () => ({ dialogs: { confirm: vi.fn() } }) }));

import { showDesktopUpdateReadyToast } from "./desktopUpdate.toast";

type ClickableElement = ReactElement<{ readonly onClick?: () => void }>;

function findButton(node: ReactNode): ClickableElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  if (element.type === "button") return element as ClickableElement;
  return findButton(element.props.children);
}

function readyState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.0.29",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.30",
    downloadedVersion: "0.0.30",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: 100,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

type AddedToast = {
  readonly title: string;
  readonly description: ReactNode;
  readonly actionProps: { readonly children: string; readonly onClick: () => void };
};

describe("showDesktopUpdateReadyToast", () => {
  beforeEach(() => {
    testState.addToast.mockClear();
    testState.closeToast.mockClear();
  });

  it("offers the checked restart and Later, nothing that skips the checks", () => {
    const run = vi.fn().mockResolvedValue(true);
    const state = readyState();
    showDesktopUpdateReadyToast(state, run);
    const toast = testState.addToast.mock.calls[0]?.[0] as unknown as AddedToast;
    expect(toast.title).toBe("Stark Code 0.0.30 is ready");
    expect(toast.actionProps.children).toBe("Restart to update");

    toast.actionProps.onClick();
    expect(run).toHaveBeenCalledWith("install", { state });

    findButton(toast.description)?.props.onClick?.();
    expect(run).toHaveBeenCalledWith("postpone", {});
    expect(testState.closeToast).toHaveBeenCalledWith("toast-1");
  });

  it("falls back to the version the download was started for", () => {
    showDesktopUpdateReadyToast(readyState({ downloadedVersion: null }), vi.fn());
    const toast = testState.addToast.mock.calls[0]?.[0] as unknown as AddedToast;
    expect(toast.title).toBe("Stark Code 0.0.30 is ready");
  });
});
