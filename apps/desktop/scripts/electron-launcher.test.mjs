import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  encodePngIcns,
  registerMacLauncherBundle,
  makeDevelopmentEnvironmentScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacBundleInfoPlistStrings,
  resolveMacCodeSignArguments,
  resolveMacLauncherIconPaths,
  resolveMacLauncherPaths,
  writeDevelopmentLauncherScript,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("allows development launch when the macOS registration service is unavailable", () => {
    const run = () => ({ status: 1, stderr: "failed to scan app: -10822\n" });
    assert.equal(registerMacLauncherBundle("/dev.app", { development: true, run }), false);
    assert.throws(() => registerMacLauncherBundle("/prod.app", { development: false, run }));
  });

  it("still rejects invalid application bundles in development", () => {
    const run = () => ({ status: 1, stderr: "invalid application bundle: -10811\n" });
    assert.throws(() => registerMacLauncherBundle("/dev.app", { development: true, run }));
  });

  it("uses captured values only as fallbacks for a live runner environment", () => {
    const environmentScript = makeDevelopmentEnvironmentScript({
      VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
      STARK_CODE_PORT: "16566",
      STARK_CODE_HOME: "/tmp/stark-code",
      STARK_CODE_OTLP_PROTOCOL: "http/protobuf",
    });

    assert.include(
      environmentScript,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.include(
      environmentScript,
      "if [ -z \"${STARK_CODE_OTLP_PROTOCOL:-}\" ]; then export STARK_CODE_OTLP_PROTOCOL='http/protobuf'; fi",
    );
    assert.notInclude(environmentScript, "\nexport VITE_DEV_SERVER_URL=");
  });

  it("keeps the launcher script free of volatile environment values", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });

    assert.include(
      script,
      "if [ -f '/repo/apps/desktop/.electron-runtime/dev-environment.sh' ]; then . '/repo/apps/desktop/.electron-runtime/dev-environment.sh'; fi",
    );
    assert.notInclude(script, "VITE_DEV_SERVER_URL");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --starkcode-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/Stark Code (Dev).app",
      "Stark Code (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "Stark Code (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/Stark Code (Dev).app/Contents/MacOS/Stark Code (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/Stark Code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/Stark Code (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("declares why the macOS app needs protected access", () => {
    const values = resolveMacBundleInfoPlistStrings("Stark Code (Dev) Launcher");

    assert.equal(
      values.NSScreenCaptureUsageDescription,
      "Stark Code captures the active window when you use the snapshot shortcut.",
    );
    assert.equal(
      values.NSDocumentsFolderUsageDescription,
      "Stark Code reads project files you open in the desktop app.",
    );
    assert.equal(
      values.NSMicrophoneUsageDescription,
      "Stark Code uses your microphone when you dictate a message.",
    );
    assert.equal(
      values.NSSpeechRecognitionUsageDescription,
      "Stark Code transcribes your dictated messages on this Mac.",
    );
  });

  it("ad-hoc signs the complete development app bundle", () => {
    assert.deepEqual(resolveMacCodeSignArguments("/runtime/Stark Code (Dev).app"), [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      "/runtime/Stark Code (Dev).app",
    ]);
  });

  it("restores execute permissions on an unchanged launcher", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-launcher-"));
    const launcherPath = NodePath.join(directory, "launcher");
    try {
      writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron");
      NodeFS.chmodSync(launcherPath, 0o644);

      assert.isFalse(writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron"));
      assert.equal(NodeFS.statSync(launcherPath).mode & 0o777, 0o755);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    // The source icons are real repo paths, joined for the host.
    assert.match(development.sourceIconPath, /assets[\\/]stark[\\/]icon-macos\.png$/);
    assert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    assert.match(production.sourceIconPath, /assets[\\/]stark[\\/]icon-macos\.png$/);
    assert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
  });
});

describe("PNG-backed macOS application icons", () => {
  it("encodes a complete icon family with correctly bounded PNG payloads", () => {
    const png = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../../assets/dev/blueprint-macos-1024.png"),
    );
    const icon = encodePngIcns([{ type: "ic10", png }]);
    assert.equal(icon.toString("ascii", 0, 4), "icns");
    assert.equal(icon.readUInt32BE(4), icon.length);
    assert.equal(icon.toString("ascii", 8, 12), "ic10");
    assert.equal(icon.readUInt32BE(12), icon.length - 8);
    assert.deepEqual(icon.subarray(16), png);
  });
});
