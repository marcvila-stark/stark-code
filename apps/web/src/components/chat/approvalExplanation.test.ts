import { describe, expect, it } from "vite-plus/test";
import { explainApprovalCommand } from "./approvalExplanation";

describe("plain-language command explanations", () => {
  it("distinguishes discarding work from retaining it, without inventing affected files", () => {
    const hard = explainApprovalCommand("git -C '/work/project' reset --hard HEAD");
    expect(hard.steps[0]).toMatchObject({ caution: true, unknown: false });
    expect(hard.steps[0]?.explanation).toContain("Uncommitted changes can be lost");
    const soft = explainApprovalCommand("git reset --soft HEAD~1");
    expect(soft.steps[0]).toMatchObject({ caution: false, unknown: false });
    expect(soft.steps[0]?.explanation).toContain("retaining staged and working changes");
    expect(JSON.stringify(hard)).not.toMatch(/\b\d+ files\b/u);
  });

  it.each([
    "git restore -- file.ts",
    "git restore --staged --worktree .",
    "git checkout HEAD -- file.ts",
    "git checkout -f main",
    "git clean -fdx",
    "git rm src.ts",
    "rm -rf build",
    "/bin/rm -rf build",
    "mv source destination",
  ])("warns about destructive command %s", (command) => {
    expect(explainApprovalCommand(command).steps[0]?.caution).toBe(true);
  });

  it("keeps staged-only restores separate from working-file restores", () => {
    const result = explainApprovalCommand("git restore --staged -- file.ts");
    expect(result.steps[0]).toMatchObject({ caution: false, unknown: false });
    expect(result.steps[0]?.explanation).toContain("working files are not the target");
  });

  it("honors option boundaries and exclusion values before calling clean a preview", () => {
    expect(explainApprovalCommand("git clean -ndx").steps[0]?.explanation).toContain("preview");
    for (const command of [
      "git clean -f -- -n",
      "git clean -f -e -node_modules",
      "git clean -f --exclude -n",
    ]) {
      expect(explainApprovalCommand(command).steps[0]?.caution).toBe(true);
    }
    expect(explainApprovalCommand("git restore -- --staged").steps[0]?.caution).toBe(true);
  });

  it("explains each simple command without hiding conditional deletion", () => {
    const result = explainApprovalCommand("git status && rm -rf build");
    expect(result.steps.map((step) => step.caution)).toEqual([false, true]);
    expect(result.steps[1]?.command).toBe("rm -rf build");
    expect(result.notes.join(" ")).toContain("conditionally");
  });

  it("explains literal shell wrappers but never evaluates expansions or interpreted scripts", () => {
    expect(explainApprovalCommand("/bin/zsh -lc 'git reset --hard HEAD'").steps[0]?.caution).toBe(
      true,
    );
    for (const source of [
      "git $(printf status)",
      'git diff "$(rm secret)"',
      "python -c 'do_something()'",
      "sudo git reset --hard HEAD",
      "git -c alias.wipe='!rm -rf .' wipe",
      "/tmp/git status",
      "if true; then rm file; fi",
      "powershell -Command 'Remove-Item x'",
    ]) {
      expect(explainApprovalCommand(source).steps[0]?.unknown, source).toBe(true);
    }
    expect(explainApprovalCommand('rm -rf "$TARGET"').steps[0]).toMatchObject({
      unknown: true,
      caution: true,
    });
  });

  it("distinguishes quoted literals from shell expansions", () => {
    expect(explainApprovalCommand("git diff -- 'literal*file'").steps[0]?.unknown).toBe(false);
    expect(explainApprovalCommand("git diff -- file*").steps[0]?.unknown).toBe(true);
    expect(explainApprovalCommand("echo 'rm -rf .'").steps[0]?.caution).toBe(false);
  });

  it("warns about file redirection even on a known display command", () => {
    expect(explainApprovalCommand("git status | cat > file").notes[0]).toContain("overwrite");
    expect(explainApprovalCommand("git diff > report.txt").notes).toContain(
      "Output redirection can create or overwrite a file.",
    );
    expect(explainApprovalCommand("git diff >> report.txt").notes).toContain(
      "Output redirection appends to or creates a file.",
    );
    expect(explainApprovalCommand("git diff >$(rm file)").notes.join(" ")).toContain(
      "may run other commands",
    );
  });

  it("warns when display commands explicitly write output or invoke external helpers", () => {
    for (const command of [
      "git diff --output=tracked.ts",
      "git log --output tracked.ts",
      "git show --ext-diff HEAD",
      "git diff --textconv",
    ]) {
      expect(explainApprovalCommand(command).steps[0]?.caution, command).toBe(true);
    }
    expect(explainApprovalCommand("git diff -- --output=file").steps[0]?.caution).toBe(false);
  });

  it("does not let parse failures, unsupported syntax or size limits produce partial confidence", () => {
    expect(explainApprovalCommand("git status && 'broken").steps[0]?.unknown).toBe(true);
    expect(explainApprovalCommand("x".repeat(8_193)).steps[0]?.explanation).toContain("too long");
    expect(explainApprovalCommand(undefined).steps[0]?.explanation).toContain("unavailable");
    const many = explainApprovalCommand(Array.from({ length: 20 }, () => "git status").join(";"));
    expect(many.steps).toHaveLength(6);
    expect(many.notes.join(" ")).toContain("More command parts");
  });
});
