import { expect, it } from "vite-plus/test";
import type { NativeTurnEvidence } from "@starkfuture/contracts";
import { deriveNativeFinishEvidence } from "./nativeFinishEvidence";

const evidence: NativeTurnEvidence = {
  coverage: "available",
  commands: [
    {
      id: "test",
      label: "npm test",
      isCheck: true,
      outcome: "tool-completed",
      exitCode: null,
      startedAt: "2026-10-20T12:00:00Z",
      completedAt: "2026-10-20T12:00:01Z",
    },
  ],
  changes: [{ path: "app.ts", completedAt: "2026-10-20T12:00:02Z" }],
  unconfirmedChanges: 0,
};
it("marks later native edits stale without converting Claude tool completion to exit zero", () => {
  const value = deriveNativeFinishEvidence("reply", evidence)!;
  expect(value.zeroExitChecks).toBe(0);
  expect(value.completedToolChecks).toBe(1);
  expect(value.staleChecks).toBe(1);
  expect(value.commands[0]?.laterFiles).toEqual(["app.ts"]);
});
it("never treats missing capture or uncertain timing as fully checked", () => {
  expect(deriveNativeFinishEvidence("reply", undefined)).toBeNull();
  const value = deriveNativeFinishEvidence("reply", {
    ...evidence,
    coverage: "partial",
    changes: [],
  })!;
  expect(value.captureIncomplete).toBe(true);
  expect(value.unknownTimingChecks).toBe(1);
});
