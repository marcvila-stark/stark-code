import {
  newChatPermissionSourceFor,
  type EffectivePermissionOrigin,
  type EffectivePermissionRow,
  type EffectivePermissions,
  type PermissionSource,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@starkfuture/contracts";
import { runtimeModeConfig, runtimeModeOptionsForProvider } from "./runtimeModeConfig";

/** Saved-chat permission commands edit its current provider until the next send switches it. */
export function composerPermissionProvider<T extends Pick<ServerProvider, "instanceId">>(input: {
  readonly savedInstanceId: ProviderInstanceId | null;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<T>;
}): T | undefined {
  const instanceId = input.savedInstanceId ?? input.selectedInstanceId;
  return input.providers.find((provider) => provider.instanceId === instanceId);
}

/** The provider's own name in permission copy: "Claude's settings", "Codex's settings". */
export function permissionProviderName(driver: string, displayName?: string): string {
  if (driver === "claudeAgent") return "Claude";
  if (driver === "codex") return "Codex";
  return displayName ?? driver;
}

/** The preset's label as this provider's picker shows it, e.g. Claude "Manual". */
function permissionPresetLabel(driver: string, mode: RuntimeMode): string {
  return (
    runtimeModeOptionsForProvider(driver).find((option) => option.mode === mode)?.label ??
    runtimeModeConfig[mode].label
  );
}

export interface PermissionSourceChip {
  readonly label: "Inherited" | "Overridden";
  /** Accessible name and tooltip, e.g. "Set for this chat: Manual". */
  readonly description: string;
}

/** The chip beside the mode control: whether the provider's settings or this chat's preset decide. */
export function permissionSourceChip(input: {
  readonly source: PermissionSource;
  readonly driver: string;
  readonly preset: RuntimeMode | null | undefined;
  readonly providerDisplayName?: string;
}): PermissionSourceChip {
  const provider = permissionProviderName(input.driver, input.providerDisplayName);
  return input.source === "inherit"
    ? { label: "Inherited", description: `Uses ${provider}'s own permission settings` }
    : {
        label: "Overridden",
        description:
          input.preset == null
            ? "Set for this chat"
            : `Set for this chat: ${permissionPresetLabel(input.driver, input.preset)}`,
      };
}

/**
 * What the client knows before the server reports a chat's permissions, or from a server that
 * cannot: the chat's stored source and preset, and nothing about the live session.
 */
export function effectivePermissionsFromThread(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly permissionSource: PermissionSource;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): EffectivePermissions {
  return {
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    driver: input.driver,
    cwd: null,
    providerSessionId: null,
    requested: {
      permissionSource: input.permissionSource,
      preset: input.runtimeMode,
      interactionMode: input.interactionMode,
    },
    active: null,
    configured: null,
    rows: [],
  };
}

/**
 * The chat as the composer shows it now, which the server's effective-permissions report must
 * describe to be shown. The query is keyed only by thread, so its cached answer can belong to an
 * earlier state of the chat.
 */
export interface EffectivePermissionsExpectation {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly permissionSource: PermissionSource;
  readonly runtimeMode: RuntimeMode;
  /** The thread's `permissionChangePending`. */
  readonly changePending: boolean;
  /** The live provider session, as `liveProviderSession` finds it; undefined when unknown. */
  readonly providerSessionId?: string | null | undefined;
  /** When that session last reported its settings; undefined when unknown. */
  readonly activeReportedAt?: string | null | undefined;
}

/** The live session the server reads a chat's active settings from: the newest still running. */
export function liveProviderSession<
  Session extends {
    readonly providerInstanceId: ProviderInstanceId;
    readonly status: string;
  },
>(sessions: ReadonlyArray<Session>, providerInstanceId: ProviderInstanceId): Session | undefined {
  return sessions.findLast(
    (session) =>
      session.providerInstanceId === providerInstanceId &&
      session.status !== "stopped" &&
      session.status !== "error",
  );
}

/**
 * Changes whenever the report could: another chat, source, preset or provider instance, a change
 * starting or stopping waiting on the run, or a new or newly reported live session.
 */
export function effectivePermissionsKey(expected: EffectivePermissionsExpectation): string {
  return JSON.stringify([
    expected.threadId,
    expected.providerInstanceId,
    expected.permissionSource,
    expected.runtimeMode,
    expected.changePending,
    expected.providerSessionId === undefined ? "unknown" : expected.providerSessionId,
    expected.activeReportedAt === undefined ? "unknown" : expected.activeReportedAt,
  ]);
}

/**
 * The server's report when it describes the chat as it is now, else null so the chat's stored
 * settings stand in until a fresh one arrives. A report read for another chat, before a change of
 * source or preset (here or from another client), for another provider, or from a session that has
 * since gone or reported again is stale. A change waiting on the run shows up here too: queuing it
 * changes the requested preset, and applying it detaches the live session.
 */
export function currentEffectivePermissions(
  report: EffectivePermissions | null,
  expected: EffectivePermissionsExpectation,
): EffectivePermissions | null {
  if (
    report === null ||
    report.threadId !== expected.threadId ||
    report.providerInstanceId !== expected.providerInstanceId ||
    report.requested.permissionSource !== expected.permissionSource ||
    report.requested.preset !== expected.runtimeMode
  )
    return null;
  if (
    expected.providerSessionId !== undefined &&
    report.providerSessionId !== expected.providerSessionId
  )
    return null;
  if (
    expected.activeReportedAt !== undefined &&
    (report.active?.reportedAt ?? null) !== expected.activeReportedAt
  )
    return null;
  return report;
}

/** How a popover row's value is known. Only a live report may be called effective. */
export type PermissionRowOrigin = "requested" | "active" | "configured" | "unknown";

const PERMISSION_ORIGIN_LABEL: Record<Exclude<PermissionRowOrigin, "requested">, string> = {
  // Only a value the provider reported for the live session may be called effective.
  active: "Effective",
  configured: "Configured",
  unknown: "Unknown",
};

/** The settings layer a configured value came from, for the row's detail. */
const CONFIGURED_LAYER_LABEL: Partial<Record<EffectivePermissionOrigin, string>> = {
  managed: "managed settings",
  user: "user settings",
  project: "project settings",
  local: "local settings",
  "codex-config": "Codex config",
  requirements: "Codex requirements",
};

export interface PermissionPopoverRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly nativeValue?: string;
  /** What a value left in the provider's own word means, for its tooltip. */
  readonly valueHint?: string;
  readonly originLabel: string;
  readonly origin: PermissionRowOrigin;
  readonly detail?: string;
}

/**
 * Codex's approval policies, as the live session reports them. "Running now" keeps Codex's own
 * word (a documented choice, so it matches Codex's docs and logs); the hint says what it means.
 */
const CODEX_APPROVAL_POLICY_MEANING: Readonly<Record<string, string>> = {
  untrusted: "it asks before commands it does not trust",
  "on-request": "it asks when Codex decides it should",
  "on-failure": "it asks when a sandboxed command fails",
  never: "it never asks",
  granular: "it asks for the categories it lists",
};

function serverRow(row: EffectivePermissionRow, driver: string): PermissionPopoverRow {
  // The server marks a value with no settings layer behind it as unknown, even a known default
  // such as "Not set: Claude starts in Manual". Only a value it could not report is unknown.
  const reported = row.origin !== "unknown" || row.nativeValue !== undefined;
  const origin: Exclude<PermissionRowOrigin, "requested"> = !reported
    ? "unknown"
    : row.kind === "active"
      ? "active"
      : "configured";
  const layer = CONFIGURED_LAYER_LABEL[row.origin];
  const detail = row.detail ?? (origin === "configured" && layer ? `From ${layer}` : undefined);
  const meaning =
    driver === "codex" && row.kind === "active" && row.value === row.nativeValue
      ? CODEX_APPROVAL_POLICY_MEANING[row.value]
      : undefined;
  return {
    key: row.id,
    label: row.label,
    value: row.value,
    ...(row.nativeValue && row.nativeValue !== row.value ? { nativeValue: row.nativeValue } : {}),
    ...(meaning === undefined
      ? {}
      : { valueHint: `${row.value} is Codex's own name for its approval policy: ${meaning}.` }),
    origin,
    originLabel: PERMISSION_ORIGIN_LABEL[origin],
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * The popover's rows: what this chat asks for, in this provider's preset names, then the server's
 * rows for the live session and the provider's configuration. A configured value is never shown
 * as effective, and a live session nobody reported reads as unknown.
 */
export function permissionPopoverRows(
  permissions: EffectivePermissions,
  providerDisplayName?: string,
): ReadonlyArray<PermissionPopoverRow> {
  const provider = permissionProviderName(permissions.driver, providerDisplayName);
  const { requested } = permissions;
  const requestedRow: PermissionPopoverRow = {
    key: "requested",
    label: "This chat asks for",
    value:
      requested.permissionSource === "inherit" || requested.preset === undefined
        ? `${provider}'s settings`
        : permissionPresetLabel(permissions.driver, requested.preset),
    origin: "requested",
    originLabel: requested.permissionSource === "inherit" ? "Inherited" : "Overridden",
  };
  const rows = permissions.rows
    .filter((row) => row.kind === "active" || row.kind === "configured")
    .map((row) => serverRow(row, permissions.driver));
  if (!permissions.rows.some((row) => row.kind === "active")) {
    rows.unshift({
      key: "active",
      label: "Running with",
      value: "Unknown",
      origin: "unknown",
      originLabel: PERMISSION_ORIGIN_LABEL.unknown,
      detail: `${provider} hasn't reported the settings of a live session`,
    });
  }
  return [requestedRow, ...rows];
}

/** A narrowing chosen during a run, until the run stops: the thread's `permissionChangePending`. */
const PERMISSION_CHANGE_PENDING_TEXT = "Applies after this run stops";

/** A change this client sent whose event hasn't reached the chat yet. */
const PERMISSION_CHANGE_SAVING_TEXT = "Saving this change…";

/**
 * The mode picker's tooltip note: a change still on its way to the server, then a change waiting
 * on the running turn, since the picker already shows the new mode while the provider still runs
 * the old one, then why a saved mode the provider no longer offers shows as another.
 */
export function runtimeModeNote(input: {
  readonly changePending: boolean;
  readonly saving?: boolean | undefined;
  readonly savedModeNote?: string | undefined;
}): string | undefined {
  if (input.saving === true) return PERMISSION_CHANGE_SAVING_TEXT;
  return input.changePending ? PERMISSION_CHANGE_PENDING_TEXT : input.savedModeNote;
}

/** A saved chat's permission source and preset. */
export interface ThreadPermissionValues {
  readonly permissionSource: PermissionSource;
  readonly runtimeMode: RuntimeMode;
}

type ThreadPermissionSnapshot = ThreadPermissionValues & {
  /** Immutable authoritative record identity, including writes clamped to the old values. */
  readonly record?: object;
};

/**
 * A `thread.permission.set` this client sent for a chat: what it asked for, what the chat had when
 * it was sent, and whether the server acknowledged it.
 */
export interface PermissionChangeInFlight extends ThreadPermissionValues {
  readonly threadId: ThreadId;
  readonly before: ThreadPermissionSnapshot;
  readonly acknowledged: boolean;
}

/**
 * The chat's permission source and preset as the composer shows them: as the server recorded
 * them, except while a change sent from here hasn't come back as an event. Then the chip, popover
 * and picker show that change with a "Saving" note, never the stale values (an "Inherited" chip
 * beside a picker that already reads Accept edits). The change has landed when the record matches
 * it, or, once acknowledged, when the record moved at all (the server may store something else).
 */
export function threadPermissionDisplay(input: {
  readonly thread: ThreadPermissionSnapshot & { readonly threadId: ThreadId };
  readonly change: PermissionChangeInFlight | null;
}): ThreadPermissionValues & { readonly saving: boolean } {
  const { thread, change } = input;
  const recorded = (values: ThreadPermissionValues) => ({
    permissionSource: values.permissionSource,
    runtimeMode: values.runtimeMode,
    saving: false,
  });
  if (
    change === null ||
    change.threadId !== thread.threadId ||
    permissionChangeLanded(thread, change)
  )
    return recorded(thread);
  return {
    permissionSource: change.permissionSource,
    runtimeMode: change.runtimeMode,
    saving: true,
  };
}

/** Whether the chat's record shows the change: the values asked for, or any move once acknowledged. */
export function permissionChangeLanded(
  thread: ThreadPermissionSnapshot,
  change: PermissionChangeInFlight,
): boolean {
  const same = (left: ThreadPermissionValues, right: ThreadPermissionValues) =>
    left.permissionSource === right.permissionSource && left.runtimeMode === right.runtimeMode;
  const recordChanged =
    thread.record !== undefined &&
    change.before.record !== undefined &&
    thread.record !== change.before.record;
  return (
    same(thread, change) || (change.acknowledged && (recordChanged || !same(thread, change.before)))
  );
}

export interface PermissionApplyNotice {
  readonly text: string;
  /** What the live session keeps running until then, when the server says. */
  readonly detail?: string;
  /** Offer "Stop and apply now", which interrupts the run so the change takes effect. */
  readonly canStopAndApply: boolean;
}

/**
 * Requested versus active, honestly. A narrowing chosen during a run waits for the run to stop
 * (the thread's `permissionChangePending`), never "next turn", and Stop and apply now stops the run
 * so it applies sooner. A preset the live session doesn't report yet reaches the provider with the
 * next message.
 */
export function permissionApplyNotice(input: {
  readonly permissions: EffectivePermissions;
  readonly runActive: boolean;
  /** The thread's `permissionChangePending`: the change applies when the run stops. */
  readonly changePending: boolean;
  /** A change sent from here whose event hasn't reached the chat yet. */
  readonly saving?: boolean | undefined;
  /** `permissionChangePending.running`: what the session runs until the change applies. */
  readonly running?: ThreadPermissionValues | undefined;
  readonly providerDisplayName?: string | undefined;
}): PermissionApplyNotice | null {
  const { permissions, runActive } = input;
  if (input.saving === true) return { text: PERMISSION_CHANGE_SAVING_TEXT, canStopAndApply: false };
  if (input.changePending) {
    const running = input.running;
    return {
      text: PERMISSION_CHANGE_PENDING_TEXT,
      ...(running === undefined
        ? {}
        : {
            detail:
              running.permissionSource === "inherit"
                ? `Until then it runs with ${permissionProviderName(permissions.driver, input.providerDisplayName)}'s settings.`
                : `Until then it runs as ${permissionPresetLabel(permissions.driver, running.runtimeMode)}.`,
          }),
      canStopAndApply: runActive,
    };
  }
  const { active, requested } = permissions;
  if (
    active === null ||
    requested.permissionSource !== "override" ||
    requested.nativeMode === undefined ||
    active.nativeMode === undefined ||
    active.nativeMode === requested.nativeMode
  )
    return null;
  // Nothing waits on the run here: stopping it would not apply the change any sooner.
  return runActive
    ? { text: PERMISSION_CHANGE_PENDING_TEXT, canStopAndApply: false }
    : { text: "Applies to the next message", canStopAndApply: false };
}

/** A boundary Stark keeps whatever the provider allows. */
export interface StarkPermissionPolicy {
  readonly id: string;
  readonly text: string;
}

const policy = (id: string, label: string, value: string): StarkPermissionPolicy => ({
  id,
  text: `${label}: ${value}`,
});

// The server's own list (`starkPolicyRows`), in its words and ids, for servers that send none and
// for Settings, which has no chat to ask about. Rows that depend on the chat or the account (Stark
// tools, the Supervised clamp, the Bypass opt-in) come only from the server.
const CHILD_BYPASS_POLICY = (claude: boolean) =>
  policy(
    "stark-child-bypass",
    "Child agents",
    claude ? "Never in Bypass" : "Stark workers never run in Bypass",
  );
const SETTINGS_WRITE_POLICY = policy(
  "stark-settings-write",
  "Settings permission",
  "Needed to widen a chat's permissions, save a scheduled task above Manual or save an answer as a rule",
);

/**
 * Boundaries Stark keeps whatever the provider allows. The server sends its complete list as
 * `stark-policy` rows, which are shown as they are; this client's copy of the list is only a
 * fallback for older servers that send none.
 */
export function starkPermissionPolicies(
  driver: string,
  serverRows?: ReadonlyArray<EffectivePermissionRow>,
): ReadonlyArray<StarkPermissionPolicy> {
  const fromServer = (serverRows ?? []).flatMap((row) =>
    row.kind === "stark-policy" ? [policy(row.id, row.label, row.value)] : [],
  );
  if (fromServer.length > 0) return fromServer;
  if (driver === "claudeAgent")
    return [
      CHILD_BYPASS_POLICY(true),
      policy(
        "stark-pages",
        "Stark Pages",
        "Publishing is off in Claude chats and a command that may publish asks first; use native shell mode to publish",
      ),
      SETTINGS_WRITE_POLICY,
      policy(
        "stark-saved-rules",
        "Always allow",
        "Saves only narrow rules, in this project's local Claude settings",
      ),
    ];
  return [
    CHILD_BYPASS_POLICY(false),
    policy("stark-pages", "Stark Pages", "A publish is never remembered as an allowed rule"),
    SETTINGS_WRITE_POLICY,
    ...(driver === "codex"
      ? [
          policy("stark-codex-decisions", "Approval choices", "Only the decisions Codex offers"),
          policy("stark-codex-auto-review", "Auto-review", "Never turned on by Stark Code"),
        ]
      : []),
  ];
}

export interface PermissionSourceAction {
  readonly label: "Reset to inherited" | "Override for this chat";
  readonly target: PermissionSource;
  readonly disabledReason?: string;
}

/** The popover's way in and way out: Reset to inherited for an override, Override for inherit. */
export function permissionSourceAction(input: {
  readonly source: PermissionSource;
  readonly driver: string;
  /** The provider snapshot's `nativePermissionInherit`: the server can omit its settings. */
  readonly canInherit: boolean;
  readonly canWriteSettings: boolean;
  /** The host can send the change; false on a server without the permission command. */
  readonly canChangeSource: boolean;
  /** A turn is running; the server takes a switch to inherit only once it stops. */
  readonly runActive?: boolean;
  readonly providerDisplayName?: string;
}): PermissionSourceAction {
  const provider = permissionProviderName(input.driver, input.providerDisplayName);
  if (input.source === "inherit") {
    return {
      label: "Override for this chat",
      target: "override",
      ...(input.canChangeSource ? {} : { disabledReason: "This server can't change it yet" }),
    };
  }
  const disabledReason = !input.canInherit
    ? `This server can't use ${provider}'s own settings yet`
    : !input.canChangeSource
      ? "This server can't change it yet"
      : // Inheriting can widen access, so it needs the settings grant (O12).
        !input.canWriteSettings
        ? "Needs settings permission"
        : input.runActive === true
          ? "Available once this run stops"
          : undefined;
  return {
    label: "Reset to inherited",
    target: "inherit",
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
}

export interface ProviderPermissionDefaultRow {
  readonly providerInstanceId: ProviderInstanceId;
  readonly name: string;
  readonly newChats: string;
  readonly newChatsDetail: string;
  readonly terminal: string;
}

/**
 * Settings → Permissions, one row per provider instance: where new chats take their permissions
 * from (the instance's `newChatPermissionSource`, else Claude inherits and others override), and
 * that the native terminal keeps its own launch arguments.
 */
export function providerPermissionDefaultRows(
  instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly displayName?: string;
    readonly nativePermissionInherit?: boolean;
    readonly newChatPermissionSource?: PermissionSource;
  }>,
  defaultRuntimeMode: RuntimeMode,
): ReadonlyArray<ProviderPermissionDefaultRow> {
  return instances.map((instance) => {
    const provider = permissionProviderName(instance.driver, instance.displayName);
    const preset = `Stark preset: ${permissionPresetLabel(instance.driver, defaultRuntimeMode)}`;
    const wanted = newChatPermissionSourceFor(instance);
    const inherits = wanted === "inherit" && instance.nativePermissionInherit === true;
    return {
      providerInstanceId: instance.instanceId,
      name: instance.displayName ?? provider,
      newChats: inherits ? `${provider}'s own settings` : preset,
      newChatsDetail: inherits
        ? `Stark sends no permission mode, so ${provider}'s user, project, local and managed settings decide.`
        : wanted === "inherit"
          ? `This server can't use ${provider}'s own settings yet, so new chats use the Stark preset.`
          : "Stark sends this preset to each new chat. Change it per chat in the composer.",
      terminal: "Native terminal keeps its own launch arguments; this setting doesn't change it.",
    };
  });
}
