import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import * as NodePath from "node:path";

/** Sign files with matching options together instead of spawning codesign for each file. */
export default async function sign(options: SignOptions): Promise<void> {
  const helper = NodePath.join(options.app, "Contents/Resources/dictation/Stark Dictation.app");
  await signApplication({
    ...options,
    batchCodesignCalls: true,
    optionsForFile: (filePath, fileOptions) => {
      const original = options.optionsForFile?.(filePath, fileOptions) ?? {};
      if (filePath !== helper && !filePath.startsWith(`${helper}${NodePath.sep}`)) return original;
      // Re-signing a native executable replaces its ad-hoc entitlements. The
      // helper captures audio itself and needs this capability in release too.
      return {
        ...original,
        entitlements: NodePath.join(options.app, "Contents/Resources/dictation/entitlements.plist"),
        hardenedRuntime: true,
      };
    },
  });
}
