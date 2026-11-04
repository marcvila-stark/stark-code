// @effect-diagnostics nodeBuiltinImport:off - scans the source tree for who imports the classifier.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyReadOnlyShellCommand,
  describeReadOnlyCommand,
  unwrapShellCommand,
} from "./readOnlyShellCommand.ts";

const summary = (source: string) => {
  const result = classifyReadOnlyShellCommand(source);
  return result.readOnly ? result.summary : undefined;
};

describe("unwrapShellCommand", () => {
  it("returns the script inside one outer shell wrapper, keeping the wrapper text", () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'cat brief.md'")).toEqual({
      wrapper: "/bin/zsh -lc",
      script: "cat brief.md",
    });
    expect(unwrapShellCommand('bash -c "git status && git diff"')?.script).toBe(
      "git status && git diff",
    );
    expect(unwrapShellCommand("sh -c 'ls'")?.wrapper).toBe("sh -c");
  });

  it("does not unwrap anything that is more than a single wrapper", () => {
    for (const source of [
      "cat brief.md",
      "/bin/zsh -lc 'cat a' && rm b",
      "/bin/zsh -lc 'cat a' > out",
      "X=1 zsh -c 'ls'",
      'zsh -lc "$(curl x)"',
      "/tmp/zsh -c 'ls'",
      "zsh -x -c 'ls'",
      "zsh script.sh",
      "zsh -c ''",
    ]) {
      expect(unwrapShellCommand(source), source).toBeUndefined();
    }
  });
});

describe("classifyReadOnlyShellCommand", () => {
  it("explains the effect and scope of the commands seen in UX tests", () => {
    expect(summary("/bin/zsh -lc 'cat brief.md'")).toBe("Expected to read only — shows brief.md.");
    expect(summary("find src docs -type f -not -path '*/node_modules/*' | wc -l")).toBe(
      "Expected to read only — lists files under src and docs, then counts the lines.",
    );
    expect(classifyReadOnlyShellCommand("/bin/zsh -lc 'cat brief.md'")).toMatchObject({
      command: "cat brief.md",
    });
  });

  it.each([
    ["cat package.json", "shows package.json"],
    ["head -n 40 src/index.ts", "shows the first 40 lines of src/index.ts"],
    ["tail -5 log.txt", "shows the last 5 lines of log.txt"],
    ["less README.md", "shows README.md in a pager"],
    ["more README.md", "shows README.md in a pager"],
    ["wc -l a.ts b.ts", "counts the lines in a.ts and b.ts"],
    ["grep -rn 'TODO' src", 'searches under src for "TODO"'],
    ["egrep 'a|b' file.txt", 'searches file.txt for "a|b"'],
    ["fgrep -l needle a b", 'lists files in a and b containing "needle"'],
    ["rg -n -g '*.ts' useEffect apps", 'searches under apps for "useEffect"'],
    ["find . -name '*.md'", 'lists files and folders in the current folder named "*.md"'],
    ["ls -la src", "lists src"],
    ["tree -L 2 apps", "shows the folder tree of apps"],
    ["du -sh node_modules", "shows how much disk space node_modules uses"],
    ["df -h", "shows free disk space"],
    ["stat -f %z package.json", "shows file details for package.json"],
    ["file logo.png", "identifies the type of logo.png"],
    ["pwd", "shows the current folder"],
    ["which node", "shows where node is installed"],
    ["echo done", "prints text"],
    ["printf '%s\\n' x", "prints text"],
    ["sed -n '1,40p' src/a.ts", "shows lines 1–40 of src/a.ts"],
    ["awk -F: '{print $1}' /etc/passwd", "extracts text from /etc/passwd with an awk program"],
    ["sort -u names.txt", "sorts the lines of names.txt"],
    ["uniq -c counts.txt", "counts repeated lines in counts.txt"],
    ["cut -d, -f1 data.csv", "keeps selected columns of data.csv"],
    ["diff -u a.ts b.ts", "compares a.ts with b.ts"],
    ["git status --short", "shows which files Git considers changed, staged or untracked"],
    ["git -C /work/app log --oneline -5", "shows Git history"],
    ["git diff HEAD~1 -- src", "shows Git differences"],
    ["git diff --text a.bin b.bin", "shows Git differences"],
    ["git show HEAD:package.json", "shows the selected Git commits or files"],
    ["git blame -L 1,20 src/a.ts", "shows who last changed each line of src/a.ts"],
    ["git branch -a", "lists Git branches"],
    ["git branch --list 'feat/*'", "lists Git branches"],
    ["git ls-files", "lists files Git tracks"],
    ["git rev-parse --show-toplevel", "looks up Git revisions or repository paths"],
    ["git remote -v", "lists Git remotes"],
    ["node --version", "shows the Node.js version"],
    ["python3 --version", "shows the Python version"],
  ])("classifies %s as read-only", (source, effect) => {
    expect(summary(source)).toBe(`Expected to read only — ${effect}.`);
  });

  it("describes piped filters by what they do to the previous output", () => {
    expect(summary("git log --oneline | grep fix | head -n 3")).toBe(
      'Expected to read only — shows Git history, then keeps lines matching "fix", then keeps the first 3 lines.',
    );
    expect(summary("cd apps/web && ls; git status 2>/dev/null")).toBe(
      "Expected to read only — moves into apps/web; lists the current folder; shows which files Git considers changed, staged or untracked.",
    );
    expect(summary("cat a.log 2>&1 | sort | uniq")).toContain("sorts the lines, then removes");
  });

  it.each([
    "find . -delete",
    "find . -name '*.tmp' -exec rm {} \\;",
    "find . -execdir ls \\;",
    "find . -fprint out.txt",
    "cat x > y",
    "cat x >> y",
    "ls >/dev/null",
    "cat <<EOF\nx\nEOF",
    "grep -r foo | xargs rm",
    "sed -i 's/a/b/' file",
    "sed -n 's/a/b/w out' file",
    "sed -n '1p;e rm x' file",
    "sed 's/a/b/' file",
    "awk '{print > \"out\"}' file",
    "awk 'BEGIN { system(\"rm x\") }'",
    "awk -f prog.awk file",
    "git stash",
    "git checkout main",
    "git reset --hard",
    "git add .",
    "git commit -m x",
    "git push",
    "git clean -fdx",
    "git branch feature",
    "git branch -D feature",
    "git remote add origin x",
    "git -c core.pager=rm log",
    "git diff --output=out.txt",
    "git log --ext-diff",
    "echo $(rm -rf x)",
    "echo `rm -rf x`",
    "cat <(rm x)",
    "ls =(rm x)",
    "ls; rm x",
    "ls && rm x",
    "ls || rm x",
    "ls &",
    '/bin/zsh -lc "cat a && git push"',
    "zsh -lc \"zsh -c 'ls'\"",
    "sudo cat /etc/hosts",
    "env cat a",
    "eval ls",
    "exec ls",
    "X=1 ls",
    "ls $HOME",
    "ls ~/x",
    "ls *.ts",
    "ls {a,b}",
    "cat 'a' | sh",
    "if true; then ls; fi",
    "(ls)",
    "! ls",
    "sort -o out.txt in.txt",
    "sort --compress-program=gzip in.txt",
    "uniq in.txt out.txt",
    "tree -o out.txt",
    "less -o log.txt file",
    "less '+!rm x' file",
    "file -C -m magic",
    "rg --pre ./run.sh foo",
    "rg --hostname-bin ./run.sh --hyperlink-format default needle .",
    "rg --hostname-bin=./run.sh --hyperlink-format default needle .",
    "less -k keys.bin file",
    "less --lesskey-src=keys.txt file",
    "less --lesskey-s=keys.txt file",
    "less '--lesskey-content=#env;LESSOPEN=|./run.sh %s' file",
    "less --log=log.txt file",
    "less --LOG-FILE=log.txt file",
    "more -o log.txt file",
    "sort --out=out.txt in.txt",
    "sort --compress=gzip in.txt",
    "tree -ao out.txt",
    "tree -aR -H . -L 1",
    "file --compil",
    "git --exec-path=. log",
    "git diff --no-index --ext-d a b",
    "git diff --no-index --textc a b",
    'node -e \'require("fs").rmSync("x")\'',
    "node script.js",
    "python3 -c 'print(1)'",
    "/tmp/cat x",
    "npm test",
    "",
    "cat 'broken",
  ])("does not classify %s as read-only", (source) => {
    expect(classifyReadOnlyShellCommand(source).readOnly).toBe(false);
  });

  it("refuses oversized input instead of guessing", () => {
    expect(classifyReadOnlyShellCommand(`cat ${"a".repeat(9_000)}`).readOnly).toBe(false);
    expect(classifyReadOnlyShellCommand(undefined).readOnly).toBe(false);
  });
});

describe("describeReadOnlyCommand", () => {
  it("returns nothing for a command that is not read-only on its own", () => {
    expect(describeReadOnlyCommand(["rm", "-rf", "x"])).toBeUndefined();
    expect(describeReadOnlyCommand(["/bin/cat", "a"])).toBe("shows a");
    expect(describeReadOnlyCommand(["wc", "-l"], true)).toBe("counts the lines");
  });
});

describe("who may use the classifier", () => {
  // It explains a command on an approval card. It must never decide one: a
  // server, shared client runtime or provider package that imported it could
  // turn "looks read-only" into an automatic approval.
  it("is imported only by the approval cards that explain a command", () => {
    const root = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../..",
    );
    const importers: Array<string> = [];
    const visit = (directory: string) => {
      for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          NodeFS.readFileSync(path, "utf8").includes("readOnlyShellCommand")
        )
          importers.push(NodePath.relative(root, path));
      }
    };
    for (const scope of ["apps/server/src", "apps/web/src", "apps/mobile/src", "packages"]) {
      visit(NodePath.join(root, scope));
    }
    expect(importers.toSorted()).toEqual([
      "apps/mobile/src/features/threads/PendingApprovalCard.tsx",
      "apps/web/src/components/chat/approvalExplanation.ts",
    ]);
  });
});
