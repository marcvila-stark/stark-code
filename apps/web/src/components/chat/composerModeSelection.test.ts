import { describe, expect, it, vi } from "vite-plus/test";
import { applyComposerModeSelection } from "./composerModeSelection";

describe("combined Plan and permission selection", () => {
  it.each([false, true])(
    "keeps Plan while Bypass confirmation is pending, then accepts=%s",
    async (accepted) => {
      let resolve!: (confirmed: boolean) => void;
      const confirmation = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      const changePermissions = vi.fn(() => confirmation);
      const leavePlan = vi.fn();
      const changed = applyComposerModeSelection("full-access", {
        runtimeMode: "approval-required",
        interactionMode: "plan",
        combinePlanMode: true,
        onRuntimeModeChange: changePermissions,
        onToggleInteractionMode: leavePlan,
      });
      expect(changePermissions).toHaveBeenCalledExactlyOnceWith("full-access");
      expect(leavePlan).not.toHaveBeenCalled();
      resolve(accepted);
      expect(await changed).toBe(accepted);
      expect(leavePlan).toHaveBeenCalledTimes(accepted ? 1 : 0);
    },
  );

  it("requires fresh confirmation when Plan remembers a previous Bypass mode", async () => {
    const confirm = vi.fn(() => false);
    const leavePlan = vi.fn();
    expect(
      await applyComposerModeSelection("full-access", {
        runtimeMode: "full-access",
        interactionMode: "plan",
        combinePlanMode: true,
        onRuntimeModeChange: confirm,
        onToggleInteractionMode: leavePlan,
      }),
    ).toBe(false);
    expect(confirm).toHaveBeenCalledExactlyOnceWith("full-access");
    expect(leavePlan).not.toHaveBeenCalled();
  });

  it("enters Plan without changing the remembered build permissions", async () => {
    const changePermissions = vi.fn(() => true);
    const enterPlan = vi.fn();
    await applyComposerModeSelection("plan", {
      runtimeMode: "auto",
      interactionMode: "default",
      combinePlanMode: true,
      onRuntimeModeChange: changePermissions,
      onToggleInteractionMode: enterPlan,
    });
    expect(changePermissions).not.toHaveBeenCalled();
    expect(enterPlan).toHaveBeenCalledOnce();
  });

  it("preserves a separate Plan toggle when changing access on another provider", async () => {
    const changePermissions = vi.fn(() => true);
    const togglePlan = vi.fn();
    await applyComposerModeSelection("auto-accept-edits", {
      runtimeMode: "approval-required",
      interactionMode: "plan",
      combinePlanMode: false,
      onRuntimeModeChange: changePermissions,
      onToggleInteractionMode: togglePlan,
    });
    expect(changePermissions).toHaveBeenCalledExactlyOnceWith("auto-accept-edits");
    expect(togglePlan).not.toHaveBeenCalled();
  });
});
