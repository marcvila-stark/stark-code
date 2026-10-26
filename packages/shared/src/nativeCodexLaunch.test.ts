import { describe, expect, it } from "@effect/vitest";
import { tokenizeCliArgs } from "./cliArgs.ts";
import {
  NativeAgentLaunchRefused,
  supervisedNativeCodexArgs,
  validateNativeCodexLaunchArgs,
} from "./nativeCodexLaunch.ts";

const tail = (sandbox = "read-only", noDaemon = true) => [
  "--ask-for-approval",
  "on-request",
  "--sandbox",
  sandbox,
  "-c",
  'approvals_reviewer="user"',
  "-c",
  "sandbox_workspace_write.network_access=false",
  ...(noDaemon ? ["--no-daemon"] : []),
];
const args = (input: string) => supervisedNativeCodexArgs(tokenizeCliArgs(input));

describe("supervised native Codex arguments", () => {
  it.each([
    "",
    "-a on-request",
    "-aon-request",
    "-a=on-request",
    "--ask-for-approval=on-request",
    "-a untrusted",
    "-s read-only",
    "--sandbox=read-only",
  ])("normalises %s to the read-only launch policy", (input) =>
    expect(args(input)).toEqual(tail()),
  );
  it.each([
    "-s workspace-write",
    "-sworkspace-write",
    "-s=workspace-write",
    "--sandbox=workspace-write",
    "-a on-request -s workspace-write",
  ])("preserves explicit workspace-write opt-in %s", (input) =>
    expect(args(input)).toEqual(tail("workspace-write")),
  );
  it.each([
    ["-p work", ["-p", "work"]],
    ["--profile=work", ["--profile", "work"]],
    [
      "-m gpt-x --search --no-alt-screen --strict-config --enable foo --disable bar",
      [
        "-m",
        "gpt-x",
        "--search",
        "--no-alt-screen",
        "--strict-config",
        "--enable",
        "foo",
        "--disable",
        "bar",
      ],
    ],
    ["--oss --local-provider=ollama", ["--oss", "--local-provider", "ollama"]],
    [
      "-c 'model=\"x\"' -c analytics.enabled=true",
      ["-c", 'model="x"', "-c", "analytics.enabled=true"],
    ],
  ] as const)("keeps supported configuration %s", (input, prefix) =>
    expect(args(input)).toEqual([...prefix, ...tail()]),
  );
  it("does not duplicate no-daemon or safe policy flags", () => {
    expect(
      args("--no-daemon --no-daemon -a untrusted -a on-request -s workspace-write -s read-only"),
    ).toEqual(["--no-daemon", ...tail("read-only", false)]);
  });
  const refused = [
    "--yolo",
    "--dangerously-bypass-approvals-and-sandbox",
    "--full-auto",
    "--approve-for-me",
    "--not-so-yolo",
    "--dangerously-bypass-hook-trust",
    "-a never",
    "-anever",
    "-a=never",
    "--ask-for-approval never",
    "--ask-for-approval=never",
    "-a",
    "-a --search",
    "-s danger-full-access",
    "-sdanger-full-access",
    "-s=danger-full-access",
    "--sandbox danger-full-access",
    "--sandbox=danger-full-access",
    "-s",
    "-c approval_policy=never",
    "-capproval_policy=never",
    "--config approval_policy=never",
    "--config=approval_policy=never",
    "-c approval_policy.granular.sandbox_approval=false",
    "-c sandbox_mode=danger-full-access",
    "-c ' sandbox_mode = danger-full-access'",
    "-c '\"sandbox_mode\"=danger-full-access'",
    "-c SANDBOX_MODE=x",
    "-c sandbox_workspace_write.network_access=true",
    "-c 'sandbox_workspace_write={network_access=true}'",
    "-c approvals_reviewer=auto_review",
    "-c 'default_permissions=\":danger-full-access\"'",
    "-c permissions.full.network.enabled=true",
    "-c profile=work",
    "-c 'approval_policy=\"on-request\"'",
    "-c 'sandbox_mode=\"read-only\"'",
    "-c '\"permissions\".full.network.enabled=true'",
    "-c missing-equals",
    "-c",
    "-C /",
    "-C/",
    "--cd=/",
    "--add-dir /",
    "--worktree",
    "--remote ws://127.0.0.1:1",
    "--remote-auth-token-env TOKEN",
    "-i a.png",
    "-ia.png",
    "exec",
    "resume --last",
    "fork",
    "sandbox -- ls",
    "app-server",
    "apply",
    "cloud",
    "-- --yolo",
    '"fix the bug"',
    "--some-future-flag",
  ];
  it.each(refused)("refuses %s with a named reason at launch and save", (input) => {
    for (const validate of [() => args(input), () => validateNativeCodexLaunchArgs(input)]) {
      let caught: unknown;
      try {
        validate();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NativeAgentLaunchRefused);
      const error = caught as NativeAgentLaunchRefused;
      expect(error.flag.length).toBeGreaterThan(0);
      expect(error.reason.length).toBeGreaterThan(0);
      expect(error.message).toContain(error.flag);
      expect(error.message).toContain("Settings > Providers");
    }
  });
  it("maintains launch-policy invariants across accepted combinations and orderings", () => {
    for (const approval of ["", "-a on-request", "-a=untrusted"])
      for (const sandbox of ["", "-sread-only", "--sandbox=workspace-write"])
        for (const personal of [
          "",
          "--profile work",
          "--no-daemon",
          "--model gpt-x --search",
          "-c analytics.enabled=true -c otel.exporter=none",
        ])
          for (const order of [
            [approval, sandbox, personal],
            [personal, approval, sandbox],
          ]) {
            const output = args(order.filter(Boolean).join(" "));
            expect(output.filter((arg) => arg === "--ask-for-approval")).toHaveLength(1);
            expect(output[output.indexOf("--ask-for-approval") + 1]).toBe("on-request");
            expect(output.filter((arg) => arg === "--sandbox")).toHaveLength(1);
            expect(["read-only", "workspace-write"]).toContain(
              output[output.indexOf("--sandbox") + 1],
            );
            expect(output).not.toContain("never");
            expect(output).not.toContain("danger-full-access");
            expect(output.filter((arg) => arg === "--no-daemon")).toHaveLength(1);
            expect(output.indexOf('approvals_reviewer="user"')).toBeGreaterThan(
              output.indexOf("analytics.enabled=true"),
            );
          }
  });
});
