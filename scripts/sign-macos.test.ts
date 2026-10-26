import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { expect, it, vi } from "vite-plus/test";

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

it("preserves app signing options and grants the dictation helper audio input", async () => {
  const options = {
    app: "/tmp/Stark Code.app",
    identity: "Developer ID Application: Stark Future, Inc.",
    keychain: "/tmp/starkcode.keychain",
    provisioningProfile: "/tmp/starkcode.provisionprofile",
    optionsForFile: () => ({
      entitlements: "/tmp/starkcode.entitlements.plist",
      hardenedRuntime: true,
    }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    batchCodesignCalls: true,
    optionsForFile: expect.any(Function),
  });
  const applied = vi.mocked(signApplication).mock.calls[0]![0];
  const context = { platform: "darwin" as const };
  expect(applied.optionsForFile?.(options.app, context)).toEqual(options.optionsForFile());
  expect(
    applied.optionsForFile?.(
      `${options.app}/Contents/Resources/dictation/Stark Dictation.app/Contents/MacOS/stark-dictation`,
      context,
    ),
  ).toEqual({
    entitlements: `${options.app}/Contents/Resources/dictation/entitlements.plist`,
    hardenedRuntime: true,
  });
  expect(
    applied.optionsForFile?.(`${options.app}/Contents/Resources/unrelated/other`, context),
  ).toEqual(options.optionsForFile());
});
