import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthSourceControlWriteScope,
  ThreadId,
  ProjectId,
  EnvironmentId,
  ScheduledTaskId,
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type AuthSessionState,
  type OrchestrationV2Command,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentCommand, createEnvironmentRpcCommand } from "./runtime.ts";
import { startThreadTurn, type StartThreadTurnInput } from "../operations/commands.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("local history command permissions", () => {
  it.effect("imports only with the destination's operate grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const importing = createCommandPermissions(runtime, WS_METHODS.agentSessionsImport);
        const input = { projectId: ProjectId.make("work"), scope: "all-local" as const };
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(importing.permissionAtom(env, input))).toBe(true);
        yield* importing.authorize(registry, env, input);
        expect(registry.get(importing.permissionAtom(other, input))).toBe(false);
        expect(yield* importing.authorize(registry, other, input).pipe(Effect.flip)).toMatchObject({
          requiredPermission: AuthOrchestrationOperateScope,
        });
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(importing.permissionAtom(env, input))).toBe(false);
        expect(yield* importing.authorize(registry, env, input).pipe(Effect.flip)).toMatchObject({
          requiredPermission: AuthOrchestrationOperateScope,
        });
      }),
    ),
  );

  it.effect("requires settings and operate together to change sync, rechecking either grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const configure = createCommandPermissions(runtime, WS_METHODS.agentSessionsSyncConfigure);
        const input = { enabled: true, projectId: ProjectId.make("work") };
        const both = {
          ...grant(true),
          scopes: [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
          permissions: [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
        };
        registry.set(sessions(env), AsyncResult.success(both));
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        expect(registry.get(configure.permissionAtom(env, input))).toBe(true);
        yield* configure.authorize(registry, env, input);
        expect(registry.get(configure.permissionAtom(other, input))).toBe(false);
        for (const missing of [AuthSettingsWriteScope, AuthOrchestrationOperateScope]) {
          const remaining = both.scopes.filter((scope) => scope !== missing);
          registry.set(
            sessions(env),
            AsyncResult.success({ ...both, scopes: remaining, permissions: remaining }),
          );
          expect(registry.get(configure.permissionAtom(env, input))).toBe(false);
          for (const enabled of [true, false]) {
            expect(
              yield* configure.authorize(registry, env, { ...input, enabled }).pipe(Effect.flip),
            ).toMatchObject({ requiredPermission: missing });
          }
          registry.set(sessions(env), AsyncResult.success(both));
          yield* configure.authorize(registry, env, input);
        }
      }),
    ),
  );

  it("does not execute a queued sync change after its settings grant is revoked", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(
      sessions(env),
      AsyncResult.success({
        ...grant(true),
        scopes: [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
        permissions: [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
      }),
    );
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.local-history-sync",
      tag: WS_METHODS.agentSessionsSyncConfigure,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return {
            enabled: true,
            projectId: ProjectId.make("work"),
            running: false,
            lastSyncedAt: null,
            lastResult: null,
            error: null,
          };
        }),
    });
    const target = {
      environmentId: env,
      input: { enabled: true, projectId: ProjectId.make("work") },
    };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, {
        ...target,
        input: { ...target.input, enabled: false },
      });
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      release();
      unmount();
      registry.dispose();
    }
  });
});

describe("command permissions", () => {
  it.effect("requires the destination's operate grant to reload MCP servers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const reload = createCommandPermissions(runtime, WS_METHODS.mcpServersReload);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(reload.permissionAtom(env))).toBe(false);
        expect((yield* reload.authorize(registry, env).pipe(Effect.flip)).requiredScope).toBe(
          AuthOrchestrationOperateScope,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* reload.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(reload.permissionAtom(other))).toBe(false);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect((yield* reload.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );
  it.effect("requires a destination agent grant before spending tokens on reply visuals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const visuals = createCommandPermissions(runtime, WS_METHODS.responseVisualsFormat);
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        expect(registry.get(visuals.permissionAtom(env))).toBe(false);
        expect((yield* visuals.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(visuals.permissionAtom(env))).toBe(true);
        yield* visuals.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(visuals.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires provider administration on the destination for Claude accounts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        for (const method of [
          WS_METHODS.claudeAccountsSnapshot,
          WS_METHODS.claudeAccountsCommand,
        ]) {
          const permissions = createCommandPermissions(runtime, method);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(permissions.permissionAtom(env))).toBe(false);
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(true),
              scopes: [AuthProvidersManageScope],
              permissions: [AuthProvidersManageScope],
            }),
          );
          yield* permissions.authorize(registry, env);
          expect(registry.get(permissions.permissionAtom(env))).toBe(true);
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        }
      }),
    ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

it.effect(
  "authorizes an existing chat turn at the command boundary and rechecks the destination",
  () =>
    Effect.gen(function* () {
      const writes: OrchestrationV2Command[] = [];
      const session = {
        client: {
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              writes.push(command);
              return { sequence: writes.length };
            }),
        },
      } as unknown as RpcSession;
      const supervisor = {
        // A routed command must use the destination's grants, not the origin's.
        target: { environmentId: other, label: "destination" },
        session: yield* SubscriptionRef.make(Option.some(session)),
      } as unknown as EnvironmentSupervisor["Service"];
      const turnRuntime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry, {
            run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          } as EnvironmentRegistry["Service"]),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
        ),
      );
      const command = createEnvironmentCommand(turnRuntime, {
        label: "test.existing-chat-turn",
        execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      });
      const registry = AtomRegistry.make();
      registry.mount(sessions(env));
      registry.mount(sessions(other));
      const target = {
        environmentId: env,
        input: {
          commandId: CommandId.make("follow-up"),
          threadId: ThreadId.make("existing-thread"),
          message: {
            messageId: MessageId.make("follow-up-message"),
            role: "user",
            text: "Continue after reconnect.",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          dispatchMode: "start",
        } satisfies StartThreadTurnInput,
      };
      try {
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect((yield* Effect.promise(() => command.run(registry, target)))._tag).toBe("Failure");
        expect(writes).toHaveLength(0);

        registry.set(sessions(other), AsyncResult.success(grant(true)));
        expect((yield* Effect.promise(() => command.run(registry, target)))._tag).toBe("Success");
        expect(writes).toMatchObject([
          {
            type: "message.dispatch",
            threadId: "existing-thread",
            text: "Continue after reconnect.",
          },
        ]);

        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect((yield* Effect.promise(() => command.run(registry, target)))._tag).toBe("Failure");
        expect(writes).toHaveLength(1);
      } finally {
        registry.dispose();
      }
    }),
);
