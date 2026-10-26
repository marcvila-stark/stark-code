// @effect-diagnostics nodeBuiltinImport:off -- Verify generated hook commands at the actual shell boundary without invoking a provider.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { nativeReplyHookCommand, truncateNativeReplyText } from "./NativeReplyHook.ts";

describe("native hook command and reply bounds", () => {
  it("retains complete Unicode at and beyond the byte limit", () => {
    const exact = "💡".repeat(32_768);
    expect(truncateNativeReplyText(exact)).toEqual({ text: exact, truncated: false });
    expect(truncateNativeReplyText(exact + "a")).toEqual({ text: exact, truncated: true });
    const prefix = "x".repeat(131_070);
    expect(truncateNativeReplyText(prefix + "💡")).toEqual({ text: prefix, truncated: true });
  });

  it.effect(
    "executes Windows Claude paths containing spaces and shell metacharacters through Bash",
    (ctx) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32")
          return ctx.skip("Bash command execution on POSIX host");
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-windows-bash-hook-"));
        try {
          const nodePath = "C:/Program Files/Stark's $safe %!()/node.exe";
          const scriptPath = "C:/Users/O'Brien $safe %!()/capture.cjs";
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, nodePath)), { recursive: true });
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, scriptPath)), { recursive: true });
          NodeFS.symlinkSync(process.execPath, NodePath.join(root, nodePath));
          NodeFS.writeFileSync(
            NodePath.join(root, scriptPath),
            'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE + ":literal paths");',
          );
          const command = nativeReplyHookCommand({
            platform: "win32",
            provider: "claude",
            nodeExecutable: nodePath.replaceAll("/", "\\"),
            scriptPath: scriptPath.replaceAll("/", "\\"),
          });
          expect(
            NodeChildProcess.execFileSync("/bin/bash", ["-c", command], {
              cwd: root,
              env: { PATH: "/usr/bin:/bin" },
              encoding: "utf8",
            }),
          ).toBe("1:literal paths");
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it("keeps Codex Windows paths out of cmd interpolation and quotes them as PowerShell literals", () => {
    const command = nativeReplyHookCommand({
      platform: "win32",
      provider: "codex",
      nodeExecutable: "C:\\Program Files\\Stark's %PATH%!node.exe",
      scriptPath: "C:\\Users\\O'Brien & (test)\\capture.cjs",
    });
    const prefix =
      '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ';
    expect(command.startsWith(prefix)).toBe(true);
    const encoded = command.slice(prefix.length);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
      "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Stark''s %PATH%!node.exe' 'C:\\Users\\O''Brien & (test)\\capture.cjs'; exit $LASTEXITCODE",
    );
    expect(command).not.toContain("-ExecutionPolicy");
  });
});
