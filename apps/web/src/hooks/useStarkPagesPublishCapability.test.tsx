import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useStarkPagesPublishCapability } from "./useStarkPagesPublishCapability";

type Input = Parameters<typeof useStarkPagesPublishCapability>[0];
const native: Input = {
  localPagesAvailable: true,
  pagesOpen: true,
  nativeShellMode: true,
  driver: "claudeAgent",
  commandAvailable: false,
};
let renderer: ReactTestRenderer | undefined;
let canPublish = false;
const check = vi.fn<() => Promise<boolean>>();
function Probe(input: Input) {
  const capability = useStarkPagesPublishCapability(input);
  useLayoutEffect(() => {
    canPublish = capability;
  });
  return null;
}
const render = async (input = native) => {
  await act(async () => {
    if (renderer) renderer.update(<Probe {...input} />);
    else renderer = create(<Probe {...input} />);
  });
};
beforeEach(() => {
  canPublish = false;
  check.mockReset().mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: { getStarkWorkbenchAvailable: check } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("enables native Claude from the validated bundle without waiting for a slash-command catalog", async () => {
  await render();
  expect(canPublish).toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
});

it.each([
  ["SDK chat", { nativeShellMode: false }],
  ["Codex shell", { driver: "codex" }],
  ["a remote environment", { localPagesAvailable: false }],
])("keeps publishing disabled for %s even with a command catalog", async (_label, override) => {
  await render({ ...native, commandAvailable: true, ...override });
  expect(canPublish).toBe(false);
  expect(check).not.toHaveBeenCalled();
});

it("fails closed when bundle validation fails or the desktop call rejects", async () => {
  check.mockResolvedValueOnce(false);
  await render();
  expect(canPublish).toBe(false);
  await render({ ...native, pagesOpen: false });
  check.mockRejectedValueOnce(new Error("unavailable"));
  await render();
  expect(canPublish).toBe(false);
});

it("ignores a late bundle result after switching out of native Claude", async () => {
  let complete!: (value: boolean) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  expect(canPublish).toBe(false);
  await render({ ...native, nativeShellMode: false });
  await act(async () => complete(true));
  expect(canPublish).toBe(false);
});

it("supports a verified plugin catalog on older desktop shells and otherwise stays disabled", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  await render();
  expect(canPublish).toBe(false);
  await render({ ...native, commandAvailable: true });
  expect(canPublish).toBe(true);
});
