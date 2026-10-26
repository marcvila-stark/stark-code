import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line starkcode/no-global-process-runtime -- The standalone native compiler targets the host.
const hostPlatform = process.platform;
// oxlint-disable-next-line starkcode/no-global-process-runtime -- Default native architecture belongs to the build host.
const hostArch = process.arch;
const root = NodeURL.fileURLToPath(new URL("../../../native/dictation/", import.meta.url));

export function dictationArchitectures(arch) {
  if (arch === "universal") return ["arm64", "x86_64"];
  if (arch === "arm64") return ["arm64"];
  if (arch === "x64") return ["x86_64"];
  throw new Error(`Unsupported macOS dictation architecture: ${arch}`);
}

export function buildDictation({ arch = hostArch, output, platform = hostPlatform } = {}) {
  if (platform !== "darwin") return;
  const architectures = dictationArchitectures(arch);
  const bundle = output ?? NodePath.join(root, "build", arch, "Stark Dictation.app");
  const executable = NodePath.join(bundle, "Contents/MacOS/stark-dictation");
  const source = NodePath.join(root, "main.swift");
  const brokerSource = NodePath.join(root, "LaunchBroker.swift");
  const plist = NodePath.join(root, "Info.plist");
  const entitlements = NodePath.join(root, "entitlements.plist");
  const inputs = [
    source,
    brokerSource,
    plist,
    entitlements,
    NodeURL.fileURLToPath(import.meta.url),
  ];
  const stamp = NodePath.join(bundle, "Contents/Resources/build-architecture");
  try {
    if (
      NodeFS.readFileSync(stamp, "utf8") === arch &&
      NodeFS.statSync(executable).mtimeMs >=
        Math.max(...inputs.map((file) => NodeFS.statSync(file).mtimeMs))
    )
      return bundle;
  } catch {
    /* First build, or the helper changed. */
  }
  NodeFS.mkdirSync(NodePath.dirname(bundle), { recursive: true });
  const staging = NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(bundle), ".dictation-build-"));
  const temporaryBundle = NodePath.join(staging, "Stark Dictation.app");
  const temporaryExecutable = NodePath.join(temporaryBundle, "Contents/MacOS/stark-dictation");
  NodeFS.mkdirSync(NodePath.dirname(temporaryExecutable), { recursive: true });
  try {
    const binaries = architectures.map((architecture) => {
      const binary = NodePath.join(staging, architecture);
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "swiftc",
          "-O",
          "-swift-version",
          "5",
          "-target",
          `${architecture}-apple-macos13.0`,
          "-module-cache-path",
          NodePath.join(root, "build", ".module-cache"),
          "-framework",
          "AVFoundation",
          "-framework",
          "Speech",
          "-framework",
          "AppKit",
          source,
          brokerSource,
          "-o",
          binary,
        ],
        { stdio: "inherit" },
      );
      return binary;
    });
    if (binaries.length === 1) NodeFS.copyFileSync(binaries[0], temporaryExecutable);
    else
      NodeChildProcess.execFileSync(
        "lipo",
        ["-create", ...binaries, "-output", temporaryExecutable],
        { stdio: "inherit" },
      );
    NodeFS.chmodSync(temporaryExecutable, 0o755);
    NodeFS.copyFileSync(plist, NodePath.join(temporaryBundle, "Contents/Info.plist"));
    NodeFS.mkdirSync(NodePath.join(temporaryBundle, "Contents/Resources"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(temporaryBundle, "Contents/Resources/build-architecture"),
      arch,
    );
    // The distributable is re-signed by electron-builder. This signature makes
    // the local helper a stable app identity with microphone entitlement too.
    NodeChildProcess.execFileSync(
      "codesign",
      [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        "--options",
        "runtime",
        "--entitlements",
        entitlements,
        temporaryBundle,
      ],
      { stdio: "inherit" },
    );
    NodeFS.rmSync(bundle, { recursive: true, force: true });
    NodeFS.renameSync(temporaryBundle, bundle);
    return bundle;
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { values } = NodeUtil.parseArgs({
    options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
  });
  buildDictation(values);
}
