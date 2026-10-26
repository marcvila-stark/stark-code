import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
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
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.agentSessionsSyncConfigure)
    return [AuthSettingsWriteScope, AuthOrchestrationOperateScope];
  if (
    method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand &&
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    input.type === "runtime-request.respond" &&
    "decision" in input &&
    input.decision === "acceptAlways"
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
