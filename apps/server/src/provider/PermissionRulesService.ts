import {
  CodexSettings,
  type EffectivePermissionRow,
  type ProviderActivePermissionReport,
  type ProviderActivePermissionSettings,
  type EffectivePermissions,
  PermissionRulesError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ForgetPermissionRuleInput,
  type ReadEffectivePermissionsInput,
  type ReadPermissionRulesInput,
  type ReadPermissionRulesResult,
  type RuntimeMode,
  permissionSourceOf,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { starkAuthority } from "../orchestration-v2/PermissionContainment.ts";
import { freezeCapabilities } from "../orchestration-v2/PermissionFreeze.ts";
import {
  clampsToSupervised,
  requestedPermissionSettings,
} from "../orchestration-v2/PermissionPolicy.ts";
import { claudeModeLabel, readClaudeConfiguredPermissions } from "./ClaudeEffectivePermissions.ts";
import { readCodexConfiguredPermissions } from "./CodexEffectivePermissions.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { resolveCodexPermissionRulesHome } from "./PermissionRulesHome.ts";
import {
  makePermissionRuleFiles,
  type PermissionRuleFileDescriptor,
} from "./PermissionRuleFiles.ts";

const starkPolicy = (id: string, label: string, value: string): EffectivePermissionRow => ({
  id,
  kind: "stark-policy",
  label,
  value,
  origin: "stark-policy",
});

/**
 * Every boundary Stark keeps on top of the provider for a chat. Clients show
 * these rows instead of their own list whenever the server sends any, so the
 * list is complete for each driver.
 */
export function starkPolicyRows(input: {
  readonly driver: string;
  readonly thread: Parameters<typeof starkAuthority>[0];
  /** Claude: the account's Bypass opt-in. */
  readonly bypassAllowed: boolean;
}): ReadonlyArray<EffectivePermissionRow> {
  const claude = input.driver === "claudeAgent";
  const codex = input.driver === "codex";
  return [
    starkPolicy(
      "stark-tools",
      "Stark tools",
      starkAuthority(input.thread) === "environment" ? "Beyond this workspace" : "This workspace",
    ),
    ...(clampsToSupervised(input.driver)
      ? [starkPolicy("stark-supervised", "Stark preset", "Always Supervised in Stark Code")]
      : []),
    starkPolicy(
      "stark-child-bypass",
      "Child agents",
      claude ? "Never in Bypass" : "Stark workers never run in Bypass",
    ),
    ...(claude
      ? [
          starkPolicy(
            "stark-bypass-opt-in",
            "Bypass",
            input.bypassAllowed
              ? "Allowed for this account; choosing it for a chat asks again"
              : "Off for this account; enable Allow Bypass permissions in its settings",
          ),
        ]
      : []),
    starkPolicy(
      "stark-pages",
      "Stark Pages",
      claude
        ? "Publishing is off in Claude chats and a command that may publish asks first; use native shell mode to publish"
        : "A publish is never remembered as an allowed rule",
    ),
    starkPolicy(
      "stark-settings-write",
      "Settings permission",
      "Needed to widen a chat's permissions, save a scheduled task above Manual or save an answer as a rule",
    ),
    ...(claude
      ? [
          starkPolicy(
            "stark-saved-rules",
            "Always allow",
            "Saves only narrow rules, in this project's local Claude settings",
          ),
        ]
      : []),
    ...(codex
      ? [
          starkPolicy(
            "stark-codex-decisions",
            "Approval choices",
            "Only the decisions Codex offers",
          ),
          starkPolicy("stark-codex-auto-review", "Auto-review", "Never turned on by Stark Code"),
        ]
      : []),
  ];
}

/** No operation accepts a path or new rule text from a client. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const files = yield* makePermissionRuleFiles;
  const descriptors = Effect.fn("PermissionRulesService.descriptors")(function* (
    input: ReadPermissionRulesInput,
  ) {
    const projection = yield* threads.getThreadRecords(input.threadId, []);
    const project = Option.getOrNull(yield* projects.get(projection.thread.projectId));
    if (!project)
      return yield* Effect.fail(
        new PermissionRulesError({ message: "The thread's project is unavailable." }),
      );
    const configured = (yield* settings.getSettings).providerInstances;
    const cwd = path.resolve(
      projection.thread.worktreePath ??
        projection.thread.localSession?.cwd ??
        project.workspaceRoot,
    );
    const entries = Object.entries(configured);
    const claude =
      entries.find(
        ([id, instance]) =>
          id === projection.thread.providerInstanceId && instance.driver === "claudeAgent",
      ) ?? entries.find(([, instance]) => instance.driver === "claudeAgent");
    const result: PermissionRuleFileDescriptor[] = claude
      ? [
          {
            providerInstanceId: ProviderInstanceId.make(claude[0]),
            provider: "claudeAgent",
            scope: projection.thread.worktreePath ? "worktree" : "project",
            path: path.join(cwd, ".claude", "settings.local.json"),
            root: cwd,
          },
        ]
      : [];
    for (const [id, instance] of entries) {
      if (instance.driver !== "codex") continue;
      const config = yield* Schema.decodeUnknownEffect(CodexSettings)(instance.config ?? {});
      const rulesHome = yield* resolveCodexPermissionRulesHome(config, instance.environment, cwd);
      result.push({
        providerInstanceId: ProviderInstanceId.make(id),
        provider: "codex",
        scope: "user",
        root: rulesHome,
        path: path.join(rulesHome, "rules", "default.rules"),
        warning:
          "Codex allow rules run matching commands outside the sandbox without prompting, across every project using this home.",
      });
    }
    return result;
  });
  const mapError = (cause: unknown) =>
    Schema.is(PermissionRulesError)(cause)
      ? cause
      : new PermissionRulesError({
          message: "Could not read or update the provider's saved rules.",
          cause,
        });
  const read = (input: ReadPermissionRulesInput) =>
    Effect.gen(function* () {
      return {
        files: yield* Effect.forEach(yield* descriptors(input), (descriptor) =>
          files.read(descriptor),
        ),
      } satisfies ReadPermissionRulesResult;
    }).pipe(Effect.mapError(mapError));
  const forget = (input: ForgetPermissionRuleInput) =>
    Effect.gen(function* () {
      const descriptor = (yield* descriptors(input)).find(
        (file) => file.providerInstanceId === input.providerInstanceId,
      );
      if (!descriptor)
        return yield* Effect.fail(
          new PermissionRulesError({
            message: "This provider is no longer configured for this thread.",
          }),
        );
      yield* files.forget(descriptor, input.ruleId);
      yield* Effect.logInfo("Saved approval rule removed from thread settings").pipe(
        Effect.annotateLogs({
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId,
          scope: descriptor.scope,
        }),
      );
      return yield* read(input);
    }).pipe(Effect.mapError(mapError));
  /**
   * A chat's permissions as requested, as the provider last reported them for
   * its live session, and as its configuration would resolve them, plus the
   * rules Stark keeps on top. A value nobody reported is shown as unknown.
   */
  const readEffectivePermissions = (input: ReadEffectivePermissionsInput) =>
    Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(input.threadId, ["providerSessions"]);
      const thread = projection.thread;
      const project = Option.getOrNull(yield* projects.get(thread.projectId));
      const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
      const serverSettings = yield* settings.getSettings;
      const configuredInstances = serverSettings.providerInstances;
      const session = projection.providerSessions.findLast(
        (candidate) =>
          candidate.providerInstanceId === thread.providerInstanceId &&
          candidate.status !== "stopped" &&
          candidate.status !== "error",
      );
      const driver =
        session?.driver ??
        (Object.hasOwn(configuredInstances, thread.providerInstanceId)
          ? configuredInstances[thread.providerInstanceId]?.driver
          : undefined) ??
        ProviderDriverKind.make(thread.providerInstanceId);
      const requested = requestedPermissionSettings({
        driver,
        permissionSource: permissionSourceOf(thread),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      });
      const configured =
        driver === "claudeAgent"
          ? yield* readClaudeConfiguredPermissions({
              cwd,
              providerInstanceId: thread.providerInstanceId,
              providerSessionId: session?.id ?? null,
              instance: deriveProviderInstanceConfigMap(serverSettings)[thread.providerInstanceId],
            }).pipe(Effect.provideService(Path.Path, path))
          : driver === "codex"
            ? yield* readCodexConfiguredPermissions({
                cwd,
                providerInstanceId: thread.providerInstanceId,
                providerSessionId: session?.id ?? null,
              })
            : { configured: null, rows: [] };
      const active = session?.activePermissions ?? null;
      const rows: Array<EffectivePermissionRow> = [
        {
          id: "requested",
          kind: "requested",
          label: "Requested",
          value:
            requested.permissionSource === "inherit"
              ? "Provider's own settings"
              : `Set for this chat: ${presetLabel(thread.runtimeMode)}`,
          ...(requested.nativeMode === undefined ? {} : { nativeValue: requested.nativeMode }),
          origin: "chat",
        },
        activePermissionRow(driver, active),
        ...(configured.configured === null && configured.rows.length === 0
          ? [
              {
                id: "configured",
                kind: "configured" as const,
                label: "Configured for next launch",
                value: "Unknown: not reported by the provider",
                origin: "unknown" as const,
              },
            ]
          : // Stark's own rows come from starkPolicyRows, complete and once.
            configured.rows.filter((row) => row.kind !== "stark-policy")),
        ...starkPolicyRows({
          driver,
          thread,
          bypassAllowed:
            freezeCapabilities(
              deriveProviderInstanceConfigMap(serverSettings),
              thread.providerInstanceId,
            ).supportedRuntimeModes?.includes("full-access") === true,
        }),
      ];
      return {
        threadId: thread.id,
        providerInstanceId: thread.providerInstanceId,
        driver,
        cwd,
        providerSessionId: session?.id ?? null,
        requested,
        active,
        configured: configured.configured,
        rows,
      } satisfies EffectivePermissions;
    }).pipe(Effect.mapError(mapError));
  return { read, forget, readEffectivePermissions };
});

/** When the provider told Stark what the live session runs with, in the popover's words. */
const ACTIVE_REPORT_MOMENT: Record<ProviderActivePermissionReport, string> = {
  "session-init": "when the session started",
  "session-status": "in a session status update",
  "thread-start": "when the thread started",
  "thread-resume": "when the thread resumed",
  "thread-fork": "when the thread was forked",
  "settings-updated": "when its settings changed",
  "approved-session-update": "after an approved session change",
};

/**
 * The inspector's "Running now" row: what the provider last reported for the live session.
 * Claude's mode reads as the picker names it; Codex's approval policy stays in its own word and
 * its sandbox, reviewer and permission profile, when reported, are listed in the detail.
 */
export function activePermissionRow(
  driver: string,
  active: ProviderActivePermissionSettings | null,
): EffectivePermissionRow {
  if (active === null) {
    return {
      id: "active",
      kind: "active",
      label: "Running now",
      value: "Not reported yet",
      origin: "unknown",
    };
  }
  const reported = [
    ...(active.sandbox === undefined ? [] : [`Sandbox: ${active.sandbox}`]),
    ...(active.approvalsReviewer === undefined ? [] : [`Reviewer: ${active.approvalsReviewer}`]),
    ...(active.permissionProfile === undefined
      ? []
      : [`Permission profile: ${active.permissionProfile}`]),
  ];
  return {
    id: "active",
    kind: "active",
    label: "Running now",
    value:
      active.nativeMode === undefined
        ? "Reported"
        : driver === "claudeAgent"
          ? claudeModeLabel(active.nativeMode)
          : active.nativeMode,
    ...(active.nativeMode === undefined ? {} : { nativeValue: active.nativeMode }),
    origin: "provider-session",
    detail: [
      ...(reported.length === 0 ? [] : [`${reported.join(" · ")}.`]),
      `Reported by ${driver === "claudeAgent" ? "Claude" : driver === "codex" ? "Codex" : "the provider"} ${ACTIVE_REPORT_MOMENT[active.reportedBy]}.`,
    ].join(" "),
  };
}

function presetLabel(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "approval-required":
      return "Supervised";
    case "auto-accept-edits":
      return "Accept edits";
    case "auto":
      return "Auto";
    case "full-access":
      return "Full access";
  }
}
