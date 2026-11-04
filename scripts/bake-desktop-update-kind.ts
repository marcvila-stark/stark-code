// @effect-diagnostics nodeBuiltinImport:off - electron-builder loads this hook outside any Effect runtime.
/**
 * electron-builder `afterPack` hook for macOS builds that carry an update feed.
 *
 * electron-builder writes Resources/app-update.yml from the `publish` config,
 * whose schema has no room for anything else, so this hook adds the baked
 * feed kind (`stark` or `mock`) from the stage package.json's
 * `starkcodeUpdate` policy. User hooks run after electron-builder's own
 * afterPack handlers and before signing, so the line ends up sealed in the
 * signature. The build then verifies the packaged file
 * (verifyPackagedUpdateFeed in build-desktop-artifact.ts).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

interface AfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: {
    getResourcesDir(appOutDir: string): string;
    readonly info: { readonly metadata: Readonly<Record<string, unknown>> };
  };
}

/** Sets the `kind:` line of an app-update.yml, replacing any earlier one. */
export function withUpdateFeedKind(appUpdateYml: string, kind: "stark" | "mock"): string {
  const lines = appUpdateYml
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !line.startsWith("kind:"));
  return `${[...lines, `kind: ${kind}`].join("\n")}\n`;
}

function bakedKind(metadata: Readonly<Record<string, unknown>>): "stark" | "mock" | undefined {
  const policy = metadata.starkcodeUpdate;
  if (typeof policy !== "object" || policy === null || !("kind" in policy)) return undefined;
  return policy.kind === "stark" || policy.kind === "mock" ? policy.kind : undefined;
}

export async function afterPack(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== "darwin") return;
  const kind = bakedKind(context.packager.info.metadata);
  if (kind === undefined) return;
  const file = NodePath.join(context.packager.getResourcesDir(context.appOutDir), "app-update.yml");
  let current: string;
  try {
    current = await NodeFSP.readFile(file, "utf8");
  } catch {
    // Nothing to mark; the build reports the missing file after packaging.
    return;
  }
  await NodeFSP.writeFile(file, withUpdateFeedKind(current, kind));
}
