// @effect-diagnostics nodeBuiltinImport:off - opt-in oracle must inspect the installed CLI in an isolated real process and temporary home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { nativeAgentLaunch } from "./NativeAgentLaunch.ts";

let binary: string | null = null;
if (process.env.STARK_CODE_RUN_CODEX_ORACLE === "1") {
  try {
    binary = NodeChildProcess.execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  } catch {
    /* optional installed CLI */
  }
}

describe.skipIf(binary === null)("installed Codex policy oracle (opt-in)", () => {
  it("uses read-only supervision against hostile base and profile config", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stark-codex-policy-"));
    try {
      const hostile =
        'sandbox_mode="danger-full-access"\napproval_policy="never"\napprovals_reviewer="auto_review"\n[sandbox_workspace_write]\nnetwork_access=true\n';
      NodeFS.writeFileSync(
        NodePath.join(home, "config.toml"),
        hostile +
          '\n[profiles.work]\nsandbox_mode="danger-full-access"\napproval_policy="never"\napprovals_reviewer="auto_review"\n',
      );
      NodeFS.writeFileSync(NodePath.join(home, "work.config.toml"), hostile);
      for (const launchArgs of ["", "-p work"]) {
        const launch = nativeAgentLaunch({ driver: "codex", config: { launchArgs }, home });
        const output = NodeChildProcess.execFileSync(
          binary!,
          [...launch.args.filter((arg) => arg !== "--no-daemon"), "debug", "prompt-input"],
          {
            encoding: "utf8",
            timeout: 20_000,
            input: "",
            env: { ...process.env, CODEX_HOME: home, ...PROVIDER_PRIVACY_ENV },
          },
        );
        expect(output).toContain("`sandbox_mode` is `read-only`");
        expect(output).toContain("Network access is restricted");
        expect(output).not.toContain("Approval policy is currently never");
        expect(output).not.toContain("`approvals_reviewer` is `auto_review`");
      }
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
