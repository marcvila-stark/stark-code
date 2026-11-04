import { describe, expect, it } from "vite-plus/test";
import {
  composerModeOptions,
  resolveComposerModeSelection,
  resolveRuntimeModeDisplay,
  runtimeModeOptionsForProvider,
} from "./runtimeModeConfig";

describe("Claude's composer modes", () => {
  it("offers native modes together while retaining the Codex restriction", () => {
    const options = composerModeOptions(runtimeModeOptionsForProvider("claudeAgent"), {
      includePlan: true,
      canWriteSettings: true,
    });
    expect(options.map(({ label }) => label)).toEqual([
      "Manual",
      "Accept edits",
      "Auto",
      "Plan",
      "Bypass permissions",
    ]);
    expect(runtimeModeOptionsForProvider("codex")[0]?.label).toBe("Ask before actions");
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
      { includePlan: false, canWriteSettings: true },
    );
    expect(options.map(({ mode }) => mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
  });

  it("disables the wider modes without the settings permission, as the server refuses them", () => {
    const options = (canWriteSettings: boolean) =>
      composerModeOptions(runtimeModeOptionsForProvider("claudeAgent"), {
        includePlan: true,
        canWriteSettings,
      }).map(({ label, disabledReason }) => [label, disabledReason]);
    // Plan keeps the build mode and only reads, so it never needs the grant.
    expect(options(false)).toEqual([
      ["Manual", undefined],
      ["Accept edits", "Needs settings permission"],
      ["Auto", "Needs settings permission"],
      ["Plan", undefined],
      ["Bypass permissions", "Needs settings permission"],
    ]);
    expect(options(true).every(([, reason]) => reason === undefined)).toBe(true);
  });
});

describe("a saved mode the provider no longer offers", () => {
  it("shows the mode the chat runs as and says what was saved", () => {
    const codex = resolveRuntimeModeDisplay(
      runtimeModeOptionsForProvider("codex"),
      "full-access",
      "codex",
    );
    expect(codex).toEqual({
      mode: "approval-required",
      saved: {
        mode: "full-access",
        label: "Full access",
        note: "Saved as Full access, which isn't available here, so this chat runs as Ask before actions.",
      },
    });
    const claudeWithoutBypass = runtimeModeOptionsForProvider("claudeAgent").filter(
      ({ mode }) => mode !== "full-access",
    );
    expect(
      resolveRuntimeModeDisplay(claudeWithoutBypass, "full-access", "claudeAgent").saved?.note,
    ).toBe("Saved as Bypass permissions, which isn't available here, so this chat runs as Manual.");
  });

  it("changes nothing when the saved mode is offered", () => {
    expect(
      resolveRuntimeModeDisplay(
        runtimeModeOptionsForProvider("claudeAgent"),
        "auto",
        "claudeAgent",
      ),
    ).toEqual({ mode: "auto" });
  });
});
