// @effect-diagnostics nodeBuiltinImport:off - Signing preflight is verified against disposable app bundle metadata; the signer is never invoked.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import Plist from "plist";
import { afterEach, expect, it } from "vite-plus/test";

import BRAND from "../stark.brand.json" with { type: "json" };
import { assertLocalMacRuntimePolicy, localMacSignOptions } from "./sign-local-macos.ts";

const temporaryRoots: string[] = [];
const identity = "0123456789abcdef0123456789abcdef01234567";

it.each(["0x10000(runtime)", "0x10002(adhoc,runtime)", "0x10000"])(
  "refuses hardened app metadata (%s) before re-signing can remove protections",
  (flags) => {
    expect(() =>
      assertLocalMacRuntimePolicy(
        0,
        `Executable=/tmp/Stark Code.app/Contents/MacOS/Stark Code\nCodeDirectory v=20500 size=500 flags=${flags} hashes=10+5 location=embedded\n`,
      ),
    ).toThrow("Refusing to remove hardened runtime");
  },
);

it("accepts unsigned and ad-hoc local app metadata", () => {
  expect(() =>
    assertLocalMacRuntimePolicy(1, "/tmp/Stark Code.app: code object is not signed at all\n"),
  ).not.toThrow();
  expect(() =>
    assertLocalMacRuntimePolicy(
      0,
      "CodeDirectory v=20400 size=500 flags=0x2(adhoc) hashes=10+5 location=embedded\n",
    ),
  ).not.toThrow();
});

it.each([
  [1, "/tmp/Stark Code.app: No such file or directory\n"],
  [0, "Executable=/tmp/Stark Code.app/Contents/MacOS/Stark Code\n"],
  [0, "CodeDirectory v=20400 size=500 flags=unknown\n"],
  [0, "CodeDirectory flags=0x2\nCodeDirectory flags=0x10000(runtime)\n"],
] as const)("rejects ambiguous or failed signing inspection (%s, %s)", (exitCode, stderr) => {
  expect(() => assertLocalMacRuntimePolicy(exitCode, stderr)).toThrow("Could not verify");
});

function appFixture(bundleId: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-local-sign-test-"));
  temporaryRoots.push(root);
  const app = NodePath.join(root, "Stark Code (Alpha).app");
  NodeFS.mkdirSync(NodePath.join(app, "Contents"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(app, "Contents/Info.plist"),
    Plist.build({ CFBundleIdentifier: bundleId }),
  );
  return app;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true });
});

it("rejects other app identities before the signer can change their signatures", () => {
  expect(() => localMacSignOptions(appFixture("com.example.other"), identity, "darwin")).toThrow(
    `The app bundle identifier must be ${BRAND.bundleId}.`,
  );
});

it.each(["-", "Apple Development", "01234567", `${identity}; echo unsafe`])(
  "requires an explicit complete certificate fingerprint (%s)",
  (selection) => {
    expect(() => localMacSignOptions("/not/read", selection, "darwin")).toThrow(
      "complete 40-character SHA-1",
    );
  },
);

it("refuses to sign on other operating systems", () => {
  expect(() => localMacSignOptions("/not/read", identity, "linux")).toThrow("requires macOS");
});

it("uses the existing identity without profile discovery or changes to local runtime policy", () => {
  const app = appFixture(BRAND.bundleId);
  const options = localMacSignOptions(app, identity, "darwin");
  expect(options.identity).toBe(identity.toUpperCase());
  expect(options.app).toBe(NodeFS.realpathSync(app));
  expect(options.identityValidation).toBe(true);
  expect(options.preAutoEntitlements).toBe(false);
  expect(options.preEmbedProvisioningProfile).toBe(false);
  expect(options.strictVerify).toBe(true);
  expect(options.optionsForFile?.(app, { platform: "darwin" })).toEqual({
    hardenedRuntime: false,
    timestamp: "none",
  });
});
