import { describe, expect, it } from "@effect/vitest";
import { withApprovalOptionIds } from "@starkfuture/contracts";

import {
  codexApprovalOptionsForClients,
  codexCommandApprovalChoices,
  codexCommandApprovalPrompt,
  codexCommandApprovalScope,
  codexFileChangeApprovalChoices,
  codexFileChangeApprovalScope,
  codexLegacyApprovalChoices,
  codexPermissionsApprovalChoices,
  codexRequestedPermissionsScope,
  resolveCodexApprovalChoice,
  validatedCodexExecpolicyAmendment,
} from "./CodexApprovalOptions.ts";

const amendment = (pattern: ReadonlyArray<string>) =>
  ({ acceptWithExecpolicyAmendment: { execpolicy_amendment: [...pattern] } }) as const;
const network = (host: string, action: "allow" | "deny") =>
  ({ applyNetworkPolicyAmendment: { network_policy_amendment: { host, action } } }) as const;

describe("Codex command approval choices", () => {
  it("offers exactly what Codex lists, in its order, with the listed payloads", () => {
    // The decisions the recorded subagent_v2_approval fixture lists.
    const choices = codexCommandApprovalChoices({
      command: "npm test -- --run",
      proposedExecpolicyAmendment: ["npm", "test"],
      availableDecisions: ["accept", amendment(["npm", "test"]), "cancel"],
    });
    expect(choices.map((choice) => [choice.optionId, choice.decision, choice.native])).toEqual([
      ["once:0", "accept", "accept"],
      ["persistent:0", "acceptAlways", amendment(["npm", "test"])],
      ["deny-stop:0", "cancel", "cancel"],
    ]);
    expect(codexApprovalOptionsForClients(choices).map((option) => option.label)).toEqual([
      "Allow once",
      "Always allow (Codex, every project)",
      "Deny and stop",
    ]);
  });

  it("refuses a decision Codex did not list, such as Allow for this session", () => {
    const choices = codexCommandApprovalChoices({
      command: "npm test",
      availableDecisions: ["accept", "cancel"],
    });
    expect(resolveCodexApprovalChoice(choices, { decision: "acceptForSession" })).toBeUndefined();
    expect(resolveCodexApprovalChoice(choices, { decision: "decline" })).toBeUndefined();
    expect(resolveCodexApprovalChoice(choices, { decision: "cancel" })?.native).toBe("cancel");
  });

  it("names Deny and Deny and stop for decline and cancel", () => {
    const options = codexApprovalOptionsForClients(
      codexCommandApprovalChoices({ command: "ls", availableDecisions: ["decline", "cancel"] }),
    );
    expect(options).toEqual([
      {
        decision: "decline",
        label: "Deny",
        optionId: "deny:0",
        effect: "deny",
        acceptsFeedback: false,
        nativePayload: "decline",
      },
      {
        decision: "cancel",
        label: "Deny and stop",
        optionId: "deny-stop:0",
        effect: "deny_and_stop",
        acceptsFeedback: false,
        nativePayload: "cancel",
      },
    ]);
  });

  it("gives every option an id the orchestrator keeps, bound to its exact native payload", () => {
    const options = codexApprovalOptionsForClients(
      codexCommandApprovalChoices({
        command: "npm install",
        availableDecisions: [
          "accept",
          "acceptForSession",
          amendment(["npm", "install"]),
          network("registry.npmjs.org", "allow"),
          "decline",
          "cancel",
        ],
      }),
    );
    expect(withApprovalOptionIds(options)).toEqual(options);
    expect(
      options.map((option) => [
        option.optionId,
        option.scope,
        option.persistsTo,
        option.nativePayload,
      ]),
    ).toEqual([
      ["once:0", "once", undefined, "accept"],
      ["session:0", "session", undefined, "acceptForSession"],
      ["persistent:0", "persistent", "codex-rules", amendment(["npm", "install"])],
      ["persistent:1", "persistent", "codex-network-rules", network("registry.npmjs.org", "allow")],
      ["deny:0", undefined, undefined, "decline"],
      ["deny-stop:0", undefined, undefined, "cancel"],
    ]);
    expect(options.every((option) => option.acceptsFeedback === false)).toBe(true);
  });

  it("sends a network amendment exactly as Codex proposed it and shows host and action", () => {
    const choices = codexCommandApprovalChoices({
      command: "npm install",
      availableDecisions: ["accept", network("registry.npmjs.org", "allow"), "cancel"],
    });
    const persistent = resolveCodexApprovalChoice(choices, { decision: "acceptAlways" });
    expect(persistent?.native).toEqual(network("registry.npmjs.org", "allow"));
    expect(persistent?.persistsTo).toBe("codex-network-rules");
    expect(persistent?.label).toBe("Always allow registry.npmjs.org");
    expect(persistent?.rulePreview).toEqual([
      'network_policy_amendment(host="registry.npmjs.org", action="allow")',
    ]);
  });

  it("shows a saved deny rule beside Deny, each selectable by its own id", () => {
    const choices = codexCommandApprovalChoices({
      command: "curl https://example.com",
      availableDecisions: [network("example.com", "deny"), "decline", "accept"],
    });
    // A client without option ids that answers Deny gets the plain decline.
    expect(resolveCodexApprovalChoice(choices, { decision: "decline" })?.native).toBe("decline");
    expect(
      codexApprovalOptionsForClients(choices).map((option) => [option.optionId, option.label]),
    ).toEqual([
      ["persistent:0", "Always block example.com"],
      ["deny:0", "Deny"],
      ["once:0", "Allow once"],
    ]);
    const saved = resolveCodexApprovalChoice(choices, { optionId: "persistent:0" });
    expect(saved?.effect).toBe("deny");
    expect(saved?.decision).toBe("decline");
    expect(saved?.native).toEqual(network("example.com", "deny"));
  });

  it("drops an unsafe listed rule and every remembered allow for Stark Pages publishing", () => {
    expect(
      codexCommandApprovalChoices({
        command: "/bin/bash -lc 'rm -rf build'",
        availableDecisions: ["accept", amendment(["/bin/bash", "-lc", "rm -rf build"]), "cancel"],
      }).map((choice) => choice.decision),
    ).toEqual(["accept", "cancel"]);
    expect(
      codexCommandApprovalChoices({
        command: "spage publish site",
        availableDecisions: [
          "accept",
          "acceptForSession",
          amendment(["spage", "publish"]),
          network("pages.starkfuture.com", "allow"),
          "decline",
        ],
      }).map((choice) => choice.decision),
    ).toEqual(["accept", "decline"]);
    // A command that may publish (spage run through a variable) is asked about
    // fresh every time too.
    expect(
      codexCommandApprovalChoices({
        command: "$CMD publish site",
        availableDecisions: [
          "accept",
          "acceptForSession",
          amendment(["sh", "-c", "$CMD publish site"]),
          network("pages.starkfuture.com", "allow"),
          "decline",
        ],
      }).map((choice) => choice.decision),
    ).toEqual(["accept", "decline"]);
  });

  it("falls back to the decisions every Codex accepts when the request lists none", () => {
    expect(
      codexCommandApprovalChoices({
        command: "npm test -- --run",
        proposedExecpolicyAmendment: ["npm", "test"],
      }).map((choice) => choice.native),
    ).toEqual(["decline", "accept", "acceptForSession", amendment(["npm", "test"]), "cancel"]);
  });

  it("prefers the option id over the legacy decision", () => {
    const choices = codexCommandApprovalChoices({
      command: "npm ci",
      availableDecisions: [network("registry.npmjs.org", "allow"), amendment(["npm", "ci"])],
    });
    // Both save a rule and share the legacy decision; the id names each one.
    expect(codexApprovalOptionsForClients(choices)).toHaveLength(2);
    expect(resolveCodexApprovalChoice(choices, { decision: "acceptAlways" })?.native).toEqual(
      network("registry.npmjs.org", "allow"),
    );
    expect(resolveCodexApprovalChoice(choices, { optionId: "persistent:1" })?.native).toEqual(
      amendment(["npm", "ci"]),
    );
    expect(
      resolveCodexApprovalChoice(choices, { optionId: "persistent:9", decision: "acceptAlways" }),
    ).toBeUndefined();
    expect(
      resolveCodexApprovalChoice(choices, { optionId: "persistent:1", decision: "decline" }),
    ).toBeUndefined();
  });
});

describe("Codex approval scope", () => {
  it("puts the network host and extra access on scope fields, not in the prompt", () => {
    const params = {
      reason: "Needs the registry",
      command: "npm install",
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
      additionalPermissions: {
        fileSystem: { read: null, write: ["/workspace/node_modules", " "] },
        network: { enabled: true },
      },
    } as const;
    expect(codexCommandApprovalPrompt(params)).toBe("Needs the registry");
    expect(codexCommandApprovalScope(params)).toEqual({
      network: { host: "registry.npmjs.org", protocol: "https" },
      requestedPermissions: { writePaths: ["/workspace/node_modules"], network: true },
    });
    expect(codexCommandApprovalScope({ command: "ls" } as never)).toEqual({});
    expect(codexCommandApprovalPrompt({ kind: "writeStdin", command: "python3" })).toBe(
      "Send input to a running command: python3",
    );
  });

  it("names a permissions request's paths and network, and a file change's grant root", () => {
    expect(
      codexRequestedPermissionsScope({
        fileSystem: { read: ["/etc/hosts"], write: null },
        network: { enabled: false },
      }),
    ).toEqual({ readPaths: ["/etc/hosts"] });
    expect(codexRequestedPermissionsScope({ fileSystem: null, network: null })).toBeUndefined();
    expect(codexFileChangeApprovalScope({ grantRoot: " /workspace/src " })).toEqual({
      grantRoot: "/workspace/src",
    });
    expect(codexFileChangeApprovalScope({ grantRoot: null })).toEqual({});
  });

  it("says a file change session approval may cover its grant root", () => {
    const session = resolveCodexApprovalChoice(
      codexFileChangeApprovalChoices({ grantRoot: "/workspace/src" }),
      { decision: "acceptForSession" },
    );
    expect(session?.detail).toBe(
      "Codex asked to write anywhere under /workspace/src for the rest of its session.",
    );
    expect(session?.native).toBe("acceptForSession");
  });

  it("grants exactly the requested permissions for a turn or a session, or nothing", () => {
    const permissions = {
      fileSystem: { read: null, write: ["/workspace/out"] },
      network: { enabled: true },
    };
    const choices = codexPermissionsApprovalChoices(permissions);
    expect(
      codexApprovalOptionsForClients(choices).map((option) => [option.decision, option.label]),
    ).toEqual([
      ["decline", "Deny"],
      ["accept", "Grant for this turn"],
      ["acceptForSession", "Grant for this session"],
    ]);
    expect(resolveCodexApprovalChoice(choices, { decision: "accept" })?.native).toEqual({
      permissions,
      scope: "turn",
    });
    expect(resolveCodexApprovalChoice(choices, { decision: "acceptForSession" })?.native).toEqual({
      permissions,
      scope: "session",
    });
    expect(resolveCodexApprovalChoice(choices, { decision: "decline" })?.native).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(resolveCodexApprovalChoice(choices, { decision: "cancel" })).toBeUndefined();
    expect(resolveCodexApprovalChoice(choices, { decision: "accept" })?.detail).toBe(
      "Write: /workspace/out. Network access",
    );
  });
});

describe("Codex permission entries", () => {
  // Codex 0.163 profiles carry `entries` (special paths, globs, access modes);
  // the legacy `read`/`write` lists may be absent or lag behind them.
  const entries = {
    fileSystem: {
      entries: [
        { path: { type: "special", value: { kind: "root" } }, access: "write" },
        { path: { type: "glob_pattern", pattern: "**/*.env" }, access: "read" },
        { path: { type: "path", path: "/workspace/secrets" }, access: "deny" },
        {
          path: { type: "special", value: { kind: "project_roots", subpath: "docs" } },
          access: "read",
        },
        { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
      ],
    },
  } as const;

  it("describes and shows a profile given only as entries", () => {
    expect(codexRequestedPermissionsScope(entries)).toEqual({
      readPaths: ["**/*.env (pattern)", "Project roots/docs"],
      writePaths: ["/ (the whole filesystem)", "$TMPDIR"],
    });
    const session = resolveCodexApprovalChoice(codexPermissionsApprovalChoices(entries), {
      decision: "acceptForSession",
    });
    expect(session?.detail).toBe(
      "Write: / (the whole filesystem), $TMPDIR. Read: **/*.env (pattern), Project roots/docs. No access: /workspace/secrets",
    );
    expect(session?.native).toEqual({ permissions: entries, scope: "session" });
  });

  it("shows a command's extra access given as entries", () => {
    expect(
      codexCommandApprovalScope({
        additionalPermissions: {
          fileSystem: {
            entries: [{ path: { type: "special", value: { kind: "root" } }, access: "write" }],
          },
        },
      }),
    ).toEqual({ requestedPermissions: { writePaths: ["/ (the whole filesystem)"] } });
  });

  it("prefers entries over the legacy lists when both are sent", () => {
    expect(
      codexRequestedPermissionsScope({
        fileSystem: {
          read: ["/workspace/a"],
          write: ["/workspace/a"],
          entries: [{ path: { type: "path", path: "/workspace/a" }, access: "read" }],
        },
      }),
    ).toEqual({ readPaths: ["/workspace/a"] });
    expect(
      codexRequestedPermissionsScope({
        fileSystem: { write: ["/workspace/out"], entries: [] },
      }),
    ).toEqual({ writePaths: ["/workspace/out"] });
  });
});

describe("Codex legacy approvals and saved rules", () => {
  it("offers no session approval for a Stark Pages publish from an older Codex", () => {
    expect(
      codexLegacyApprovalChoices({ command: ["npx", "spage", "publish", "site"] }).map(
        (choice) => choice.decision,
      ),
    ).toEqual(["decline", "accept"]);
    expect(
      codexLegacyApprovalChoices({ command: ["git", "status"] }).map((choice) => choice.optionId),
    ).toEqual(["deny:0", "once:0", "session:0"]);
  });

  it("saves only exact, narrow command prefixes", () => {
    expect(validatedCodexExecpolicyAmendment(["npm", "test"])).toEqual(["npm", "test"]);
    for (const unsafe of [
      [],
      ["git"],
      ["bash", "-c"],
      ["python3", "script.py"],
      ["npm", "*"],
      ["npm", "test; rm -rf /"],
      ["spage", "publish"],
    ])
      expect(validatedCodexExecpolicyAmendment(unsafe)).toBeNull();
    expect(
      validatedCodexExecpolicyAmendment(["npx", "spage"], "npx spage publish site"),
    ).toBeNull();
  });
});
