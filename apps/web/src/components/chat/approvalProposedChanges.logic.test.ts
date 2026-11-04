import { describe, expect, it } from "vite-plus/test";
import { approvalPathMinWidth, approvalPathTailLength } from "./approvalProposedChanges.logic";

describe("file rows on narrow approval cards", () => {
  it("keeps the whole file name, of the new path for a rename", () => {
    const path = "apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx";
    expect(path.slice(-approvalPathTailLength(path))).toBe("ComposerPendingApprovalPanel.tsx");
    const rename = "src/old/name.ts → src/new/renamedModule.ts";
    expect(rename.slice(-approvalPathTailLength(rename))).toBe("renamedModule.ts");
    expect(approvalPathTailLength("C:\\repo\\file.txt")).toBe("file.txt".length);
    expect(approvalPathTailLength("README")).toBe(6);
  });

  it("reserves the file name's width, so the counts wrap below before the name is cut", () => {
    expect(
      approvalPathMinWidth(
        "docs/guides/permissions/approval-flows/provider-native/reference/approval-card-checklist.md",
      ),
    ).toBe("min(26ch, 100%)");
    expect(approvalPathMinWidth(`src/${"a".repeat(50)}.generated.ts`)).toBe("min(32ch, 100%)");
  });

  it("keeps the end of a very long name, where its extension is", () => {
    const path = `src/${"a".repeat(50)}.generated.ts`;
    expect(approvalPathTailLength(path)).toBe(32);
    expect(path.slice(-32).endsWith(".generated.ts")).toBe(true);
  });
});
