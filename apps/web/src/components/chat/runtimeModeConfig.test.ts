import { describe, expect, it } from "vite-plus/test";
import {
  composerModeOptions,
  resolveComposerModeSelection,
  runtimeModeOptionsForProvider,
} from "./runtimeModeConfig";

describe("Claude's composer modes", () => {
  it("offers native modes together while retaining the Codex restriction", () => {
    const options = composerModeOptions(runtimeModeOptionsForProvider("claudeAgent"), true);
    expect(options.map(({ label }) => label)).toEqual([
      "Manual",
      "Accept edits",
      "Auto",
      "Plan",
      "Bypass permissions",
    ]);
    expect(runtimeModeOptionsForProvider("codex")[0]?.label).toBe("Ask before changes");
    expect(runtimeModeOptionsForProvider("codex").map(({ mode }) => mode)).toEqual([
      "approval-required",
    ]);
  });

  it("enters Plan without losing the previous permission mode, then exits into the selected mode", () => {
    const plan = resolveComposerModeSelection("plan", "auto");
    expect(plan).toEqual({ runtimeMode: "auto", interactionMode: "plan" });
    expect(resolveComposerModeSelection("approval-required", plan.runtimeMode)).toEqual({
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(resolveComposerModeSelection("auto", plan.runtimeMode)).toEqual({
      runtimeMode: "auto",
      interactionMode: "default",
    });
  });

  it("omits Plan when the selected provider does not support it", () => {
    const options = composerModeOptions(
      runtimeModeOptionsForProvider("claudeAgent").filter(({ mode }) => mode !== "auto"),
      false,
    );
    expect(options.map(({ mode }) => mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
  });
});
