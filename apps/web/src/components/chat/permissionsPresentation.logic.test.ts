import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type EffectivePermissions,
  type RuntimeMode,
} from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  composerPermissionProvider,
  currentEffectivePermissions,
  effectivePermissionsKey,
  effectivePermissionsFromThread,
  liveProviderSession,
  permissionApplyNotice,
  permissionPopoverRows,
  permissionSourceAction,
  permissionSourceChip,
  providerPermissionDefaultRows,
  runtimeModeNote,
  threadPermissionDisplay,
  starkPermissionPolicies,
} from "./permissionsPresentation.logic";
import { runtimeModeOptionsForProvider } from "./runtimeModeConfig";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const instance = ProviderInstanceId.make("claude");
const threadId = ThreadId.make("thread-1");

describe("permission controls during a provider handoff", () => {
  const codexId = ProviderInstanceId.make("codex");
  const claudeId = ProviderInstanceId.make("claude");
  const providers = [
    { instanceId: codexId, driver: codex },
    { instanceId: claudeId, driver: claude },
  ];
  const modes = (savedInstanceId: ProviderInstanceId | null) => {
    const provider = composerPermissionProvider({
      savedInstanceId,
      selectedInstanceId: claudeId,
      providers,
    });
    return runtimeModeOptionsForProvider(provider?.driver ?? "unknown").map(
      (option) => option.label,
    );
  };
  it("keeps a saved Codex chat's controls on Codex until the Claude handoff lands", () => {
    expect(modes(codexId)).toEqual(["Ask before actions"]);
    expect(modes(claudeId)).toContain("Bypass permissions");
  });
  it("lets a new chat choose the selected provider's permissions before its first send", () => {
    expect(modes(null)).toContain("Bypass permissions");
  });
  it("does not substitute a pending provider when the saved provider is unavailable", () => {
    expect(
      composerPermissionProvider({
        savedInstanceId: ProviderInstanceId.make("missing"),
        selectedInstanceId: claudeId,
        providers,
      }),
    ).toBeUndefined();
  });
});

const inherited: EffectivePermissions = {
  threadId,
  providerInstanceId: instance,
  driver: claude,
  cwd: "/repo",
  providerSessionId: null,
  requested: {
    permissionSource: "inherit",
    preset: "approval-required",
    interactionMode: "default",
  },
  active: {
    nativeMode: "acceptEdits",
    reportedBy: "session-init",
    reportedAt: "2026-10-30T12:00:00.000Z",
  },
  configured: { permissionSource: "inherit", nativeMode: "default" },
  rows: [
    {
      id: "requested",
      kind: "requested",
      label: "Requested",
      value: "Provider's own settings",
      origin: "chat",
    },
    {
      id: "active",
      kind: "active",
      label: "Running now",
      value: "Accept edits",
      nativeValue: "acceptEdits",
      origin: "provider-session",
      detail: "Reported by the provider (session-init) at 2026-10-30T12:00:00.000Z.",
    },
    {
      id: "mode",
      kind: "configured",
      label: "Mode for the next launch",
      value: "Manual",
      nativeValue: "default",
      origin: "user",
    },
    {
      id: "rules",
      kind: "configured",
      label: "Permission rules",
      value: "Unknown",
      origin: "unknown",
      detail: "Not reported by Claude SDK 0.3.276",
    },
    {
      id: "stark-child-bypass",
      kind: "stark-policy",
      label: "Child agents",
      value: "Never in Bypass",
      origin: "stark-policy",
    },
  ],
};

describe("the server's report for the chat as it is now", () => {
  const session = ProviderSessionId.make("session-1");
  const report: EffectivePermissions = { ...inherited, providerSessionId: session };
  const now = {
    threadId,
    providerInstanceId: instance,
    permissionSource: "inherit",
    runtimeMode: "approval-required",
    changePending: false,
    providerSessionId: session,
    activeReportedAt: "2026-10-30T12:00:00.000Z",
  } as const;

  it("shows a report only while it describes the chat's thread, source, preset and instance", () => {
    expect(currentEffectivePermissions(report, now)).toBe(report);
    expect(currentEffectivePermissions(null, now)).toBeNull();
    // Chat A, read while it inherited, changed to an override from another client.
    expect(
      currentEffectivePermissions(report, { ...now, permissionSource: "override" }),
    ).toBeNull();
    expect(
      currentEffectivePermissions(report, { ...now, runtimeMode: "auto-accept-edits" }),
    ).toBeNull();
    expect(
      currentEffectivePermissions(report, { ...now, threadId: ThreadId.make("thread-2") }),
    ).toBeNull();
    expect(
      currentEffectivePermissions(report, {
        ...now,
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    ).toBeNull();
  });

  it("drops a report from a session that has gone or reported again since", () => {
    // A change that waited on the run applied: the live session was detached.
    expect(currentEffectivePermissions(report, { ...now, providerSessionId: null })).toBeNull();
    expect(
      currentEffectivePermissions(report, {
        ...now,
        activeReportedAt: "2026-10-30T12:05:00.000Z",
      }),
    ).toBeNull();
    // Without a loaded projection the session is unknown, so it cannot rule a report out.
    expect(
      currentEffectivePermissions(report, {
        ...now,
        providerSessionId: undefined,
        activeReportedAt: undefined,
      }),
    ).toBe(report);
  });

  it("refreshes on any change of thread, source, preset, instance, pending change or session", () => {
    const key = effectivePermissionsKey(now);
    expect(effectivePermissionsKey({ ...now })).toBe(key);
    for (const change of [
      { threadId: ThreadId.make("thread-2") },
      { permissionSource: "override" },
      { runtimeMode: "auto-accept-edits" },
      { providerInstanceId: ProviderInstanceId.make("codex") },
      { changePending: true },
      { providerSessionId: null },
      { activeReportedAt: null },
    ] as const) {
      expect(effectivePermissionsKey({ ...now, ...change })).not.toBe(key);
    }
  });

  it("finds the live session the server reads, as the server picks it", () => {
    const sessions = [
      { id: "a", providerInstanceId: instance, status: "ready" },
      { id: "b", providerInstanceId: instance, status: "stopped" },
      { id: "c", providerInstanceId: ProviderInstanceId.make("codex"), status: "running" },
    ] as const;
    expect(liveProviderSession(sessions, instance)?.id).toBe("a");
    expect(liveProviderSession(sessions.slice(1, 2), instance)).toBeUndefined();
  });
});

describe("source chip", () => {
  it("says whether the provider's settings or this chat's preset decide", () => {
    expect(permissionSourceChip({ source: "inherit", driver: claude, preset: null })).toEqual({
      label: "Inherited",
      description: "Uses Claude's own permission settings",
    });
    expect(
      permissionSourceChip({ source: "override", driver: claude, preset: "approval-required" }),
    ).toEqual({ label: "Overridden", description: "Set for this chat: Manual" });
    expect(
      permissionSourceChip({ source: "override", driver: codex, preset: "approval-required" })
        .description,
    ).toBe("Set for this chat: Ask before actions");
  });
});

describe("popover rows", () => {
  it("shows the live report as effective, configuration as configured, and unknowns as unknown", () => {
    const rows = permissionPopoverRows(inherited);
    expect(
      rows.map((row) => [
        row.label,
        row.value,
        row.nativeValue ?? null,
        row.originLabel,
        row.detail ?? null,
      ]),
    ).toEqual([
      ["This chat asks for", "Claude's settings", null, "Inherited", null],
      [
        "Running now",
        "Accept edits",
        "acceptEdits",
        "Effective",
        "Reported by the provider (session-init) at 2026-10-30T12:00:00.000Z.",
      ],
      ["Mode for the next launch", "Manual", "default", "Configured", "From user settings"],
      ["Permission rules", "Unknown", null, "Unknown", "Not reported by Claude SDK 0.3.276"],
    ]);
  });

  it("shows a chat the server hasn't reported as its stored preset with unknown live settings", () => {
    const local = effectivePermissionsFromThread({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      driver: codex,
      permissionSource: "override",
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(
      permissionPopoverRows(local).map((row) => [row.label, row.value, row.originLabel]),
    ).toEqual([
      ["This chat asks for", "Ask before actions", "Overridden"],
      ["Running with", "Unknown", "Unknown"],
    ]);
    expect(permissionPopoverRows(local).some((row) => row.originLabel === "Effective")).toBe(false);
  });

  it("calls a value unknown only when the server reports none", () => {
    const rows = permissionPopoverRows({
      ...inherited,
      rows: [
        // What Claude's server rows send when no settings file sets a mode: a known default.
        {
          id: "configured",
          kind: "configured",
          label: "Configured mode",
          value: "Not set: Claude starts in Manual",
          nativeValue: "default",
          origin: "unknown",
          detail: "No settings file sets permissions.defaultMode.",
        },
        {
          id: "active-rules",
          kind: "active",
          label: "Session rules",
          value: "Unknown: Not reported by Claude SDK 0.3.276",
          origin: "unknown",
        },
        {
          id: "active",
          kind: "active",
          label: "Running now",
          value: "Not reported yet",
          origin: "unknown",
        },
      ],
    });
    expect(rows.slice(1).map((row) => [row.label, row.originLabel, row.detail ?? null])).toEqual([
      ["Configured mode", "Configured", "No settings file sets permissions.defaultMode."],
      ["Session rules", "Unknown", null],
      ["Running now", "Unknown", null],
    ]);
  });

  it("explains Codex's own word for the running approval policy without replacing it", () => {
    const rows = permissionPopoverRows({
      ...inherited,
      driver: codex,
      rows: [
        {
          id: "active",
          kind: "active",
          label: "Running now",
          value: "untrusted",
          nativeValue: "untrusted",
          origin: "provider-session",
          detail:
            "Sandbox: read-only · Reviewer: user. Reported by Codex when its settings changed.",
        },
      ],
    });
    expect(rows[1]).toMatchObject({
      value: "untrusted",
      valueHint:
        "untrusted is Codex's own name for its approval policy: it asks before commands it does not trust.",
    });
    // A value already in plain words needs no hint.
    expect(permissionPopoverRows(inherited)[1]?.valueHint).toBeUndefined();
  });
});

describe("requested versus active", () => {
  const override = (nativeMode: string): EffectivePermissions => ({
    ...inherited,
    requested: {
      permissionSource: "override",
      preset: "approval-required",
      interactionMode: "default",
      nativeMode,
    },
  });

  it("waits for a running turn instead of promising the next turn", () => {
    expect(
      permissionApplyNotice({
        permissions: override("default"),
        runActive: true,
        changePending: false,
      }),
    ).toEqual({ text: "Applies after this run stops", canStopAndApply: false });
    expect(
      permissionApplyNotice({
        permissions: override("default"),
        runActive: false,
        changePending: false,
      }),
    ).toEqual({ text: "Applies to the next message", canStopAndApply: false });
  });

  it("offers Stop and apply now only for a change waiting on the running turn", () => {
    expect(
      permissionApplyNotice({
        permissions: override("acceptEdits"),
        runActive: true,
        changePending: true,
      }),
    ).toEqual({ text: "Applies after this run stops", canStopAndApply: true });
    expect(
      permissionApplyNotice({
        permissions: override("acceptEdits"),
        runActive: false,
        changePending: true,
      }),
    ).toEqual({ text: "Applies after this run stops", canStopAndApply: false });
  });

  it("says what the session runs until a change waiting on the run applies", () => {
    expect(
      permissionApplyNotice({
        permissions: override("default"),
        runActive: true,
        changePending: true,
        running: { permissionSource: "override", runtimeMode: "auto-accept-edits" },
      }),
    ).toEqual({
      text: "Applies after this run stops",
      detail: "Until then it runs as Accept edits.",
      canStopAndApply: true,
    });
    expect(
      permissionApplyNotice({
        permissions: override("default"),
        runActive: true,
        changePending: true,
        running: { permissionSource: "inherit", runtimeMode: "approval-required" },
      })?.detail,
    ).toBe("Until then it runs with Claude's settings.");
    // A change recorded before the server reported this says nothing more.
    expect(
      permissionApplyNotice({
        permissions: override("default"),
        runActive: true,
        changePending: true,
      })?.detail,
    ).toBeUndefined();
  });

  it("tells the mode picker a change waits on the run, ahead of a saved-mode note", () => {
    const savedModeNote = "Saved as Bypass permissions, which is off; runs as Manual.";
    expect(runtimeModeNote({ changePending: true, savedModeNote })).toBe(
      "Applies after this run stops",
    );
    expect(runtimeModeNote({ changePending: false, savedModeNote })).toBe(savedModeNote);
    expect(runtimeModeNote({ changePending: false })).toBeUndefined();
  });

  it("says a change sent from here is being saved until its event comes back", () => {
    expect(
      permissionApplyNotice({
        permissions: inherited,
        runActive: false,
        changePending: false,
        saving: true,
      }),
    ).toEqual({
      text: "Saving this change…",
      canStopAndApply: false,
    });
    expect(runtimeModeNote({ changePending: false, saving: true })).toBe("Saving this change…");
  });

  it("says nothing when they match, the chat inherits, or nothing is reported", () => {
    const quiet = { runActive: true, changePending: false };
    expect(permissionApplyNotice({ permissions: inherited, ...quiet })).toBeNull();
    expect(permissionApplyNotice({ permissions: override("acceptEdits"), ...quiet })).toBeNull();
    expect(
      permissionApplyNotice({ permissions: { ...override("default"), active: null }, ...quiet }),
    ).toBeNull();
  });
});

describe("source actions", () => {
  const base = { driver: claude, canInherit: true, canWriteSettings: true, canChangeSource: true };

  it("offers Reset to inherited only where the server can inherit and the client may widen", () => {
    expect(permissionSourceAction({ ...base, source: "override" })).toEqual({
      label: "Reset to inherited",
      target: "inherit",
    });
    expect(
      permissionSourceAction({ ...base, source: "override", canWriteSettings: false })
        .disabledReason,
    ).toBe("Needs settings permission");
    expect(
      permissionSourceAction({ ...base, source: "override", canInherit: false }).disabledReason,
    ).toBe("This server can't use Claude's own settings yet");
  });

  it("offers Override for an inherited chat without the settings grant, even mid-run", () => {
    expect(
      permissionSourceAction({
        ...base,
        source: "inherit",
        canWriteSettings: false,
        runActive: true,
      }),
    ).toEqual({ label: "Override for this chat", target: "override" });
  });

  it("waits for the run to stop before switching to inherited", () => {
    expect(
      permissionSourceAction({ ...base, source: "override", runActive: true }).disabledReason,
    ).toBe("Available once this run stops");
  });
});

describe("Stark policies", () => {
  const serverPolicies = (ids: ReadonlyArray<[string, string, string]>) =>
    ids.map(([id, label, value]) => ({
      id,
      kind: "stark-policy" as const,
      label,
      value,
      origin: "stark-policy" as const,
    }));

  it("shows exactly the server's complete list, with nothing added from the client's", () => {
    const rows = serverPolicies([
      ["stark-tools", "Stark tools", "This workspace"],
      ["stark-child-bypass", "Child agents", "Never in Bypass"],
      ["stark-bypass-opt-in", "Bypass", "Off for this account"],
      ["stark-pages", "Stark Pages", "Publishing is off in Claude chats"],
      ["stark-settings-write", "Settings permission", "Needed to widen a chat's permissions"],
      ["stark-saved-rules", "Always allow", "Saves only narrow rules"],
    ]);
    expect(starkPermissionPolicies(claude, rows)).toEqual(
      rows.map((row) => ({ id: row.id, text: `${row.label}: ${row.value}` })),
    );
  });

  it("falls back to the same policies, in the server's words, only when the server sends none", () => {
    expect(starkPermissionPolicies(claude).map((policy) => policy.id)).toEqual([
      "stark-child-bypass",
      "stark-pages",
      "stark-settings-write",
      "stark-saved-rules",
    ]);
    expect(starkPermissionPolicies(claude).map((policy) => policy.text)).toContain(
      "Stark Pages: Publishing is off in Claude chats and a command that may publish asks first; use native shell mode to publish",
    );
    expect(starkPermissionPolicies(codex).map((policy) => policy.text)).toEqual([
      "Child agents: Stark workers never run in Bypass",
      "Stark Pages: A publish is never remembered as an allowed rule",
      "Settings permission: Needed to widen a chat's permissions, save a scheduled task above Manual or save an answer as a rule",
      "Approval choices: Only the decisions Codex offers",
      "Auto-review: Never turned on by Stark Code",
    ]);
    expect(
      starkPermissionPolicies(
        codex,
        inherited.rows.filter((row) => row.kind !== "stark-policy"),
      ).map((policy) => policy.id),
    ).toContain("stark-codex-auto-review");
  });
});

describe("new-chat defaults in Settings", () => {
  it("inherits Claude's settings only where the server supports it and keeps the terminal separate", () => {
    const rows = providerPermissionDefaultRows(
      [
        { instanceId: instance, driver: claude, nativePermissionInherit: true },
        {
          instanceId: ProviderInstanceId.make("claude_work"),
          driver: claude,
          displayName: "Claude work",
        },
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: codex,
          nativePermissionInherit: true,
        },
        {
          instanceId: ProviderInstanceId.make("codex_inherit"),
          driver: codex,
          nativePermissionInherit: true,
          newChatPermissionSource: "inherit",
        },
      ],
      "approval-required",
    );
    expect(rows.map((row) => [row.name, row.newChats])).toEqual([
      ["Claude", "Claude's own settings"],
      ["Claude work", "Stark preset: Manual"],
      ["Codex", "Stark preset: Ask before actions"],
      ["Codex", "Codex's own settings"],
    ]);
    expect(rows[1]?.newChatsDetail).toBe(
      "This server can't use Claude's own settings yet, so new chats use the Stark preset.",
    );
    expect(new Set(rows.map((row) => row.terminal)).size).toBe(1);
  });

  it("follows an instance's explicit setting over its driver's default", () => {
    const rows = providerPermissionDefaultRows(
      [
        {
          instanceId: instance,
          driver: claude,
          nativePermissionInherit: true,
          newChatPermissionSource: "override",
        },
      ],
      "auto-accept-edits",
    );
    expect(rows.map((row) => row.newChats)).toEqual(["Stark preset: Accept edits"]);
  });
});

describe("a permission change on its way to the server", () => {
  const thread = {
    threadId,
    permissionSource: "inherit",
    runtimeMode: "approval-required",
  } as const;
  const change = {
    threadId,
    permissionSource: "override",
    runtimeMode: "auto-accept-edits",
    before: { permissionSource: "inherit", runtimeMode: "approval-required" },
    acknowledged: false,
  } as const;

  it("shows the picked mode as an override, saving, never the stale Inherited", () => {
    expect(threadPermissionDisplay({ thread, change })).toEqual({
      permissionSource: "override",
      runtimeMode: "auto-accept-edits",
      saving: true,
    });
    // Acknowledged but its event hasn't reached this chat yet: still saving.
    expect(threadPermissionDisplay({ thread, change: { ...change, acknowledged: true } })).toEqual({
      permissionSource: "override",
      runtimeMode: "auto-accept-edits",
      saving: true,
    });
  });

  it("settles an acknowledged clamp back to the same Manual values", () => {
    const record = { permissionSource: "override", runtimeMode: "approval-required" } as const;
    const before = { threadId, ...record, record };
    const clamped = { ...before, record: { ...record } };
    const requested = {
      ...change,
      permissionSource: "override",
      runtimeMode: "full-access",
      before,
    } as const;
    const saving = { permissionSource: "override", runtimeMode: "full-access", saving: true };
    // A new record without the RPC acknowledgement can still be an earlier event.
    expect(threadPermissionDisplay({ thread: clamped, change: requested })).toEqual(saving);
    expect(
      threadPermissionDisplay({ thread: before, change: { ...requested, acknowledged: true } }),
    ).toEqual(saving);
    expect(
      threadPermissionDisplay({ thread: clamped, change: { ...requested, acknowledged: true } }),
    ).toEqual({
      permissionSource: "override",
      runtimeMode: "approval-required",
      saving: false,
    });
  });

  it("shows the chat as the server recorded it once the event lands", () => {
    const shown = (permissionSource: "inherit" | "override", runtimeMode: RuntimeMode) => ({
      permissionSource,
      runtimeMode,
      saving: false,
    });
    expect(
      threadPermissionDisplay({
        thread: { ...thread, permissionSource: "override", runtimeMode: "auto-accept-edits" },
        change,
      }),
    ).toEqual(shown("override", "auto-accept-edits"));
    // The server may record something else; once acknowledged, its record wins.
    expect(
      threadPermissionDisplay({
        thread: { ...thread, permissionSource: "override", runtimeMode: "approval-required" },
        change: { ...change, acknowledged: true },
      }),
    ).toEqual(shown("override", "approval-required"));
    expect(threadPermissionDisplay({ thread, change: null })).toEqual(
      shown("inherit", "approval-required"),
    );
    // A change for another chat says nothing about this one.
    expect(
      threadPermissionDisplay({ thread: { ...thread, threadId: ThreadId.make("other") }, change }),
    ).toEqual(shown("inherit", "approval-required"));
  });
});
