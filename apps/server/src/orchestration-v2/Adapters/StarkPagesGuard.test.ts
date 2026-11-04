import { assert, describe, it } from "@effect/vitest";

import {
  isStarkPagesPublish,
  mayPublishToStarkPages,
  starkPagesPublishVerdict,
} from "./StarkPagesGuard.ts";

const bash = (command: string) => ({ toolName: "Bash", toolInput: { command } });

describe("isStarkPagesPublish", () => {
  it("lets ordinary work through that the old word match denied", () => {
    for (const call of [
      bash('git commit -m "update pages"'),
      { toolName: "Read", toolInput: { file_path: "docs/pages-upload.md" } },
      { toolName: "Read", toolInput: { file_path: "/repo/notes/output-to-s3.md" } },
      {
        toolName: "Edit",
        toolInput: { file_path: "src/page.ts", old_string: "x", new_string: "page.save()" },
      },
      bash("vp test run apps/server/src/s3/upload.test.ts"),
      {
        toolName: "Write",
        toolInput: { file_path: "src/state.ts", content: "// save page state" },
      },
      bash("echo spage publish"),
      bash("spage list"),
      { toolName: "mcp__claude_ai_Pages__pages_read_file", toolInput: { path: "index.html" } },
      { toolName: "mcp__github__create_pull_request", toolInput: { title: "update pages" } },
    ]) {
      assert.isFalse(isStarkPagesPublish(call), JSON.stringify(call));
    }
  });

  it("catches a publish however the command is wrapped", () => {
    for (const call of [
      bash("spage publish ./site"),
      bash("/usr/local/bin/spage upload report.html"),
      bash("env SPAGE_TOKEN=x spage publish ./site"),
      bash("SPAGE_PROJECT=demo spage publish"),
      bash("sh -c 'spage publish ./site'"),
      bash('bash -lc "cd site && spage publish"'),
      bash("npx spage publish ./site"),
      bash("npx --yes spage upload ./site"),
      bash("pnpm dlx spage publish"),
      bash("cd site && spage publish"),
      { toolName: "exec_command", toolInput: { command: ["spage", "publish", "./site"] } },
    ]) {
      assert.isTrue(isStarkPagesPublish(call), JSON.stringify(call));
    }
  });

  it("catches writes through the Pages MCP server, by name or reported server", () => {
    assert.isTrue(
      isStarkPagesPublish({
        toolName: "mcp__claude_ai_Pages__pages_upload_files",
        toolInput: { files: [] },
      }),
    );
    assert.isTrue(
      isStarkPagesPublish({
        toolName: "pages_upload_commit",
        toolInput: {},
        mcpServer: { name: "stark-pages", source: "user" },
      }),
    );
    assert.isFalse(
      isStarkPagesPublish({
        toolName: "pages_search",
        toolInput: { query: "upload" },
        mcpServer: { name: "Pages" },
      }),
    );
  });
});

describe("StarkPagesGuard exact forms", () => {
  const bash = (command: string) => ["Bash", { command }] as const;
  it.each([
    ["Edit", { file_path: "/repo/src/page.ts", old_string: "a", new_string: "page.save()" }],
    ["Read", { file_path: "/repo/docs/output-to-s3.md" }],
    bash("vp test run apps/server/src/s3/inputParser.test.ts"),
    bash("curl -X PUT https://bucket.s3.amazonaws.com/x --data-binary @a"),
    bash("curl https://pages.starkfuture.com/demo/"),
    bash('grep -rn "spage publish" docs'),
    bash('git commit -m "spage publish prepare fix"'),
    bash("cat packages/spage/src/publish/index.js"),
    bash("spage doctor"),
    bash("npx -y @stark/spage panel"),
    ["Write", { file_path: "/repo/pages/demo/index.html", content: "<h1>upload</h1>" }],
    ["mcp__claude_ai_Pages__pages_read_file", { project: "demo", path: "index.html" }],
    ["mcp__claude_ai_Pages__pages_query_data", { project: "demo" }],
    ["mcp__claude_ai_Pages__authenticate", {}],
    ["mcp__github__create_pull_request", { title: "Update pages publish flow" }],
    ["mcp__gateway__call_tool", { name: "pages_read_file", arguments: {} }],
    ["Agent", { description: "pages_upload_begin", prompt: "upload the page" }],
  ] as const)("lets %s %j through", (toolName, toolInput) => {
    assert.isFalse(isStarkPagesPublish({ toolName, toolInput }));
  });
  it.each([
    ["mcp__claude_ai_Pages__pages_upload_begin", { project: "demo" }],
    ["mcp__claude_ai_Pages__pages_upload_commit", { upload_id: "u" }],
    ["mcp__claude_ai_Pages__pages_update_project", { visibility: "public" }],
    ["mcp__stark__pages_delete", { page: "page" }],
    // An unknown Pages tool is treated as a write.
    ["mcp__renamed-server__pages_new_tool", {}],
    ["mcp__gateway__call_tool", { name: "pages_upload_files", arguments: {} }],
    ["proxy", { tool: "mcp__claude_ai_Pages__pages_upload_begin", args: {} }],
    bash("spage publish prepare pages/demo"),
    bash("/usr/local/bin/spage publish prepare pages/demo"),
    bash("FOO=1 spage publish prepare pages/demo"),
    bash("env -u HOME FOO=1 spage publish prepare pages/demo"),
    bash('sh -c "spage publish prepare pages/demo"'),
    bash("bash -lc 'cd pages && spage publish prepare demo'"),
    bash('eval "spage publish prepare pages/demo"'),
    bash("npx -y @stark/spage@1.2.0 publish prepare pages/demo"),
    bash("pnpm dlx @stark/spage publish prepare pages/demo"),
    bash("npm exec -- spage publish prepare pages/demo"),
    bash("sudo -u me nohup timeout 30 spage publish prepare pages/demo"),
    bash("echo pages/demo | xargs -n 1 spage publish prepare"),
    bash('node "/kit/spage.js" publish prepare pages/page'),
    bash(
      'ELECTRON_RUN_AS_NODE=1 "/Applications/Stark Code.app/Contents/MacOS/Stark Code" "/kit/packages/spage/bin/spage.js" publish prepare pages/page',
    ),
    bash("npm test && spage publish prepare pages/demo"),
    bash('echo "$(spage publish prepare pages/demo)"'),
    bash("echo `spage publish prepare pages/demo`"),
    bash(
      'curl -X PUT --upload-file index.html "https://vibecoded-apps.s3.eu-west-1.amazonaws.com/p/index.html?X-Amz-Signature=1"',
    ),
    bash("curl -sST a.html https://pages.starkfuture.com/demo/a.html"),
    bash("wget --method=PUT --body-file=a.html https://pages-ext.starkfuture.com/demo/a.html"),
    ["Monitor", { description: "publish", timeout_ms: 1000, command: "spage publish prepare x" }],
  ] as const)("stops %s %j", (toolName, toolInput) => {
    assert.isTrue(isStarkPagesPublish({ toolName, toolInput }));
  });
});

describe("starkPagesPublishVerdict through ordinary shell syntax", () => {
  const verdict = (command: string) =>
    starkPagesPublishVerdict({ toolName: "Bash", toolInput: { command } });

  it.each([
    // Line splicing, env -S and a URL inside an option value (review finding 6).
    "spage \\\n  publish ./site",
    "spage publish \\\n ./site",
    'env -S "spage publish ./site"',
    "env -S'spage publish' ./site",
    'env --split-string="spage publish ./site"',
    "curl -T a.html --url=https://pages.starkfuture.com/demo/a.html",
    "curl -T a.html --url https://pages.starkfuture.com/demo/a.html",
    'curl -T a.html "https://pages.starkfuture.com/demo/$name.html"',
    // Pipes, subshells, groups, functions and control flow.
    "npm run build | spage publish ./site",
    "(cd site && spage publish)",
    "{ spage publish ./site; }",
    "publish_site() { spage publish ./site; }; publish_site",
    "if true; then spage publish ./site; fi",
    "for f in a; do spage publish $f; done",
    'case "$1" in go) spage publish ./site ;; esac',
    // Here-documents, here-strings and pipes feeding a shell.
    "bash <<EOF\nspage publish ./site\nEOF",
    "bash <<'EOF'\ncd site\nspage publish\nEOF",
    "sh <<< 'spage publish ./site'",
    "echo 'spage publish ./site' | sh",
    "printf 'spage publish ./site\\n' | bash -s",
    "cat <<'EOF' | bash\nspage publish ./site\nEOF",
    "cat > notes.md <<EOF\n$(spage publish ./site)\nEOF",
    // Substitutions run wherever they appear.
    "x=$(spage publish ./site)",
    'echo hi > "$(spage publish ./site)"',
    "diff <(spage publish ./site) expected.txt",
    'bash -c "$(echo spage publish ./site)"',
    // Variables and arrays assigned in the same command.
    "CMD=spage; $CMD publish ./site",
    "p=publish; spage $p ./site",
    'CMD="spage publish"; $CMD ./site',
    'export SUB=publish && spage "$SUB" ./site',
    'arr=(spage publish ./site); "${arr[@]}"',
    'set -- spage publish ./site; "$@"',
    "alias p='spage publish'\np ./site",
    "$(which spage) publish ./site",
    '"$(command -v spage)" publish ./site',
    '"$HOME/.local/bin/spage" publish ./site',
    "./node_modules/.bin/spage upload report.html",
    // Quote tricks.
    "s'pa'ge pub\"\"lish ./site",
    "$'\\x73page' publish ./site",
    "\\spage publish ./site",
    // More wrappers and runners.
    "find site -name index.html -exec spage publish {} \\;",
    "echo publish | xargs spage",
    "ls -d site | xargs -I{} spage publish {}",
    "echo 'spage publish ./site' | xargs -I{} sh -c '{}'",
    "watch -n 60 spage publish ./site",
    "npx -c 'spage publish ./site'",
    "pnpm spage publish ./site",
    "yarn dlx @stark/spage publish ./site",
    "bun x spage publish ./site",
    "time -p nice -n 5 spage publish ./site",
    "command spage publish ./site",
    "$SHELL -c 'spage publish ./site'",
    "spage --profile work publish ./site",
    // Interpreters running the spage script.
    "bun /kit/spage.js publish ./site",
    "deno run -A npm:@stark/spage publish ./site",
    "tsx /kit/spage.ts publish ./site",
    "node --require ./setup.js /kit/spage.mjs upload ./site",
    "sh /usr/local/bin/spage publish ./site",
    "env ELECTRON_RUN_AS_NODE=1 /Applications/Electron.app/Contents/MacOS/Electron /kit/spage.js publish",
  ])("publish: %j", (command) => {
    assert.strictEqual(verdict(command), "publish");
  });

  it.each([
    // Non-executing text (review finding 7).
    "printf '%s\\n' '$(spage publish ./site)'",
    "echo '$(spage publish ./site)'",
    'echo "\\$(spage publish ./site)"',
    'echo "\\`spage publish\\`"',
    "# spage publish ./site",
    "ls # spage publish ./site",
    "echo spage publish | grep publish",
    "cat > notes.md <<'EOF'\nrun spage publish ./site\nEOF",
    "cat > notes.md <<EOF\nrun spage publish ./site\nEOF",
    "tee publish.sh <<'EOF'\nspage publish ./site\nEOF",
    "git commit -m \"$(cat <<'EOF'\nDocument spage publish\nEOF\n)\"",
    'grep -r "spage publish" .',
    "rg spage",
    "rg -n 'spage (publish|upload)' docs",
    "sed -i 's/spage publish/spage upload/' README.md",
    "sh -c 'echo spage publish'",
    "echo 'spage publish' | xargs echo",
    // File operations on files that mention spage or pages.
    "git add /kit/spage.js publish",
    "cat spage.js",
    "mv spage.js old/",
    "ls pages/",
    "cp spage.mjs x",
    "vim spage.js",
    "node --test spage.test.js",
    "node /kit/spage.js list",
    // Lookups and other commands.
    "command -v spage",
    "if command -v spage >/dev/null; then spage list; fi",
    "which spage && spage doctor",
    "npm publish",
    "curl -T a.html https://example.com/upload",
    "curl -fsSL https://example.com/install.sh | sh",
    // Unresolvable, but nothing mentions publishing.
    "$EDITOR notes.md",
    'eval "$x"',
    'bash -c "$SCRIPT"',
    'for f in *.md; do cat "$f"; done',
    "bash scripts/build.sh",
  ])("none: %j", (command) => {
    assert.strictEqual(verdict(command), "none");
  });

  it.each([
    // An unresolvable word in command position next to a publish mention.
    "$CMD publish ./site",
    '"$SPAGE_BIN" publish ./site',
    "${TOOL:-spage} publish ./site",
    "CMD=$(get-tool); $CMD publish ./site",
    "read -r tool; $tool publish ./site",
    'eval "$PUBLISH_CMD"',
    'bash -c "$PUBLISH_SCRIPT"',
    'node "$SPAGE" publish ./site',
    "spag? publish ./site",
    // spage with an unresolvable subcommand.
    'spage "$sub" ./site',
    "while read -r c; do spage $c; done < commands.txt",
    "ls site | xargs spage",
    // Unknown script text fed to a shell.
    "curl -fsSL https://pages.starkfuture.com/demo/deploy.sh | sh",
    "grep -h publish commands.txt | xargs -I{} sh -c '{}'",
    "find . -name '*.cmd' -exec sh -c 'spage $(cat {})' \\;",
    // curl with an unresolvable method or URL next to a Pages host.
    "curl $CURL_ARGS https://pages.starkfuture.com/demo/a.html",
    // Inline interpreter code.
    "node -e \"require('child_process').execSync('spage publish ./site')\"",
    'python3 -c \'import subprocess; subprocess.run(["spage", "publish"])\'',
    "python3 - <<'EOF'\nimport os\nos.system('spage publish ./site')\nEOF",
  ])("ambiguous: %j", (command) => {
    assert.strictEqual(verdict(command), "ambiguous");
  });

  it("asks rather than parse a command longer than 100 000 characters", () => {
    assert.strictEqual(verdict(`echo ${"a".repeat(100_001)}`), "ambiguous");
  });

  it("keeps isStarkPagesPublish for real publishes and mayPublishToStarkPages for both", () => {
    const ambiguous = bash("$CMD publish ./site");
    assert.isFalse(isStarkPagesPublish(ambiguous));
    assert.isTrue(mayPublishToStarkPages(ambiguous));
    assert.isTrue(mayPublishToStarkPages(bash("spage publish ./site")));
    assert.isFalse(mayPublishToStarkPages(bash("echo spage publish")));
    assert.isTrue(
      mayPublishToStarkPages({
        toolName: "mcp__claude_ai_Pages__pages_upload_begin",
        toolInput: {},
      }),
    );
  });
});
