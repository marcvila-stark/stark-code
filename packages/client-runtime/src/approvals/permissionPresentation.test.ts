import type {
  OrchestrationV2RuntimeRequestDeliveryState,
  ProviderApprovalOption,
} from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  STARK_PAGES_UNCERTAIN_NOTE,
  approvalPromptParts,
  APPROVAL_NO_CHOICES,
  approvalOffersNoChoices,
  approvalChoiceClass,
  approvalChoiceResponse,
  approvalDeliveryIssue,
  approvalKindTitle,
  approvalRecord,
  approvalRequestScope,
  approvalScopeRows,
  presentApprovalChoices,
  runtimeModeDisabledReason,
  runtimeRequestDeliveryCaption,
} from "./permissionPresentation.ts";

const delivery = (state: OrchestrationV2RuntimeRequestDeliveryState) => ({ state });

describe("approval choices", () => {
  // Exactly what the Claude adapter offers (ApprovalRulePolicy.claudeApprovalOptions): each
  // class numbered from 0, in the adapter's order.
  const claudeOptions: ReadonlyArray<ProviderApprovalOption> = [
    {
      optionId: "deny:0",
      decision: "decline",
      label: "Decline",
      scope: "once",
      effect: "deny",
      acceptsFeedback: true,
    },
    {
      optionId: "deny-stop:0",
      decision: "cancel",
      label: "Decline and stop",
      scope: "once",
      effect: "deny_and_stop",
      acceptsFeedback: true,
    },
    { optionId: "once:0", decision: "accept", label: "Allow once", scope: "once", effect: "allow" },
    {
      optionId: "session:0",
      decision: "acceptForSession",
      label: "Allow for this session",
      detail: "Adds /tmp/out to the allowed folders for this session",
      scope: "session",
      effect: "allow",
    },
    {
      optionId: "persistent:0",
      decision: "acceptAlways",
      label: "Always allow in this project",
      rulePreview: ["Bash(npm test:*)"],
      warning: "Saves these rules in this project's .claude/settings.local.json.",
      scope: "persistent",
      effect: "allow",
      persistsTo: "claude-local-settings",
    },
  ];

  it("offers only the server's options, deny and the narrowest allow as buttons, the rest by lifetime", () => {
    const choices = presentApprovalChoices(claudeOptions, {
      canRemember: true,
      persistent: "offer",
    });
    // Claude's labels already name the lifetime, so only the saved choice carries a tag.
    expect(choices.map((choice) => [choice.key, choice.placement, choice.lifetimeTag])).toEqual([
      ["deny:0", "primary", undefined],
      ["once:0", "primary", undefined],
      ["session:0", "more", undefined],
      ["persistent:0", "more", "Saved"],
      ["deny-stop:0", "more", undefined],
    ]);
    expect(choices[2]).toMatchObject({
      detail: "Adds /tmp/out to the allowed folders for this session",
      lifetimeText: "Applies until this provider session ends; nothing is saved.",
    });
    // The server's warning names the exact file, so it is the saved choice's one location line.
    expect(choices[3]).toMatchObject({
      rulePreview: ["Bash(npm test:*)"],
      lifetimeText: "Saves these rules in this project's .claude/settings.local.json.",
      warning: "Saves these rules in this project's .claude/settings.local.json.",
    });
    expect(choices[3]?.disabledReason).toBeUndefined();
  });

  it("tags a choice's lifetime only where its label doesn't already say it", () => {
    const choices = presentApprovalChoices(
      [
        { decision: "decline", label: "No" },
        { decision: "accept", label: "Yes" },
        { decision: "acceptForSession", label: "Yes, and don't ask again" },
        { decision: "accept", label: "Grant", scope: "turn" },
        { decision: "cancel", label: "Cancel" },
        { decision: "cancel", label: "Deny and stop" },
        {
          decision: "acceptAlways",
          label: "Always allow",
          rulePreview: ["Bash(npm test:*)"],
        },
      ],
      { canRemember: true, persistent: "offer" },
    );
    expect(choices.map((choice) => [choice.label, choice.lifetimeTag])).toEqual([
      ["No", undefined],
      ["Yes", "Once"],
      ["Grant", "This turn"],
      ["Yes, and don't ask again", "This session"],
      ["Always allow", "Saved"],
      ["Cancel", "Deny and stop"],
      ["Deny and stop", undefined],
    ]);
  });

  it("states where a saved choice is kept once, from the server's warning when it sends one", () => {
    const saved = (warning?: string) =>
      presentApprovalChoices(
        [
          {
            optionId: "persistent:0",
            decision: "acceptAlways",
            label: "Always allow (Codex, every project)",
            rulePreview: ['prefix_rule(pattern=["touch"], decision="allow")'],
            persistsTo: "codex-rules",
            ...(warning === undefined ? {} : { warning }),
          },
        ],
        { canRemember: true, persistent: "offer" },
      )[0];
    const warning =
      "Matching commands run outside the sandbox without prompting. This rule applies to every project using this Codex home.";
    expect(saved(warning)).toMatchObject({ lifetimeText: warning, warning });
    expect(saved()?.lifetimeText).toBe("Saved in Codex rules for every project.");
    expect(saved()?.warning).toBeUndefined();
  });

  it("disables a saved choice without the settings permission and hides one without a rule preview", () => {
    const withoutGrant = presentApprovalChoices(claudeOptions, {
      canRemember: false,
      persistent: "offer",
    });
    expect(withoutGrant.find((choice) => choice.optionClass === "persistent")?.disabledReason).toBe(
      "Needs settings permission",
    );
    const noPreview = presentApprovalChoices(
      [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptAlways", label: "Always allow" },
      ],
      { canRemember: true, persistent: "offer" },
    );
    expect(noPreview.map((choice) => choice.decision)).toEqual(["accept"]);
    const mobile = presentApprovalChoices(claudeOptions, { canRemember: true, persistent: "omit" });
    expect(mobile.some((choice) => choice.optionClass === "persistent")).toBe(false);
  });

  it("makes a turn grant the primary allow when nothing narrower is offered", () => {
    const choices = presentApprovalChoices(
      [
        { decision: "accept", label: "Grant for this turn", scope: "turn" },
        { decision: "acceptForSession", label: "Grant for the session" },
        { decision: "decline", label: "Deny" },
      ],
      { canRemember: false, persistent: "offer" },
    );
    expect(choices.map((choice) => [choice.label, choice.placement, choice.lifetimeTag])).toEqual([
      ["Deny", "primary", undefined],
      ["Grant for this turn", "primary", undefined],
      ["Grant for the session", "more", undefined],
    ]);
  });

  it("promotes the narrowest allow offered, a session grant when nothing shorter is, never a saved rule", () => {
    const deny = {
      optionId: "deny:0",
      decision: "decline",
      label: "Deny",
      effect: "deny",
    } as const;
    const session = {
      optionId: "session:0",
      decision: "acceptForSession",
      label: "Allow for this session",
      scope: "session",
      effect: "allow",
    } as const;
    const turn = {
      optionId: "turn:0",
      decision: "accept",
      label: "Grant for this turn",
      scope: "turn",
      effect: "allow",
    } as const;
    const saved = {
      optionId: "persistent:0",
      decision: "acceptAlways",
      label: "Always allow in this project",
      rulePreview: ["Bash(npm test:*)"],
      scope: "persistent",
      effect: "allow",
      persistsTo: "claude-local-settings",
    } as const;
    const primary = (
      options: ReadonlyArray<ProviderApprovalOption>,
      input: Parameters<typeof presentApprovalChoices>[1] = {
        canRemember: true,
        persistent: "offer",
      },
    ) =>
      presentApprovalChoices(options, input)
        .filter((choice) => choice.placement === "primary")
        .map((choice) => choice.key);
    expect(primary([saved, session, deny])).toEqual(["deny:0", "session:0"]);
    expect(primary([session, turn, deny])).toEqual(["deny:0", "turn:0"]);
    expect(primary([saved, deny])).toEqual(["deny:0"]);
    // Mobile, which leaves saved rules out, gets the same session button.
    expect(primary([saved, session, deny], { canRemember: false, persistent: "omit" })).toEqual([
      "deny:0",
      "session:0",
    ]);
    // The saved choice keeps its exact rule and still needs the settings grant.
    expect(
      presentApprovalChoices([saved, session, deny], {
        canRemember: false,
        persistent: "offer",
      }).find((choice) => choice.key === "persistent:0"),
    ).toMatchObject({
      placement: "more",
      rulePreview: ["Bash(npm test:*)"],
      disabledReason: "Needs settings permission",
    });
  });

  it("says an explicitly empty list offers no choices, which no answer can satisfy", () => {
    expect(approvalOffersNoChoices([])).toBe(true);
    expect(approvalOffersNoChoices(undefined)).toBe(false);
    expect(approvalOffersNoChoices([{ decision: "accept", label: "Allow once" }])).toBe(false);
    expect(APPROVAL_NO_CHOICES).toEqual({
      title: "No choices offered",
      detail:
        "The agent offered no choices for this request, so it can't be answered. It closes when the agent stops waiting.",
    });
  });

  it("falls back to the legacy decisions only when the server sends no list", () => {
    expect(
      presentApprovalChoices(undefined, { canRemember: true, persistent: "offer" }).map(
        (choice) => choice.label,
      ),
    ).toEqual(["Decline", "Allow once", "Allow for this session", "Decline and stop"]);
    expect(presentApprovalChoices([], { canRemember: true, persistent: "offer" })).toEqual([]);
  });

  it("offers Codex's listed choices, saved network rules included, and takes no reasons", () => {
    // What the Codex adapter offers for a command with network amendments
    // (CodexApprovalOptions.codexApprovalOptionsForClients), in Codex's order.
    const codexOptions: ReadonlyArray<ProviderApprovalOption> = [
      {
        optionId: "once:0",
        decision: "accept",
        label: "Allow once",
        scope: "once",
        effect: "allow",
        acceptsFeedback: false,
      },
      {
        optionId: "persistent:0",
        decision: "acceptAlways",
        label: "Always allow example.com",
        rulePreview: ['network_policy_amendment(host="example.com", action="allow")'],
        scope: "persistent",
        effect: "allow",
        persistsTo: "codex-network-rules",
        acceptsFeedback: false,
      },
      {
        optionId: "persistent:1",
        decision: "decline",
        label: "Always block example.com",
        rulePreview: ['network_policy_amendment(host="example.com", action="deny")'],
        scope: "persistent",
        effect: "deny",
        persistsTo: "codex-network-rules",
        acceptsFeedback: false,
      },
      {
        optionId: "deny:0",
        decision: "decline",
        label: "Deny",
        effect: "deny",
        acceptsFeedback: false,
      },
      {
        optionId: "deny-stop:0",
        decision: "cancel",
        label: "Deny and stop",
        effect: "deny_and_stop",
        acceptsFeedback: false,
      },
    ];
    const choices = presentApprovalChoices(codexOptions, {
      canRemember: true,
      persistent: "offer",
    });
    expect(choices.map((choice) => [choice.key, choice.placement])).toEqual([
      ["deny:0", "primary"],
      ["once:0", "primary"],
      ["persistent:0", "more"],
      ["persistent:1", "more"],
      ["deny-stop:0", "more"],
    ]);
    expect(choices.some((choice) => choice.acceptsFeedback)).toBe(false);
    const block = choices.find((choice) => choice.key === "persistent:1")!;
    expect(block.lifetimeText).toBe("Saved in Codex network rules for every project.");
    // The saved block rule answers by its id, never as the plain Deny that shares its decision.
    expect(approvalChoiceResponse(block, "ignored")).toEqual({ optionId: "persistent:1" });
    expect(
      approvalRecord({
        kind: "command",
        status: "resolved",
        chosen: {
          optionId: "persistent:1",
          decision: "decline",
          scope: "persistent",
          effect: "deny",
          persistsTo: "codex-network-rules",
        },
        delivery: delivery("delivered"),
      }).label,
    ).toBe("Always blocked");
  });

  it("puts Deny and stop on the card when Codex lists no plain deny", () => {
    const choices = presentApprovalChoices(
      [
        { optionId: "once:0", decision: "accept", label: "Allow once", effect: "allow" },
        {
          optionId: "deny-stop:0",
          decision: "cancel",
          label: "Deny and stop",
          effect: "deny_and_stop",
        },
      ],
      { canRemember: true, persistent: "offer" },
    );
    expect(choices.map((choice) => [choice.key, choice.placement])).toEqual([
      ["deny-stop:0", "primary"],
      ["once:0", "primary"],
    ]);
  });

  it("reads the class from the server id before the decision", () => {
    expect(approvalChoiceClass({ optionId: "turn:2", decision: "accept", label: "x" })).toBe(
      "turn",
    );
    expect(approvalChoiceClass({ optionId: "bogus:2", decision: "cancel", label: "x" })).toBe(
      "deny-stop",
    );
    expect(approvalChoiceClass({ decision: "decline", label: "x", effect: "deny_and_stop" })).toBe(
      "deny-stop",
    );
  });

  it("sends the option id and a bounded reason only where the option takes feedback", () => {
    const [deny, allow] = presentApprovalChoices(claudeOptions, {
      canRemember: true,
      persistent: "offer",
    });
    expect(approvalChoiceResponse(deny!, "  wrong folder  ")).toEqual({
      optionId: "deny:0",
      feedback: "wrong folder",
    });
    expect(approvalChoiceResponse(deny!, "x".repeat(2_100)).feedback).toHaveLength(2_000);
    expect(approvalChoiceResponse(deny!, "   ")).toEqual({ optionId: "deny:0" });
    expect(approvalChoiceResponse(allow!, "ignored")).toEqual({ optionId: "once:0" });
  });
});

describe("runtime mode choices", () => {
  it("disables every mode above the narrowest without the settings permission", () => {
    expect(runtimeModeDisabledReason("approval-required", false)).toBeUndefined();
    for (const mode of ["auto-accept-edits", "auto", "full-access"] as const) {
      expect(runtimeModeDisabledReason(mode, false)).toBe("Needs settings permission");
      expect(runtimeModeDisabledReason(mode, true)).toBeUndefined();
    }
  });
});

describe("approval scope", () => {
  it("lists who asked, the paths, the network host and where the app is configured", () => {
    expect(
      approvalScopeRows({
        agentId: "explorer-1",
        blockedPath: "/etc/hosts",
        network: { host: "registry.npmjs.org", protocol: "https" },
        requestedPermissions: { readPaths: ["/a", "/b"], writePaths: ["/c"], network: true },
        grantRoot: "/repo",
        mcpServerSource: { name: "github", source: "project" },
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Asked by subagent", "explorer-1"],
      ["Outside allowed folders", "/etc/hosts"],
      ["Network host", "https://registry.npmjs.org"],
      ["Read access", "/a\n/b"],
      ["Write access", "/c"],
      ["Network access", "Requested"],
      ["Grant covers", "/repo"],
      ["App", "github"],
      ["App configured in", "This project's settings"],
    ]);
    expect(approvalScopeRows(undefined)).toEqual([]);
  });

  it("says where an app comes from in plain words and hides a source it doesn't know", () => {
    const origin = (source: string) =>
      approvalScopeRows({ mcpServerSource: { name: "stark-code", source } }).find(
        (row) => row.label === "App configured in",
      );
    // Claude's MCP server sources (SDK `mcpServer.source`), an open set.
    expect(
      ["user", "project", "local", "dynamic", "sdk", "plugin", "managed", "enterprise"].map(
        (source) => origin(source)?.value,
      ),
    ).toEqual([
      "Your user settings",
      "This project's settings",
      "This project's local settings",
      "Stark Code",
      "Stark Code",
      "A plugin",
      "Managed settings",
      "Managed settings",
    ]);
    expect(origin("claudeai")).toMatchObject({ value: "Claude.ai connectors", code: false });
    expect(origin("agent")?.value).toBe("An agent definition");
    expect(origin("some-future-source")).toBeUndefined();
    expect(origin("~/.claude.json")).toBeUndefined();
  });

  it("names the subagent that asked, never its raw id when the server sends a name", () => {
    expect(
      approvalScopeRows({ agentId: "a98f6eb54b59f5b21", agentName: "general-purpose" })[0],
    ).toEqual({ label: "Asked by subagent", value: "general-purpose", code: false });
    // Older servers send only the id.
    expect(approvalScopeRows({ agentId: "a98f6eb54b59f5b21" })[0]).toEqual({
      label: "Asked by subagent",
      value: "a98f6eb54b59f5b21",
      code: true,
    });
  });

  it("keeps Codex's named paths as the server words them", () => {
    expect(
      approvalScopeRows({
        requestedPermissions: {
          readPaths: ["/ (the whole filesystem)", "src/**/*.ts (pattern)"],
          writePaths: ["$TMPDIR"],
        },
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Read access", "/ (the whole filesystem)\nsrc/**/*.ts (pattern)"],
      ["Write access", "$TMPDIR"],
    ]);
  });

  it("names a non-web network protocol instead of writing it as a URL", () => {
    expect(
      approvalScopeRows({ network: { host: "db.internal:5432", protocol: "socks5Tcp" } })[0]?.value,
    ).toBe("db.internal:5432 (SOCKS5 TCP)");
    expect(approvalScopeRows({ network: { host: "example.com" } })[0]?.value).toBe("example.com");
  });

  it("keeps only the scope fields an approval item carries", () => {
    expect(approvalRequestScope({})).toBeUndefined();
    expect(approvalRequestScope({ defaultToNo: false, grantRoot: "/repo" })).toEqual({
      defaultToNo: false,
      grantRoot: "/repo",
    });
  });
});

describe("delivery captions", () => {
  it("names each delivery state and never claims the action ran", () => {
    expect(
      (["pending", "delivered", "not_delivered", "uncertain", "not_needed"] as const).map((state) =>
        runtimeRequestDeliveryCaption(delivery(state), "Codex"),
      ),
    ).toEqual([
      { text: "Sending your answer to the agent…", tone: "neutral" },
      { text: "Delivered to the agent", tone: "neutral" },
      { text: "Answer not delivered: nothing ran", tone: "error" },
      { text: "Delivery uncertain: check whether it ran", tone: "warning" },
      { text: "Closed by Codex before your answer arrived", tone: "neutral" },
    ]);
    expect(runtimeRequestDeliveryCaption(undefined)).toBeNull();
  });
});

describe("approval records", () => {
  const base = { kind: "command" as const };
  const allowOnce = {
    optionId: "once:0",
    decision: "accept" as const,
    scope: "once" as const,
    effect: "allow" as const,
  };

  it("marks success only for an allow the agent received", () => {
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery("delivered"),
      }),
    ).toEqual({ label: "Allowed once", tone: "success", success: true });
  });

  it("names an answer the agent has not confirmed as selected, never as done", () => {
    // The label is what the timeline shows inline; the detail is only a tooltip.
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery("pending"),
      }),
    ).toEqual({
      label: "Allow once selected · sending…",
      detail: "Sending to the agent…",
      tone: "neutral",
      success: false,
    });
    // Older servers record the choice and never confirm delivery.
    expect(approvalRecord({ ...base, status: "resolved", decision: "accept" })).toEqual({
      label: "Allow once selected",
      detail: "Delivery to the agent was not recorded.",
      tone: "neutral",
      success: false,
    });
    for (const state of ["pending", "not_delivered", "uncertain"] as const) {
      const record = approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery(state),
      });
      expect(record.label).not.toMatch(/^Allowed/);
      expect(record.detail ?? "").not.toMatch(/Allowed/);
      expect(record.success).toBe(false);
    }
  });

  it("lets a settled delivery outrank loss history, and a loss speak only while delivery is open", () => {
    const uncertainLoss = { cause: "delivery_failed", deliveryUncertain: true } as const;
    // A loss the user dismissed stays on the request as history after delivery is confirmed.
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery("delivered"),
        lost: uncertainLoss,
      }),
    ).toEqual({ label: "Allowed once", tone: "success", success: true });
    expect(
      approvalRecord(
        {
          ...base,
          status: "resolved",
          chosen: allowOnce,
          delivery: delivery("not_needed"),
          lost: { cause: "provider_exit" },
        },
        "Codex",
      ),
    ).toMatchObject({ label: "Closed by Codex before your answer arrived", tone: "neutral" });
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery("not_delivered"),
        lost: uncertainLoss,
      }),
    ).toMatchObject({ label: "Answer not delivered", tone: "error" });
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery("pending"),
        lost: uncertainLoss,
      }),
    ).toMatchObject({ label: "Delivery uncertain", tone: "warning" });
    expect(
      [
        { delivery: delivery("delivered"), lost: uncertainLoss },
        { delivery: delivery("not_needed"), lost: { cause: "delivery_failed" } as const },
        { delivery: delivery("not_delivered"), lost: uncertainLoss },
        { delivery: delivery("pending"), lost: uncertainLoss },
        { delivery: delivery("pending"), lost: { cause: "delivery_failed" } as const },
        { delivery: delivery("uncertain") },
        { lost: { cause: "server_restart", deliveryUncertain: true } as const },
        { lost: { cause: "server_restart" } as const },
        { delivery: delivery("pending") },
        {},
      ].map(approvalDeliveryIssue),
    ).toEqual([
      null,
      null,
      "not_delivered",
      "uncertain",
      "not_delivered",
      "uncertain",
      "uncertain",
      null,
      null,
      null,
    ]);
  });

  it("puts a failed or uncertain delivery ahead of the choice", () => {
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery("not_delivered"),
      }),
    ).toEqual({
      label: "Answer not delivered",
      detail: "You chose Allow once. Nothing ran.",
      tone: "error",
      success: false,
    });
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: allowOnce,
        delivery: delivery("uncertain"),
      }),
    ).toMatchObject({ label: "Delivery uncertain", tone: "warning", success: false });
    expect(
      approvalRecord(
        { ...base, status: "resolved", chosen: allowOnce, delivery: delivery("not_needed") },
        "Codex",
      ),
    ).toMatchObject({ label: "Closed by Codex before your answer arrived", success: false });
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        decision: "accept",
        lost: { cause: "delivery_failed", deliveryUncertain: true },
      }),
    ).toMatchObject({ label: "Delivery uncertain", tone: "warning" });
    expect(
      approvalRecord({
        ...base,
        status: "resolved",
        decision: "accept",
        lost: { cause: "delivery_failed" },
      }),
    ).toMatchObject({ label: "Answer not delivered", tone: "error" });
  });

  it("labels every decision and closed state", () => {
    const labels = [
      approvalRecord({ ...base, status: "pending" }),
      approvalRecord({ ...base, status: "resolved", decision: "acceptForSession" }),
      approvalRecord({ ...base, status: "resolved", decision: "acceptAlways" }),
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: { optionId: "turn:1", decision: "accept", scope: "turn", effect: "allow" },
      }),
      approvalRecord({
        ...base,
        status: "resolved",
        chosen: {
          optionId: "deny:2",
          decision: "decline",
          scope: "once",
          effect: "deny",
          feedback: "Use the staging folder",
        },
        delivery: delivery("delivered"),
      }),
      approvalRecord({ ...base, status: "resolved", decision: "cancel" }),
      approvalRecord({ ...base, status: "expired" }),
      approvalRecord({ ...base, status: "cancelled" }),
      approvalRecord({ ...base, status: "expired", lost: { cause: "server_restart" } }),
      approvalRecord({ ...base, status: "expired", lost: { cause: "provider_exit" } }),
      // A choice recorded without scope or effect reads from its decision.
      approvalRecord({ ...base, status: "resolved", chosen: { decision: "acceptForSession" } }),
      ...(
        [
          { decision: "acceptForSession" },
          { decision: "acceptAlways" },
          { decision: "accept", scope: "turn", effect: "allow" },
          { decision: "cancel" },
          { decision: "decline", scope: "persistent", effect: "deny" },
        ] as const
      ).map((chosen) =>
        approvalRecord({ ...base, status: "resolved", chosen, delivery: delivery("delivered") }),
      ),
    ].map((record) => [record.label, record.detail ?? null, record.success]);
    const untracked = "Delivery to the agent was not recorded.";
    expect(labels).toEqual([
      ["Waiting for your decision", null, false],
      ["Allow for this session selected", untracked, false],
      ["Always allow selected", untracked, false],
      ["Allow for this turn selected", untracked, false],
      ["Declined", "Reason: Use the staging folder", false],
      ["Decline and stop selected", untracked, false],
      ["Expired", "The agent stopped waiting before you answered.", false],
      ["Cancelled", null, false],
      ["Approval lost: Stark Code restarted", null, false],
      ["Approval lost: the agent process stopped", null, false],
      ["Allow for this session selected", untracked, false],
      ["Allowed for this session", null, true],
      ["Always allowed", null, true],
      ["Allowed for this turn", null, true],
      ["Declined and stopped", null, false],
      ["Always blocked", null, false],
    ]);
  });
});

describe("approval prompt", () => {
  it("sets a hook's ask and the Pages reason apart from the agent's description", () => {
    expect(
      approvalPromptParts(
        "Asked by a hook\nStark Code cannot tell whether this command publishes to Stark Pages, which is available only in native Claude shell mode, so it needs your approval.",
      ),
    ).toEqual({
      askedByHook: true,
      pagesUncertain: true,
    });
    // The server puts the reason after Claude's own title.
    expect(
      approvalPromptParts(
        'Asked by a hook\nClaude wants to run spage "$sub" ./site\nStark Code cannot tell whether this command publishes to Stark Pages, which is available only in native Claude shell mode, so it needs your approval.',
      ),
    ).toEqual({
      askedByHook: true,
      pagesUncertain: true,
      text: 'Claude wants to run spage "$sub" ./site',
    });
    expect(approvalPromptParts("Asked by a hook\nRun spage on the site directory")).toEqual({
      askedByHook: true,
      pagesUncertain: false,
      text: "Run spage on the site directory",
    });
    expect(approvalPromptParts("Create build directory")).toEqual({
      askedByHook: false,
      pagesUncertain: false,
      text: "Create build directory",
    });
    expect(approvalPromptParts(undefined)).toEqual({ askedByHook: false, pagesUncertain: false });
    expect(STARK_PAGES_UNCERTAIN_NOTE).toBe(
      "May publish to Stark Pages, which is available only in native Claude shell mode, so it needs your approval each time.",
    );
  });
});

describe("approval headline", () => {
  it("names the kind of action instead of the raw request kind", () => {
    expect(
      (["command", "file-read", "file-change", "permission", "mcp-elicitation"] as const).map(
        approvalKindTitle,
      ),
    ).toEqual([
      "Command approval",
      "File read approval",
      "File change approval",
      "Permission request",
      "App access approval",
    ]);
  });
});
