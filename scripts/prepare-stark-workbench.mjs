import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import {
  adaptStarkPagesPanel,
  STARK_PAGES_PRESENTATION_VERSION,
} from "./adapt-stark-pages-panel.mjs";

// oxlint-disable-next-line starkcode/no-global-process-runtime -- Standalone offline build utility has no Effect runtime.
const hostPlatform = process.platform;

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/** Offline build-time extraction only. Packaged applications ship the loose kit. */
export function prepareStarkWorkbench({
  vendorRoot = NodePath.join(repoRoot, "vendor/stark-workbench"),
  destination = NodePath.join(repoRoot, "apps/desktop/resources/stark-workbench"),
  force = false,
} = {}) {
  const provenance = JSON.parse(
    NodeFS.readFileSync(NodePath.join(vendorRoot, "provenance.json"), "utf8"),
  );
  const archive = NodePath.join(vendorRoot, "runtime.tar.gz");
  const digest = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(archive)).digest("hex");
  if (digest !== provenance.archiveSha256)
    throw new Error("Stark Workbench archive failed its integrity check.");
  const stamp = NodePath.join(destination, ".stark-bundle.json");
  try {
    if (
      !force &&
      JSON.parse(NodeFS.readFileSync(stamp, "utf8")).archiveSha256 === digest &&
      JSON.parse(NodeFS.readFileSync(stamp, "utf8")).panelPresentationVersion ===
        STARK_PAGES_PRESENTATION_VERSION &&
      NodeFS.existsSync(NodePath.join(destination, ".claude-plugin/plugin.json")) &&
      NodeFS.existsSync(NodePath.join(destination, "packages/spage/bin/spage.js")) &&
      NodeFS.existsSync(NodePath.join(destination, "node_modules/markdown-it/package.json"))
    )
      return destination;
  } catch {
    /* First build, or stale extraction. */
  }
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  const temporary = NodeFS.mkdtempSync(`${destination}.extract-`);
  try {
    // Windows ships bsdtar; macOS/Linux use the system tar. The archive contains
    // only regular files with relative paths and is verified before extraction.
    NodeChildProcess.execFileSync(
      hostPlatform === "win32" ? "tar.exe" : "/usr/bin/tar",
      ["-xzf", archive, "-C", temporary],
      { stdio: "pipe" },
    );
    const panelPath = NodePath.join(temporary, "packages/spage/src/panel.js");
    NodeFS.writeFileSync(panelPath, adaptStarkPagesPanel(NodeFS.readFileSync(panelPath, "utf8")));
    NodeFS.writeFileSync(
      NodePath.join(temporary, ".stark-bundle.json"),
      JSON.stringify({
        ...provenance,
        panelPresentationVersion: STARK_PAGES_PRESENTATION_VERSION,
      }) + "\n",
    );
    NodeFS.rmSync(destination, { recursive: true, force: true });
    NodeFS.renameSync(temporary, destination);
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
  return destination;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  prepareStarkWorkbench();
}
