// @effect-diagnostics nodeBuiltinImport:off - Verify the shipped offline artifact in an isolated directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { validateStarkWorkbenchRoot } from "@starkfuture/shared/starkWorkbench";
import { prepareStarkWorkbench } from "./prepare-stark-workbench.mjs";

const vendorRoot = NodeURL.fileURLToPath(new URL("../vendor/stark-workbench", import.meta.url));
const temporary: string[] = [];
const scratch = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-kit-test-"));
  temporary.push(root);
  return root;
};
afterEach(() => {
  for (const root of temporary.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("bundled Workbench payload", () => {
  it.effect(
    "extracts offline with no links to the source checkout and validates the resource",
    () =>
      Effect.gen(function* () {
        const root = prepareStarkWorkbench({ destination: NodePath.join(scratch(), "kit") });
        expect(yield* validateStarkWorkbenchRoot(root)).toBe(root);
        const files = NodeFS.readdirSync(root, { recursive: true, withFileTypes: true });
        expect(files.some((entry) => entry.isSymbolicLink())).toBe(false);
        expect(
          files.some((entry) =>
            [".git", ".env", "test", "tests", "fixtures", ".npm-cache"].includes(entry.name),
          ),
        ).toBe(false);
        expect(NodeFS.readFileSync(NodePath.join(root, ".stark-bundle.json"), "utf8")).toContain(
          "9c9c7aafe8ad39286bcbaec2e698d539ed4e0b68",
        );
        expect(prepareStarkWorkbench({ destination: root })).toBe(root);
        NodeFS.writeFileSync(NodePath.join(root, "hooks/hooks.json"), "local change");
        prepareStarkWorkbench({ destination: root, force: true });
        expect(NodeFS.readFileSync(NodePath.join(root, "hooks/hooks.json"), "utf8")).toContain(
          "PreToolUse",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("rejects a changed archive before extracting it", () => {
    const root = scratch();
    NodeFS.copyFileSync(
      NodePath.join(vendorRoot, "provenance.json"),
      NodePath.join(root, "provenance.json"),
    );
    NodeFS.writeFileSync(NodePath.join(root, "runtime.tar.gz"), "changed");
    const destination = NodePath.join(root, "kit");
    expect(() => prepareStarkWorkbench({ vendorRoot: root, destination })).toThrow(
      "integrity check",
    );
    expect(NodeFS.existsSync(destination)).toBe(false);
  });

  // oxlint-disable-next-line starkcode/no-global-process-runtime -- This POSIX shell integration probe is intentionally skipped on Windows.
  it.skipIf(process.platform === "win32")(
    "renders with bundled dependencies and runs the real publish guard without node on PATH",
    () => {
      const root = prepareStarkWorkbench({
        destination: NodePath.join(scratch(), "kit with spaces"),
      });
      const home = scratch();
      const page = NodePath.join(home, "page");
      NodeFS.cpSync(NodePath.join(root, "examples/pages/terminal-or-app"), page, {
        recursive: true,
      });
      const output = NodePath.join(home, "report.html");
      const node = process.execPath;
      const env = {
        PATH: "/no-user-tools",
        HOME: home,
        STARK_WORKBENCH_NODE: node,
        CLAUDE_PLUGIN_ROOT: root,
        STARK_WORKBENCH_MANAGED_MIRROR: "1",
      };
      NodeChildProcess.execFileSync(
        node,
        [NodePath.join(root, "packages/spage/bin/spage.js"), "render", page, "--out", output],
        { env },
      );
      expect(NodeFS.readFileSync(output, "utf8")).toContain("<!doctype html>");
      const hooks = JSON.parse(
        NodeFS.readFileSync(NodePath.join(root, "hooks/hooks.json"), "utf8"),
      );
      const result = NodeChildProcess.execFileSync(
        "/bin/sh",
        ["-c", hooks.hooks.PreToolUse[0].hooks[0].command],
        {
          cwd: home,
          env,
          input: JSON.stringify({
            hook_event_name: "PreToolUse",
            cwd: home,
            session_id: "bundle-test",
            permission_mode: "bypassPermissions",
            tool_name: "mcp__stark__pages_upload_begin",
            tool_input: { path: "index.html" },
          }),
          encoding: "utf8",
        },
      );
      expect(JSON.parse(result).hookSpecificOutput.permissionDecision).toBe("deny");
      const start = NodeChildProcess.execFileSync(
        node,
        [
          "--input-type=module",
          "-e",
          `const {spawnDetachedMirror}=await import(${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(root, "packages/spage/src/server.js")).href)}); process.stdout.write(String(spawnDetachedMirror(${JSON.stringify(home)}, {open:true})));`,
        ],
        { env, encoding: "utf8" },
      );
      expect(start).toBe("false");
      expect(NodeFS.existsSync(NodePath.join(home, "pages/.spage/mirror.json"))).toBe(false);
    },
  );
});
