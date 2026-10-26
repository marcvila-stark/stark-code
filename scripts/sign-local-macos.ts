// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone packaging utility calls the Promise-based Electron signer before any Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import type { SignOptions } from "@electron/osx-sign";
import Plist from "plist";

import BRAND from "../stark.brand.json" with { type: "json" };
import sign from "./sign-macos.ts";

const usage =
  "Usage: node scripts/sign-local-macos.ts --app <Stark Code.app> --identity <certificate SHA-1>";

export function assertLocalMacRuntimePolicy(exitCode: number, stderr: string): void {
  if (exitCode === 1 && /^[^\r\n]+: code object is not signed at all\s*$/.test(stderr)) return;
  const flags = [...stderr.matchAll(/^CodeDirectory\b[^\r\n]*\bflags=(0x[\da-f]+)\b/gim)];
  if (exitCode !== 0 || flags.length !== 1)
    throw new Error("Could not verify the app's runtime policy. No signatures were changed.");
  if ((BigInt(flags[0]![1]!) & 0x10000n) !== 0n)
    throw new Error(
      "Refusing to remove hardened runtime. Use the unsigned local-build output, not a distribution app.",
    );
}

async function inspectLocalMacRuntimePolicy(app: string): Promise<void> {
  let inspection: { exitCode: number; stderr: string };
  try {
    const { stderr } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "/usr/bin/codesign",
      ["--display", "--verbose=2", app],
      { timeout: 10_000, maxBuffer: 128 * 1024 },
    );
    inspection = { exitCode: 0, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    if (failure?.code !== 1 || typeof failure.stderr !== "string")
      throw new Error("Could not inspect the app's runtime policy. No signatures were changed.", {
        cause: error,
      });
    inspection = { exitCode: 1, stderr: failure.stderr };
  }
  assertLocalMacRuntimePolicy(inspection.exitCode, inspection.stderr);
}

export function localMacSignOptions(
  app: string,
  identity: string,
  // oxlint-disable-next-line starkcode/no-global-process-runtime -- Standalone packaging utility has no Effect runtime.
  platform = NodeOS.platform(),
): SignOptions {
  if (platform !== "darwin") throw new Error("Local macOS signing requires macOS.");
  if (!/^[a-f\d]{40}$/i.test(identity))
    throw new Error("Choose an installed signing certificate by its complete 40-character SHA-1.");
  const appPath = NodeFS.realpathSync(app);
  if (!appPath.endsWith(".app") || !NodeFS.statSync(appPath).isDirectory())
    throw new Error("The app must be a packaged Stark Code .app directory.");
  const info = Plist.parse(
    NodeFS.readFileSync(NodePath.join(appPath, "Contents/Info.plist"), "utf8"),
  );
  if (
    typeof info !== "object" ||
    info === null ||
    Array.isArray(info) ||
    !("CFBundleIdentifier" in info) ||
    info.CFBundleIdentifier !== BRAND.bundleId
  )
    throw new Error(`The app bundle identifier must be ${BRAND.bundleId}.`);

  return {
    app: appPath,
    identity: identity.toUpperCase(),
    platform: "darwin",
    type: "development",
    identityValidation: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    // Local artifacts already run without HRT. Keep that behavior for Firefox
    // NSS/FFI imports; the shared signer still preserves Electron's per-file
    // entitlements and the dictation helper's own hardened audio capability.
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
  };
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = NodeUtil.parseArgs({
    options: { app: { type: "string" }, identity: { type: "string" }, help: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (!values.app || !values.identity) throw new Error(usage);
    const options = localMacSignOptions(values.app, values.identity);
    await inspectLocalMacRuntimePolicy(options.app);
    await sign(options);
    console.log(
      `Signed and verified ${NodePath.resolve(values.app)} with the selected local identity.`,
    );
  }
}
