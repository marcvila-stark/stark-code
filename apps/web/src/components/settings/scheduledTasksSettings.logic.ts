import {
  EnvironmentId,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskUpsertSchedule,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
} from "@starkfuture/contracts";
import { runtimeModeDisabledReason } from "@starkfuture/client-runtime/approvals/permission-presentation";
import { parseMaxDeliveryAge } from "@starkfuture/client-runtime/scheduled-task-webhook";
import { orderByAutomaticProviderPreference } from "@starkfuture/shared/model";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@starkfuture/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";

import type { ResolvedSettingsScope } from "./settingsScope";

/** Project IDs belong to an environment, including when a grouped project spans machines. */
export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export type ScheduleMode = "fixed" | "interval" | "webhook";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  /** Null sends no mode, so the server runs the project's default; a saved task keeps its own. */
  readonly runtimeMode: RuntimeMode | null;
  /** Not editable in the dialog, but preserved so editing an agent-created task keeps it. */
  readonly interactionMode: ProviderInteractionMode;
  /**
   * The task's original model selection. The picker only edits
   * `instanceId:model`; keeping the source object preserves provider options
   * (reasoning, temperature, …) when the model itself is left unchanged.
   */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  /** Minutes as typed; empty runs every held request regardless of age. */
  readonly maxDeliveryAgeMinutes: string;
}

/** GitHub's signature settings, the most common sender. */
export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Null when the draft's webhook age limit is invalid; the caller reports it and does not save. */
export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
      maxDeliveryAgeMinutes,
    };
  }
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode:
      schedule.type === "interval" ? "interval" : schedule.type === "webhook" ? "webhook" : "fixed",
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
  };
}

/** The mode a task saved without one runs: the project's default, as the server resolves it. */
export function scheduledTaskProjectRuntimeMode(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
): RuntimeMode {
  return resolveProjectSettings(settings, project?.id ?? null, project).settings.defaultRuntimeMode;
}

export const PROJECT_DEFAULT_MODE = "project-default";

export interface ScheduledTaskModeChoice {
  /** `PROJECT_DEFAULT_MODE` sends no mode, so the server runs the project's default. */
  readonly value: RuntimeMode | typeof PROJECT_DEFAULT_MODE;
  readonly label: string;
  /** Shown but not selectable, with the reason. */
  readonly disabledReason?: string;
}

/**
 * The editor's permission choices: the project's default first (the server picks it, so saving
 * needs no settings grant), then the provider's modes. Without the settings-write grant, modes
 * above the narrowest are disabled, since the server refuses to save them. A saved mode the
 * provider no longer offers stays listed so the editor shows what the task has.
 */
export function scheduledTaskModeChoices(input: {
  readonly options: ReadonlyArray<{ readonly mode: RuntimeMode; readonly label: string }>;
  readonly projectDefault: RuntimeMode;
  readonly selected: RuntimeMode | null;
  readonly canWriteSettings: boolean;
}): ReadonlyArray<ScheduledTaskModeChoice> {
  const labelOf = (mode: RuntimeMode) =>
    input.options.find((option) => option.mode === mode)?.label ?? runtimeModeConfig[mode].label;
  const modes = input.options.map((option) => option.mode);
  if (input.selected !== null && !modes.includes(input.selected)) modes.push(input.selected);
  return [
    { value: PROJECT_DEFAULT_MODE, label: `Project default · ${labelOf(input.projectDefault)}` },
    ...modes.map((mode) => {
      const disabledReason = runtimeModeDisabledReason(mode, input.canWriteSettings);
      return {
        value: mode,
        label: labelOf(mode),
        ...(disabledReason === undefined ? {} : { disabledReason }),
      };
    }),
  ];
}

/**
 * Use configured defaults before the catalog's advertised default model. With
 * nothing configured, the task starts on a ready provider, Claude first, like
 * a new thread does.
 */
export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection]) {
    if (
      selection &&
      available.some(
        (entry) =>
          entry.instanceId === selection.instanceId &&
          entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
      )
    )
      return selection;
  }
  const ranked = orderByAutomaticProviderPreference(available, (entry) => entry.driverKind);
  for (const entry of [
    ...ranked.filter((candidate) => candidate.status === "ready"),
    ...ranked.filter((candidate) => candidate.status !== "ready"),
  ]) {
    const models = entry.models.filter((model) => !model.isLegacy);
    const fallback = models.find((model) => model.isDefault) ?? models[0];
    if (fallback) return { instanceId: entry.instanceId, model: fallback.slug };
  }
  return null;
}
