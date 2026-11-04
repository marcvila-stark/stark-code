import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { approvalOptionIdClass } from "./providerPolicy.ts";
import { WS_METHODS } from "./rpc.ts";

/**
 * Whether a dispatched command changes what a chat may do beyond the
 * narrowest preset, or answers an approval with a decision the provider
 * persists. Both need the settings-write scope (O12). The orchestrator checks
 * the same rules again against the thread it actually changes.
 */
export function dispatchNeedsSettingsWrite(command: unknown): boolean {
  if (typeof command !== "object" || command === null || !("type" in command)) return false;
  const fields = command as Record<string, unknown>;
  switch (fields.type) {
    case "runtime-request.respond":
      return (
        fields.decision === "acceptAlways" ||
        (typeof fields.optionId === "string" &&
          approvalOptionIdClass(fields.optionId) === "persistent")
      );
    case "thread.permission.set":
      return fields.permissionSource !== "override" || fields.runtimeMode !== "approval-required";
    case "thread.runtime-mode.set":
      return fields.runtimeMode !== "approval-required";
    default:
      return false;
  }
}

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.agentSessionsSyncConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.claudeAccountsSnapshot]: AuthProvidersManageScope,
  [WS_METHODS.claudeAccountsCommand]: AuthProvidersManageScope,
  [WS_METHODS.responseVisualsFormat]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitCheckChangesets]: AuthFilesystemReadScope,
  [WS_METHODS.mcpServerReconnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpServersReload]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpServerSetEnabled]: AuthProvidersManageScope,
  [WS_METHODS.mcpServerSignIn]: AuthProvidersManageScope,
  [WS_METHODS.mcpServerSubmitCallback]: AuthProvidersManageScope,
  [WS_METHODS.mcpServerSignOut]: AuthProvidersManageScope,
  [WS_METHODS.providerForgetPermissionRule]: AuthSettingsWriteScope,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [WS_METHODS.checkpointRestoreFiles]: AuthOrchestrationOperateScope,
  [WS_METHODS.checkpointUndoRestore]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Downloads a browser build onto the host, like installing a provider CLI.
  [WS_METHODS.serverInstallPreviewBrowser]: AuthProvidersManageScope,
  // Endpoint checks exist to configure exports, so they need the same grant as saving them.
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreadHistory]: AuthOrchestrationReadScope,
  // Import writes threads into the project from the CLI homes on that machine.
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  // Runs carry no prompt or request data, so reading them needs only the scope that lists tasks.
  [WS_METHODS.scheduledTasksListRuns]: AuthOrchestrationReadScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.agentSessionsSyncConfigure)
    return [AuthSettingsWriteScope, AuthOrchestrationOperateScope];
  if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && dispatchNeedsSettingsWrite(input))
    return [AuthOrchestrationOperateScope, AuthSettingsWriteScope];
  // A scheduled task runs unattended later, so saving one above the narrowest
  // preset widens what runs on this environment just as setting a chat does.
  // A task saved without a mode gets one from the project default, which only
  // the service can resolve, so ScheduledTaskService checks the stored mode
  // against the session's grant again.
  if (
    method === WS_METHODS.scheduledTasksUpsert &&
    typeof input === "object" &&
    input !== null &&
    "runtimeMode" in input &&
    input.runtimeMode !== undefined &&
    input.runtimeMode !== "approval-required"
  )
    return [AuthOrchestrationOperateScope, AuthSettingsWriteScope];
  if (
    method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand &&
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    input.type === "thread.shell-command.dispatch"
  )
    return [AuthOrchestrationOperateScope, AuthTerminalOperateScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
