import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  CommandId,
  MessageId,
  RuntimeRequestId,
  RESPONSE_VISUALS_MODEL,
  RESPONSE_VISUALS_VERSION,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
} from "@starkfuture/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

it.effect("refuses persistent approval without settings permission before the handler", () =>
  Effect.gen(function* () {
    const method = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(method, () =>
            Effect.sync(() => {
              handled = true;
              return { sequence: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationOperateScope]),
        ),
      ),
    );
    expect(
      yield* client[method]({
        type: "runtime-request.respond",
        commandId: CommandId.make("remember"),
        threadId: ThreadId.make("thread"),
        requestId: RuntimeRequestId.make("request"),
        decision: "acceptAlways",
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("requires operate access to stop a workflow", () => {
    expect(requiredScopeForRpcMethod(ORCHESTRATION_V2_WS_METHODS.stopWorkflow)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("requires read scope for idle-neutral session catalog and context inspection", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerReadSessionCatalog)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.providerReadContextUsage)).toBe(
      AuthOrchestrationReadScope,
    );
  });
  it("separates MCP status reads, reconnects, and provider administration", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.mcpServersList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.mcpServerReconnect)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.mcpServersReload)).toBe(
      AuthOrchestrationOperateScope,
    );
    for (const method of [
      WS_METHODS.mcpServerSetEnabled,
      WS_METHODS.mcpServerSignIn,
      WS_METHODS.mcpServerSubmitCallback,
      WS_METHODS.mcpServerSignOut,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthProvidersManageScope);
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsSyncConfigure)).toBe(
      AuthSettingsWriteScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsSyncStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthProvidersManageScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthProvidersManageScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("requires source control writes to start, retry, or cancel project clones", () => {
    for (const method of [
      WS_METHODS.projectCloneStart,
      WS_METHODS.projectCloneRetry,
      WS_METHODS.projectCloneCancel,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSourceControlWriteScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeProjectClones)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates viewing pull request file progress from writing it", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsFilesViewed)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsSetFilesViewed)).toBe(
      AuthSourceControlWriteScope,
    );
  });

  it("separates preview control from observation", () => {
    for (const method of [
      WS_METHODS.previewOpen,
      WS_METHODS.previewNavigate,
      WS_METHODS.previewResize,
      WS_METHODS.previewRefresh,
      WS_METHODS.previewClose,
      WS_METHODS.previewReportStatus,
      WS_METHODS.previewAdjust,
      WS_METHODS.previewClearProfile,
      WS_METHODS.previewReportProfiles,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthPreviewOperateScope);
    }
    for (const method of [
      WS_METHODS.previewList,
      WS_METHODS.subscribePreviewEvents,
      WS_METHODS.subscribeDiscoveredLocalServers,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
    {
      scopes: [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
      missing: AuthEnvironmentMaintainScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("human shell command authorization", () => {
  const method = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
    ),
  );
  const command = {
    type: "thread.shell-command.dispatch" as const,
    commandId: CommandId.make("shell-auth"),
    threadId: ThreadId.make("shell-auth"),
    messageId: MessageId.make("shell-auth"),
    createdBy: "user" as const,
    creationSource: "web" as const,
    command: "pwd",
    respond: false,
    dispatchMode: { type: "start_immediately" as const },
  };
  it.effect.each([
    { scopes: [AuthOrchestrationOperateScope], missing: AuthTerminalOperateScope },
    { scopes: [AuthTerminalOperateScope], missing: AuthOrchestrationOperateScope },
    { scopes: [AuthOrchestrationOperateScope, AuthTerminalOperateScope], missing: undefined },
  ] satisfies ReadonlyArray<{
    scopes: AuthEnvironmentScope[];
    missing: AuthEnvironmentScope | undefined;
  }>)("requires both scopes (missing=$missing)", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: string[] = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, (input) =>
              Effect.sync(() => {
                handled.push(input.type);
                return { sequence: 1 };
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      if (missing === undefined) {
        expect(yield* client[method](command)).toEqual({ sequence: 1 });
        expect(handled).toEqual([command.type]);
      } else {
        expect(yield* client[method](command).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: missing,
        });
        expect(handled).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("keeps normal text delivery under orchestration scope alone", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, () => Effect.succeed({ sequence: 1 })),
            RpcAuthorization.layer([AuthOrchestrationOperateScope]),
          ),
        ),
      );
      expect(
        yield* client[method]({
          ...command,
          type: "message.dispatch",
          text: "!pwd",
          attachments: [],
        }),
      ).toEqual({ sequence: 1 });
    }).pipe(Effect.scoped),
  );
});

it.effect("refuses reply generation to read-only clients before invoking the model service", () =>
  Effect.gen(function* () {
    const method = WS_METHODS.responseVisualsFormat;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(method, () =>
            Effect.sync(() => {
              handled = true;
              return {
                summary: null,
                table: null,
                mermaid: null,
                reason: "Nothing to add.",
                model: RESPONSE_VISUALS_MODEL,
                formatterVersion: RESPONSE_VISUALS_VERSION,
                cacheHit: false,
                generationUsage: null,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(
      yield* client[method]({
        threadId: ThreadId.make("visual-auth"),
        answer: "Private answer",
      }).pipe(Effect.flip),
    ).toMatchObject({
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect(handled).toBe(false);
    expect(requiredScopeForRpcMethod(WS_METHODS.terminalNativeReplies)).toBe(AuthTerminalReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.terminalNativeAttention)).toBe(
      AuthTerminalReadScope,
    );
  }).pipe(Effect.scoped),
);

it.effect.each([WS_METHODS.claudeAccountsSnapshot, WS_METHODS.claudeAccountsCommand] as const)(
  "requires provider administration before %s touches account credentials",
  (method) =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> =>
            tag !== WS_METHODS.claudeAccountsSnapshot && tag !== WS_METHODS.claudeAccountsCommand,
        ),
      );
      let handled = false;
      const handler = () =>
        Effect.sync(() => {
          handled = true;
          return {
            available: true,
            accounts: [],
            activeAccountNumber: null,
            automatic: { enabled: false, threshold: 90, lastOutcome: null },
            notice: null,
          };
        });
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.claudeAccountsSnapshot, handler),
            group.toLayerHandler(WS_METHODS.claudeAccountsCommand, handler),
            RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
          ),
        ),
      );
      const result =
        method === WS_METHODS.claudeAccountsSnapshot
          ? client[method]()
          : client[method]({ action: "automatic", enabled: true, threshold: 90 });
      expect(yield* result.pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthProvidersManageScope,
      });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
);

describe("local history sync authorization", () => {
  const grants = [
    { scopes: [AuthSettingsWriteScope], missing: AuthOrchestrationOperateScope },
    { scopes: [AuthOrchestrationOperateScope], missing: AuthSettingsWriteScope },
    { scopes: [AuthSettingsWriteScope, AuthOrchestrationOperateScope], missing: undefined },
  ] satisfies ReadonlyArray<{
    scopes: AuthEnvironmentScope[];
    missing: AuthEnvironmentScope | undefined;
  }>;

  it.effect.each(grants)(
    "requires both scopes for the dedicated sync RPC (missing=$missing)",
    ({ scopes, missing }) =>
      Effect.gen(function* () {
        const method = WS_METHODS.agentSessionsSyncConfigure;
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> =>
              tag !== method,
          ),
        );
        const handled: boolean[] = [];
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(method, (input) =>
                Effect.sync(() => {
                  handled.push(input.enabled);
                  return {
                    ...input,
                    running: false,
                    lastSyncedAt: null,
                    lastResult: null,
                    error: null,
                  };
                }),
              ),
              RpcAuthorization.layer(scopes),
            ),
          ),
        );
        for (const enabled of [true, false]) {
          const input = { enabled, projectId: ProjectId.make("work") };
          if (missing === undefined) {
            expect(yield* client[method](input)).toMatchObject(input);
          } else {
            expect(yield* client[method](input).pipe(Effect.flip)).toMatchObject({
              requiredPermission: missing,
            });
          }
        }
        expect(handled).toEqual(missing === undefined ? [true, false] : []);
      }).pipe(Effect.scoped),
  );

  it.effect.each(grants)(
    "cannot bypass sync permissions through a generic settings patch (missing=$missing)",
    ({ scopes, missing }) =>
      Effect.gen(function* () {
        const method = WS_METHODS.serverUpdateSettings;
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> =>
              tag !== method,
          ),
        );
        let handled = 0;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(method, () =>
                Effect.sync(() => {
                  handled++;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer(scopes),
            ),
          ),
        );
        for (const enabled of [true, false]) {
          const input = {
            patch: { localAgentHistory: { enabled, projectId: ProjectId.make("work") } },
          };
          if (missing === undefined) {
            yield* client[method](input);
          } else {
            expect(yield* client[method](input).pipe(Effect.flip)).toMatchObject({
              requiredPermission: missing,
            });
          }
        }
        expect(handled).toBe(missing === undefined ? 2 : 0);
      }).pipe(Effect.scoped),
  );
});
