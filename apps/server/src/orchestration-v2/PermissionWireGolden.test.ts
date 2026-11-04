/**
 * What Stark sends each provider for a saved chat, captured before
 * provider-native permissions changed anything. A legacy `thread.created`
 * event (no permission source) is decoded the way the projection reads it,
 * resolved through `RuntimePolicy`, routed through the session manager's own
 * `sessionRuntimePolicy`, and turned into the provider's wire:
 * - Claude: the SDK query options `makeClaudeQueryOptions` builds;
 * - Codex: the native `thread/start`, `thread/resume`, `thread/fork` and
 *   `turn/start` requests the real adapter sends, recorded by a fake
 *   app-server client;
 * - OpenCode: the session rules its adapter sends;
 * - Grok: the launch argv and the answer the real adapter flavor gives each
 *   kind of permission prompt.
 *
 * `GOLDEN` never changes. An intended difference is a row in
 * `PermissionApprovedChanges.ts`; anything else failing here is a silent change
 * to a saved chat's permissions.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StoredEventJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@starkfuture/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderInstance } from "@starkfuture/provider-core/server/driver";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@starkfuture/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@starkfuture/provider-core/server/ProviderAdapter";
import { GrokSettings } from "@starkfuture/provider-grok/settings";
import {
  grokAcpSpawnArgs,
  grokLaunchRuntimeMode,
  makeGrokAcpAdapterFlavor,
} from "@starkfuture/provider-grok/testing";
import { sessionRules } from "@starkfuture/provider-opencode/server/v2/adapter";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { nativeAgentLaunch } from "../terminal/NativeAgentLaunch.ts";
import {
  claudeRuntimeQueryPolicyForRuntimePolicy,
  makeClaudeQueryOptions,
} from "./Adapters/ClaudeAdapterV2.ts";
import { makeCodexAdapterV2 } from "./Adapters/CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./Adapters/CodexAdapterV2.testkit.ts";
import {
  PERMISSION_APPROVED_CHANGES,
  type PermissionGoldenProvider,
} from "./PermissionApprovedChanges.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { freezeCapabilities } from "./PermissionFreeze.ts";
import { permissionFreezeFor } from "./PermissionPolicy.ts";
import { sessionRuntimePolicy } from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:permission-golden");
const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const INTERACTION_MODES: ReadonlyArray<ProviderInteractionMode> = ["default", "plan"];

interface GoldenProviderCase {
  readonly provider: PermissionGoldenProvider;
  readonly instanceId: string;
  readonly driver: string;
  readonly model: string;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly allowBypassPermissions?: boolean;
  /** The driver lets a chat opt in to the provider's own settings (`inheritWire`). */
  readonly nativePermissionInherit?: boolean;
}

const PROVIDERS: ReadonlyArray<GoldenProviderCase> = [
  {
    provider: "claude-bypass-on",
    instanceId: "claude-bypass-on",
    driver: "claudeAgent",
    model: "claude-sonnet-4-6",
    supportedRuntimeModes: RUNTIME_MODES,
    allowBypassPermissions: true,
  },
  {
    provider: "claude-bypass-off",
    instanceId: "claude-bypass-off",
    driver: "claudeAgent",
    model: "claude-sonnet-4-6",
    supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto"],
    allowBypassPermissions: false,
  },
  // Codex advertises Supervised only, and a saved chat may opt in to Codex's
  // own settings (D2); the session manager's clamp decides every other mode.
  {
    provider: "codex",
    instanceId: "codex",
    driver: "codex",
    model: "gpt-5.5",
    supportedRuntimeModes: ["approval-required"],
    nativePermissionInherit: true,
  },
  {
    provider: "opencode",
    instanceId: "opencode",
    driver: "opencode",
    model: "opencode/default",
    supportedRuntimeModes: RUNTIME_MODES,
  },
  // GROK_SUPPORTED_RUNTIME_MODES: no Auto-accept edits.
  {
    provider: "grok",
    instanceId: "grok",
    driver: "grok",
    model: "grok-4",
    supportedRuntimeModes: ["approval-required", "auto", "full-access"],
  },
];

const providerByInstance = new Map(
  PROVIDERS.map((provider) => [ProviderInstanceId.make(provider.instanceId), provider]),
);

const runtimePolicyLayer = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed({
          snapshot: {
            getSnapshot: Effect.succeed({
              supportedRuntimeModes: providerByInstance.get(instanceId)?.supportedRuntimeModes,
              nativePermissionInherit: providerByInstance.get(instanceId)?.nativePermissionInherit,
            } as ServerProvider),
          },
        } as ProviderInstance),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

const decodeStoredEvent = Schema.decodeUnknownEffect(OrchestrationV2StoredEventJson);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

/** A `thread.created` event as servers before permission sources wrote it. */
function legacyThreadCreated(input: {
  readonly provider: GoldenProviderCase;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const threadId = `thread:golden:${input.provider.provider}:${input.runtimeMode}:${input.interactionMode}`;
  return {
    sequence: 1,
    commandId: null,
    event: {
      id: `event:${threadId}`,
      threadId,
      occurredAt: "2026-10-01T00:00:00.000Z",
      type: "thread.created",
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title: "Golden",
        providerInstanceId: input.provider.instanceId,
        modelSelection: { instanceId: input.provider.instanceId, model: input.provider.model },
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
      },
    },
  };
}

function claudeWire(
  provider: GoldenProviderCase,
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  modelSelection: ModelSelection,
) {
  const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(policy);
  const settings = decodeClaudeSettings({
    allowBypassPermissions: provider.allowBypassPermissions === true,
  });
  const options = makeClaudeQueryOptions({
    modelSelection,
    nativeThreadId: "golden",
    resume: false,
    cwd: policy.cwd,
    settings,
    ...(queryPolicy.tools === undefined ? {} : { tools: queryPolicy.tools }),
    ...(queryPolicy.allowedTools === undefined ? {} : { allowedTools: queryPolicy.allowedTools }),
    permissionMode: queryPolicy.permissionMode,
    ...(queryPolicy.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: queryPolicy.allowDangerouslySkipPermissions }),
    ...(queryPolicy.installPermissionCallback
      ? { canUseTool: async () => ({ behavior: "deny" as const, message: "golden" }) }
      : {}),
  });
  const querySettings =
    typeof options.settings === "object" && options.settings !== null ? options.settings : {};
  return {
    permissionMode: options.permissionMode ?? null,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? null,
    permissionCallback: options.canUseTool !== undefined,
    settingsPermissions: querySettings.permissions ?? null,
    disableAllHooks: querySettings.disableAllHooks ?? null,
    allowedTools: options.allowedTools ?? null,
    disallowedTools: options.disallowedTools ?? null,
    hooks: Object.entries(options.hooks ?? {}).map(
      ([event, matchers]) => `${event}:${matchers?.length ?? 0}`,
    ),
  };
}

/** One request the Codex adapter sent its app-server. */
interface CodexRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const CODEX_GOLDEN_THREAD = "codex-golden-thread";

/** The answers a Codex 0.163 app-server gives; only the fields the adapter reads. */
function codexAppServerResponse(method: string): unknown {
  const thread = {
    id: CODEX_GOLDEN_THREAD,
    sessionId: CODEX_GOLDEN_THREAD,
    forkedFromId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${CODEX_GOLDEN_THREAD}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.163.0",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
  const loaded = {
    thread,
    model: "gpt-5.5",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    instructionSources: [],
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly" },
    reasoningEffort: "medium",
  };
  switch (method) {
    case "initialize":
      return {
        userAgent: "Stark Code/0.163.0",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      };
    case "thread/start":
    case "thread/resume":
    case "thread/fork":
      return loaded;
    case "turn/start":
      return {
        turn: {
          id: "codex-golden-turn",
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          error: null,
          startedAt: 1782622440,
          completedAt: null,
          durationMs: null,
        },
      };
    case "skills/list":
      return { data: [] };
    default:
      return {};
  }
}

/** A Codex app-server client that records every request and answers it at once. */
function makeRecordingCodexClient(requests: Array<CodexRequest>) {
  const request = (method: string, params: unknown) =>
    Effect.sync(() => {
      requests.push({ method, params: (params ?? {}) as Record<string, unknown> });
      return codexAppServerResponse(method);
    });
  return {
    raw: {
      request,
      notify: () => Effect.void,
      respond: () => Effect.void,
      respondError: () => Effect.void,
      notifications: Stream.never,
      requests: Stream.never,
    },
    request,
    notify: () => Effect.void,
    handleServerRequest: () => Effect.void,
    handleServerNotification: () => Effect.void,
    handleUnknownServerRequest: () => Effect.void,
    handleUnknownServerNotification: () => Effect.void,
  } as unknown as CodexClient.CodexAppServerClient["Service"];
}

/** Request params that carry no permission: the thread, its turn boundary, folder and model. */
const CODEX_THREAD_PARAMS_WITHOUT_PERMISSIONS = new Set([
  "threadId",
  "excludeTurns",
  "lastTurnId",
  "cwd",
  "model",
  "config",
]);
/**
 * Thread config overrides that carry no permission, as Stark sent them at
 * 458bf2172d (CODEX_THREAD_CONFIG and the Stark MCP server). Listed, not
 * imported, so a config key added later shows up in the golden.
 */
const CODEX_THREAD_CONFIG_WITHOUT_PERMISSIONS = new Set([
  "tools.update_plan.enabled",
  "analytics.enabled",
  "otel.exporter",
  "otel.trace_exporter",
  "otel.metrics_exporter",
  "otel.log_user_prompt",
  "mcp_servers",
]);

/**
 * What a `thread/start`, `thread/resume` or `thread/fork` request sends besides
 * the thread, folder, model and the config above: every other param, and every
 * other config override (as `config.<key>`).
 */
function codexThreadPermissionParams(params: Record<string, unknown>): Record<string, unknown> {
  const config =
    typeof params.config === "object" && params.config !== null
      ? (params.config as Record<string, unknown>)
      : {};
  return Object.fromEntries([
    ...Object.entries(params).filter(([key]) => !CODEX_THREAD_PARAMS_WITHOUT_PERMISSIONS.has(key)),
    ...Object.entries(config)
      .filter(([key]) => !CODEX_THREAD_CONFIG_WITHOUT_PERMISSIONS.has(key))
      .map(([key, value]) => [`config.${key}`, value]),
  ]);
}

/**
 * Drives the real Codex adapter for one saved chat and records what it sends:
 * a new thread and its first turn, then a resume and a fork of that thread.
 */
const codexRequests = Effect.fn("PermissionWireGolden.codexRequests")(function* (input: {
  readonly policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly thread: OrchestrationV2AppThread;
}) {
  const requests: Array<CodexRequest> = [];
  const client = makeRecordingCodexClient(requests);
  const adapter = yield* makeCodexAdapterV2({
    instanceId: ProviderInstanceId.make("codex"),
    settings: decodeCodexSettings({}),
    environment: {},
    clientFactory: { open: () => Effect.succeed(client) },
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* makeReplayServerConfig("permission-golden").pipe(Effect.orDie),
  });
  const { modelSelection } = input.thread;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* adapter.openSession({
        threadId: input.thread.id,
        providerSessionId: ProviderSessionId.make("session:permission-golden"),
        modelSelection,
        runtimePolicy: input.policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: input.thread.id,
        modelSelection,
        runtimePolicy: input.policy,
      });
      yield* runtime.startTurn(
        turnInput({ thread: input.thread, providerThread, policy: input.policy }),
      );
      yield* runtime.resumeThread({
        providerThread,
        threadId: input.thread.id,
        modelSelection,
        runtimePolicy: input.policy,
      });
      yield* runtime.forkThread({
        sourceProviderThread: providerThread,
        targetThreadId: ThreadId.make(`${input.thread.id}:fork`),
        modelSelection,
        runtimePolicy: input.policy,
      });
    }),
  );
  const sent = (method: string) => {
    const found = requests.filter((request) => request.method === method);
    assert.lengthOf(found, 1, `the Codex adapter sent ${method} once`);
    return found[0]!.params;
  };
  const turnStart = sent("turn/start");
  return {
    turn: {
      approvalPolicy: turnStart.approvalPolicy ?? null,
      approvalsReviewer: turnStart.approvalsReviewer ?? null,
      sandboxPolicy: turnStart.sandboxPolicy ?? null,
      permissions: turnStart.permissions ?? null,
      collaborationMode:
        (turnStart.collaborationMode as { readonly mode?: string } | undefined)?.mode ?? null,
    },
    thread: {
      start: codexThreadPermissionParams(sent("thread/start")),
      resume: codexThreadPermissionParams(sent("thread/resume")),
      fork: codexThreadPermissionParams(sent("thread/fork")),
    },
  };
});

/** The first turn of a saved chat, as the run service hands it to the adapter. */
function turnInput(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: input.thread,
    threadId: input.thread.id,
    runId: RunId.make("run:permission-golden"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt:permission-golden"),
    rootNodeId: NodeId.make("node:permission-golden"),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message:permission-golden"),
      text: "golden",
      attachments: [],
    },
    modelSelection: input.thread.modelSelection,
    runtimePolicy: input.policy,
  };
}

/** The ACP tool kinds a Grok permission prompt can carry, all inside the chat's folder. */
const GROK_PROMPT_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other",
] as const;

/**
 * What the real Grok adapter does with a policy: the argv it launches `grok`
 * with (`makeRuntime` passes `grokLaunchRuntimeMode` to `grokAcpSpawnArgs`; the
 * spawn itself is host-dependent, so the argv is built, not spawned) and how
 * its flavor answers each kind of permission prompt.
 */
function grokWire(policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) {
  const flavor = makeGrokAcpAdapterFlavor(
    {
      instanceId: ProviderInstanceId.make("grok"),
      settings: decodeGrokSettings({}),
      environment: {},
      hostPlatform: "linux",
      selfInvocation: { command: "node", entrypoint: undefined },
    },
    "/home/golden",
  );
  assert.isDefined(flavor.permissionDisposition);
  return {
    launchArgs: [...grokAcpSpawnArgs(grokLaunchRuntimeMode(policy))],
    promptDisposition: Object.fromEntries(
      GROK_PROMPT_KINDS.map((kind) => [
        kind,
        flavor.permissionDisposition!(policy, {
          sessionId: "golden",
          toolCall: {
            toolCallId: `golden-${kind}`,
            kind,
            locations: [{ path: "/workspace/src/golden.ts" }],
          },
          options: [],
        }),
      ]),
    ),
  };
}

const goldenRow = Effect.fn("PermissionWireGolden.row")(function* (input: {
  readonly provider: GoldenProviderCase;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}) {
  const stored = yield* decodeStoredEvent(legacyThreadCreated(input));
  assert.equal(stored.event.type, "thread.created");
  if (stored.event.type !== "thread.created") throw new Error("unreachable");
  const decoded = stored.event.payload;
  // The startup freeze runs before any work resumes (PermissionFreeze.ts).
  const freeze = permissionFreezeFor({
    thread: decoded,
    capabilities: freezeCapabilities(
      {
        [input.provider.instanceId]: {
          driver: ProviderDriverKind.make(input.provider.driver),
          config: { allowBypassPermissions: input.provider.allowBypassPermissions === true },
        },
      },
      input.provider.instanceId,
    ),
  });
  const thread = freeze === undefined ? decoded : { ...decoded, runtimeMode: freeze.to };
  const policy = yield* RuntimePolicy.RuntimePolicyV2;
  const resolved = yield* policy.resolve({ thread, modelSelection: thread.modelSelection });
  // What the session manager hands the adapter for every launch, resume, fork and turn.
  const sent = sessionRuntimePolicy(input.provider.driver, resolved);
  const codex =
    input.provider.driver === "codex" ? yield* codexRequests({ policy: sent, thread }) : undefined;
  const wire =
    input.provider.driver === "claudeAgent"
      ? claudeWire(input.provider, sent, thread.modelSelection)
      : codex !== undefined
        ? codex.turn
        : input.provider.driver === "opencode"
          ? { sessionRules: sessionRules(sent, [], [], null) }
          : {
              runtimeMode: sent.runtimeMode,
              interactionMode: sent.interactionMode,
              approvalPolicy: sent.approvalPolicy ?? null,
              sandboxPolicy: sent.sandboxPolicy ?? null,
            };
  // The same saved chat after its user opts in to Codex's own settings (O2).
  const inherited =
    input.provider.driver === "codex" && input.provider.nativePermissionInherit === true
      ? yield* codexRequests({
          policy: sessionRuntimePolicy(
            input.provider.driver,
            yield* policy.resolve({
              thread: { ...thread, permissionSource: "inherit" },
              modelSelection: thread.modelSelection,
            }),
          ),
          thread,
        })
      : undefined;
  if (codex !== undefined && inherited !== undefined) {
    // Thread requests carry no permissions either way; only turns differ.
    assert.deepStrictEqual(inherited.thread, codex.thread);
  }
  const adapterWire =
    codex !== undefined
      ? { threadRequests: codex.thread }
      : input.provider.driver === "grok"
        ? grokWire(sent)
        : undefined;
  return {
    row: `${input.provider.provider}|${input.runtimeMode}|${input.interactionMode}`,
    storedRuntimeMode: thread.runtimeMode,
    permissionSource: (thread as { readonly permissionSource?: string }).permissionSource ?? null,
    sentRuntimeMode: sent.runtimeMode,
    wire,
    ...(inherited === undefined ? {} : { inheritWire: inherited.turn }),
    ...(adapterWire === undefined ? {} : { adapterWire }),
  };
});

function terminalRows() {
  const claude = (allowBypassPermissions: boolean) =>
    nativeAgentLaunch({
      driver: "claudeAgent",
      config: { allowBypassPermissions },
      home: "/home/golden",
      platform: "linux",
      nodeExecutable: "node",
    }).args;
  const settingsOf = (args: ReadonlyArray<string>) => {
    const index = args.indexOf("--settings");
    const parsed = JSON.parse(args[index + 1]!) as {
      readonly disableAllHooks?: boolean;
      readonly hooks?: Record<string, unknown>;
      readonly permissions?: unknown;
    };
    return {
      flags: args.slice(0, index),
      disableAllHooks: parsed.disableAllHooks ?? null,
      hooks: Object.keys(parsed.hooks ?? {}),
      permissions: parsed.permissions ?? null,
    };
  };
  return [
    { row: "terminal|claude-bypass-on", ...settingsOf(claude(true)) },
    { row: "terminal|claude-bypass-off", ...settingsOf(claude(false)) },
    {
      row: "terminal|codex",
      args: nativeAgentLaunch({ driver: "codex", config: {}, home: "/home/golden" }).args,
    },
  ];
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[keys.at(-1)!] = value;
}

function getPath(target: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((cursor, key) => (cursor as Record<string, unknown>)[key], target);
}

/**
 * The golden plus the adapter-boundary observations, with every approved change
 * applied, checking each change's `before`.
 */
function expectedRows(): ReadonlyArray<Record<string, unknown>> {
  const rows = structuredClone(GOLDEN) as Array<Record<string, unknown>>;
  for (const [key, adapterWire] of Object.entries(ADAPTER_GOLDEN)) {
    const row = rows.find((candidate) => candidate.row === key);
    assert.isDefined(row, `adapter golden names unknown golden row ${key}`);
    row!.adapterWire = structuredClone(adapterWire);
  }
  for (const change of PERMISSION_APPROVED_CHANGES) {
    const row = rows.find((candidate) => candidate.row === change.row);
    assert.isDefined(row, `approved change names unknown golden row ${change.row}`);
    assert.deepStrictEqual(
      getPath(row!, change.field),
      change.before,
      `approved change ${change.row} ${change.field} no longer starts from its recorded value`,
    );
    setPath(row!, change.field, change.after);
  }
  return rows;
}

describe("permission wire golden", () => {
  it.effect("keeps every saved chat's provider wire unless an approved change says otherwise", () =>
    Effect.gen(function* () {
      const rows: Array<Record<string, unknown>> = [];
      for (const provider of PROVIDERS) {
        for (const runtimeMode of RUNTIME_MODES) {
          for (const interactionMode of INTERACTION_MODES) {
            rows.push(yield* goldenRow({ provider, runtimeMode, interactionMode }));
          }
        }
      }
      rows.push(...terminalRows());
      assert.deepStrictEqual(rows, expectedRows());
    }).pipe(
      Effect.provide(
        Layer.mergeAll(runtimePolicyLayer, IdAllocator.layer, McpProviderSessions.layer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it("routes every policy the way the session manager hands it to adapters", () => {
    // Frozen saved chats already store what they run, so the rows above cannot
    // tell a clamp from none. This pins the routing itself.
    const broad = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    assert.deepStrictEqual(sessionRuntimePolicy("claudeAgent", broad), broad);
    for (const driver of ["codex", "opencode", "grok", "cursor"]) {
      assert.deepStrictEqual(sessionRuntimePolicy(driver, broad), {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      });
    }
    // Supervised's own native values survive the clamp.
    const supervised = {
      ...broad,
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    };
    assert.deepStrictEqual(sessionRuntimePolicy("codex", supervised), {
      ...supervised,
      runtimeMode: "approval-required",
    });
    // An allowed inherit passes through untouched.
    const inherit = { ...broad, permissionSource: "inherit" as const };
    assert.deepStrictEqual(sessionRuntimePolicy("codex", inherit), inherit);
    assert.isUndefined(sessionRuntimePolicy("codex", undefined));
  });

  it("names each golden row and field at most once in the approved changes", () => {
    const keys = PERMISSION_APPROVED_CHANGES.map((change) => `${change.row}#${change.field}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

// What the adapters send beyond the fields GOLDEN pins: Codex's thread/start,
// thread/resume and thread/fork requests (besides the thread, folder, model and
// the non-permission config Stark always sends), and Grok's launch argv and
// prompt answers. Captured on feat/permissions-2026-10-30; each value is what
// 458bf2172d + the hotfix sent, because the code producing it is unchanged since
// then: `codexThreadRuntimeParams` and the three thread request call sites in
// CodexAdapterV2.ts, and packages/provider-grok and provider-acp's
// clientPolicy.ts. Never edit; an intended difference is an approved change on
// the `adapterWire.…` field.
const CODEX_THREAD_REQUESTS = { threadRequests: { start: {}, resume: {}, fork: {} } } as const;
const GROK_SUPERVISED = {
  launchArgs: ["--permission-mode", "default", "agent", "stdio"],
  promptDisposition: {
    read: "allow",
    edit: "ask",
    delete: "ask",
    move: "ask",
    search: "allow",
    execute: "ask",
    think: "allow",
    fetch: "ask",
    other: "ask",
  },
} as const;
const ADAPTER_GOLDEN: Readonly<Record<string, unknown>> = {
  "codex|approval-required|default": CODEX_THREAD_REQUESTS,
  "codex|approval-required|plan": CODEX_THREAD_REQUESTS,
  "codex|auto-accept-edits|default": CODEX_THREAD_REQUESTS,
  "codex|auto-accept-edits|plan": CODEX_THREAD_REQUESTS,
  "codex|auto|default": CODEX_THREAD_REQUESTS,
  "codex|auto|plan": CODEX_THREAD_REQUESTS,
  "codex|full-access|default": CODEX_THREAD_REQUESTS,
  "codex|full-access|plan": CODEX_THREAD_REQUESTS,
  "grok|approval-required|default": GROK_SUPERVISED,
  "grok|approval-required|plan": GROK_SUPERVISED,
  "grok|auto-accept-edits|default": GROK_SUPERVISED,
  "grok|auto-accept-edits|plan": GROK_SUPERVISED,
  "grok|auto|default": GROK_SUPERVISED,
  "grok|auto|plan": GROK_SUPERVISED,
  "grok|full-access|default": GROK_SUPERVISED,
  "grok|full-access|plan": GROK_SUPERVISED,
};

// Captured at feat/provider-native-permissions 458bf2172d + the session-rule
// hotfix, before any provider-native permission change. Never edit.
const GOLDEN: ReadonlyArray<Record<string, unknown>> = [
  {
    row: "claude-bypass-on|approval-required|default",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      permissionMode: "default",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: null,
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-on|approval-required|plan",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: null,
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-on|auto-accept-edits|default",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "auto-accept-edits",
    wire: {
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: null,
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-on|auto-accept-edits|plan",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "auto-accept-edits",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: null,
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-on|auto|default",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "auto",
    wire: {
      permissionMode: "auto",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: null,
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-on|auto|plan",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "auto",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: null,
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-on|full-access|default",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "full-access",
    wire: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      permissionCallback: false,
      settingsPermissions: null,
      disableAllHooks: null,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-on|full-access|plan",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "full-access",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: null,
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|approval-required|default",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      permissionMode: "default",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|approval-required|plan",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|auto-accept-edits|default",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "auto-accept-edits",
    wire: {
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|auto-accept-edits|plan",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "auto-accept-edits",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|auto|default",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "auto",
    wire: {
      permissionMode: "auto",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|auto|plan",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "auto",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|full-access|default",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      permissionMode: "default",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "claude-bypass-off|full-access|plan",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      permissionMode: "plan",
      allowDangerouslySkipPermissions: null,
      permissionCallback: true,
      settingsPermissions: {
        disableBypassPermissionsMode: "disable",
      },
      disableAllHooks: false,
      allowedTools: null,
      disallowedTools: null,
      hooks: ["PreToolUse:1"],
    },
  },
  {
    row: "codex|approval-required|default",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: null,
    },
  },
  {
    row: "codex|approval-required|plan",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: "plan",
    },
  },
  {
    row: "codex|auto-accept-edits|default",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: null,
    },
  },
  {
    row: "codex|auto-accept-edits|plan",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: "plan",
    },
  },
  {
    row: "codex|auto|default",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: null,
    },
  },
  {
    row: "codex|auto|plan",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: "plan",
    },
  },
  {
    row: "codex|full-access|default",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: null,
    },
  },
  {
    row: "codex|full-access|plan",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      permissions: null,
      collaborationMode: "plan",
    },
  },
  {
    row: "opencode|approval-required|default",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
      ],
    },
  },
  {
    row: "opencode|approval-required|plan",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "deny",
        },
      ],
    },
  },
  {
    row: "opencode|auto-accept-edits|default",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
      ],
    },
  },
  {
    row: "opencode|auto-accept-edits|plan",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "deny",
        },
      ],
    },
  },
  {
    row: "opencode|auto|default",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
      ],
    },
  },
  {
    row: "opencode|auto|plan",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "deny",
        },
      ],
    },
  },
  {
    row: "opencode|full-access|default",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
      ],
    },
  },
  {
    row: "opencode|full-access|plan",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      sessionRules: [
        {
          action: "shell",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "ask",
        },
        {
          action: "external_directory",
          resource: "*",
          effect: "ask",
        },
        {
          action: "edit",
          resource: "*",
          effect: "deny",
        },
      ],
    },
  },
  {
    row: "grok|approval-required|default",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "default",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "grok|approval-required|plan",
    storedRuntimeMode: "approval-required",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "plan",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "grok|auto-accept-edits|default",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "default",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "grok|auto-accept-edits|plan",
    storedRuntimeMode: "auto-accept-edits",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "plan",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "grok|auto|default",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "default",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "grok|auto|plan",
    storedRuntimeMode: "auto",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "plan",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "grok|full-access|default",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "default",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "grok|full-access|plan",
    storedRuntimeMode: "full-access",
    permissionSource: null,
    sentRuntimeMode: "approval-required",
    wire: {
      runtimeMode: "approval-required",
      interactionMode: "plan",
      approvalPolicy: null,
      sandboxPolicy: null,
    },
  },
  {
    row: "terminal|claude-bypass-on",
    flags: ["--permission-mode", "default"],
    disableAllHooks: false,
    hooks: ["PreToolUse"],
    permissions: null,
  },
  {
    row: "terminal|claude-bypass-off",
    flags: ["--permission-mode", "default"],
    disableAllHooks: false,
    hooks: ["PreToolUse"],
    permissions: {
      disableBypassPermissionsMode: "disable",
    },
  },
  {
    row: "terminal|codex",
    args: [
      "--ask-for-approval",
      "on-request",
      "--sandbox",
      "read-only",
      "-c",
      'approvals_reviewer="user"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "--no-daemon",
      "-c",
      "analytics.enabled=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
      "-c",
      "otel.log_user_prompt=false",
    ],
  },
];
