/**
 * Changing a chat's permissions through the orchestrator (PLAN-002 §3.1
 * authorisation, §3.2 timing): who may widen, what a limited sender may touch
 * when a chat inherits its provider's settings, and how a narrowing reaches the
 * provider session.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type PermissionSource,
  ProviderDriverKind,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@starkfuture/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "../DispatchModeLimit.ts";
import { DispatchSettingsWrite } from "../DispatchSettingsWrite.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import {
  causeOf,
  claudeId,
  claudeSelection,
  codexSelection,
  createThread,
  layerPermissionRuntime,
  projectionOf,
  queuedEffectTypes,
  sendMessage,
  setSnapshots,
  threadOf,
  workspace,
} from "./PermissionTestkit.ts";

const withoutSettingsWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, DispatchSettingsWrite, false);

const setPermission = (input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly permissionSource: PermissionSource;
  readonly runtimeMode: RuntimeMode;
  readonly whileRunning?: "stop-and-apply" | "apply-after-run";
}) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.permission.set",
      commandId: CommandId.make(`permission:${input.threadId}:${input.key}`),
      threadId: input.threadId,
      permissionSource: input.permissionSource,
      runtimeMode: input.runtimeMode,
      ...(input.whileRunning === undefined ? {} : { whileRunning: input.whileRunning }),
    }),
  );

const setRuntimeMode = (threadId: ThreadId, key: string, runtimeMode: RuntimeMode) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(`runtime-mode:${threadId}:${key}`),
      threadId,
      runtimeMode,
    }),
  );

const rename = (threadId: ThreadId, key: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`rename:${threadId}:${key}`),
      threadId,
      title: `Renamed ${key}`,
    }),
  );

/** A live provider session on the thread, as the session manager records one. */
const attachSession = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerSessionId = ProviderSessionId.make(`session:${name}`);
    yield* eventSink.write({
      commandId: CommandId.make(`${name}:session`),
      events: [
        {
          id: EventId.make(`${name}:session`),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeId,
            status: "ready",
            cwd: workspace,
            model: claudeSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        },
      ],
    });
    return providerSessionId;
  });

it.layer(layerPermissionRuntime)("widening a chat needs settings-write", (it) => {
  it.effect("refuses a widening runtime-mode.set from a client without settings-write", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const threadId = ThreadId.make("thread:mode-set-widen");
      yield* createThread({
        threadId,
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
      });
      for (const runtimeMode of ["auto-accept-edits", "auto"] as const) {
        const refused = yield* withoutSettingsWrite(
          setRuntimeMode(threadId, `widen-${runtimeMode}`, runtimeMode),
        ).pipe(Effect.flip);
        assert.include(causeOf(refused), "needs permission to change settings");
      }
      assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
      // A local client (no scope limit) widens; the narrowest preset needs nothing.
      yield* setRuntimeMode(threadId, "widen-local", "auto");
      assert.equal((yield* threadOf(threadId)).runtimeMode, "auto");
      yield* withoutSettingsWrite(setRuntimeMode(threadId, "narrow", "approval-required"));
      assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
    }),
  );

  it.effect("allows a client without settings-write only the narrowest preset", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const threadId = ThreadId.make("thread:mode-set-step-down");
      yield* createThread({ threadId, modelSelection: claudeSelection, runtimeMode: "auto" });
      // Auto to Accept edits narrows, but it is still not the narrowest preset (O12).
      const refused = yield* withoutSettingsWrite(
        setPermission({
          threadId,
          key: "step-down",
          permissionSource: "override",
          runtimeMode: "auto-accept-edits",
        }),
      ).pipe(Effect.flip);
      assert.include(causeOf(refused), "needs permission to change settings");
      assert.equal((yield* threadOf(threadId)).runtimeMode, "auto");
    }),
  );

  it.effect("treats choosing the provider's own settings as a widening", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const threadId = ThreadId.make("thread:inherit-needs-scope");
      yield* createThread({
        threadId,
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
        permissionSource: "override",
      });
      // Inheriting with Manual as the fallback preset is still not the narrowest choice.
      const refused = yield* withoutSettingsWrite(
        setPermission({
          threadId,
          key: "inherit-remote",
          permissionSource: "inherit",
          runtimeMode: "approval-required",
        }),
      ).pipe(Effect.flip);
      assert.include(causeOf(refused), "needs permission to change settings");
      assert.equal((yield* threadOf(threadId)).permissionSource, "override");
      yield* setPermission({
        threadId,
        key: "inherit-local",
        permissionSource: "inherit",
        runtimeMode: "approval-required",
      });
      assert.equal((yield* threadOf(threadId)).permissionSource, "inherit");
      // Leaving inherit for the narrowest preset is open to any client.
      yield* withoutSettingsWrite(
        setPermission({
          threadId,
          key: "back-to-manual",
          permissionSource: "override",
          runtimeMode: "approval-required",
        }),
      );
      assert.equal((yield* threadOf(threadId)).permissionSource, "override");
    }),
  );

  it.effect("stores what the provider runs, whatever mode a client asks for", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const claudeThread = ThreadId.make("thread:store-effective-claude");
      const codexThread = ThreadId.make("thread:store-effective-codex");
      yield* createThread({
        threadId: claudeThread,
        modelSelection: claudeSelection,
        runtimeMode: "auto",
      });
      yield* createThread({
        threadId: codexThread,
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });
      // Bypass is off for this Claude account, so full access runs as Manual.
      yield* setRuntimeMode(claudeThread, "bypass-off", "full-access");
      assert.equal((yield* threadOf(claudeThread)).runtimeMode, "approval-required");
      // Codex runs Supervised under the brand clamp.
      yield* setRuntimeMode(codexThread, "codex-auto", "auto");
      assert.equal((yield* threadOf(codexThread)).runtimeMode, "approval-required");
    }),
  );
});

it.layer(layerPermissionRuntime)("a limited sender treats inherited settings as broadest", (it) => {
  const autoLimit = { runtimeMode: "auto", interactionMode: "default" } as const;

  it.effect("refuses to touch a chat that inherits, even when its fallback preset is Manual", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const threadId = ThreadId.make("thread:limit-inherit-target");
      yield* createThread({
        threadId,
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
        permissionSource: "inherit",
      });
      assert.equal((yield* threadOf(threadId)).permissionSource, "inherit");
      const refused = yield* rename(threadId, "limited").pipe(
        Effect.provideService(DispatchModeLimit, autoLimit),
        Effect.flip,
      );
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* threadOf(threadId)).title, "Permission chat");
      // The same sender may touch it once the chat is back on a preset.
      yield* setPermission({
        threadId,
        key: "back-to-preset",
        permissionSource: "override",
        runtimeMode: "auto",
      });
      yield* rename(threadId, "within-limit").pipe(
        Effect.provideService(DispatchModeLimit, autoLimit),
      );
      assert.equal((yield* threadOf(threadId)).title, "Renamed within-limit");
    }),
  );

  it.effect("refuses to switch a chat to inherited settings or above the sender's limit", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const threadId = ThreadId.make("thread:limit-raise");
      yield* createThread({
        threadId,
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
        permissionSource: "override",
      });
      const toInherit = yield* setPermission({
        threadId,
        key: "limited-inherit",
        permissionSource: "inherit",
        runtimeMode: "approval-required",
      }).pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
        Effect.flip,
      );
      assert.include(causeOf(toInherit), "may not raise the chat's permissions");
      // The limit compares what the chat would run: with Bypass off, full access
      // runs (and is stored) as Manual, which is within a Manual limit.
      yield* setRuntimeMode(threadId, "limited-full", "full-access").pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required",
          interactionMode: "default",
        }),
      );
      assert.equal((yield* threadOf(threadId)).runtimeMode, "approval-required");
      const aboveLimitAuto = yield* setRuntimeMode(threadId, "limited-auto", "auto").pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required",
          interactionMode: "default",
        }),
        Effect.flip,
      );
      assert.include(causeOf(aboveLimitAuto), "may not raise the chat's permissions");
      assert.deepInclude(yield* threadOf(threadId), {
        permissionSource: "override",
        runtimeMode: "approval-required",
      });
    }),
  );

  it.effect("refuses to fork a chat that inherits for a limited sender", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const sourceThreadId = ThreadId.make("thread:limit-fork-inherit");
      const targetThreadId = ThreadId.make("thread:limit-fork-inherit-target");
      yield* createThread({
        threadId: sourceThreadId,
        modelSelection: claudeSelection,
        runtimeMode: "approval-required",
        permissionSource: "inherit",
      });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const refused = yield* orchestrator
        .dispatch({
          type: "thread.fork",
          commandId: CommandId.make("limit-fork-inherit"),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.provideService(DispatchModeLimit, autoLimit), Effect.flip);
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
    }),
  );
});

it.layer(layerPermissionRuntime)("a narrowing reaches the provider session", (it) => {
  it.effect("restarts the idle provider session when a chat narrows or changes source", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const threadId = ThreadId.make("thread:narrow-idle");
      yield* createThread({ threadId, modelSelection: claudeSelection, runtimeMode: "auto" });
      yield* attachSession(threadId, "narrow-idle-1");
      yield* setPermission({
        threadId,
        key: "narrow",
        permissionSource: "override",
        runtimeMode: "approval-required",
      });
      // The session's grants and cached approvals end with it.
      const afterNarrow = yield* projectionOf(threadId);
      assert.isTrue(
        afterNarrow.providerSessions.every((session) => session.status === "stopped"),
        JSON.stringify(afterNarrow.providerSessions.map((session) => session.status)),
      );
      assert.include(yield* queuedEffectTypes(threadId), "provider-session.detach");

      // Switching to the provider's own settings restarts the session too.
      yield* attachSession(threadId, "narrow-idle-2");
      const before = (yield* queuedEffectTypes(threadId)).length;
      yield* setPermission({
        threadId,
        key: "inherit",
        permissionSource: "inherit",
        runtimeMode: "approval-required",
      });
      const detaches = (yield* queuedEffectTypes(threadId))
        .slice(before)
        .filter((type) => type === "provider-session.detach");
      assert.lengthOf(detaches, 1);
    }),
  );

  it.effect("during a run, asks how to apply a narrowing and never waits for the next turn", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true });
      const threadId = ThreadId.make("thread:narrow-running");
      yield* createThread({ threadId, modelSelection: claudeSelection, runtimeMode: "auto" });
      yield* sendMessage({
        threadId,
        key: "busy",
        dispatchMode: { type: "start_immediately" },
      });
      const running = (yield* projectionOf(threadId)).runs.at(-1)!;
      assert.include(["preparing", "starting", "running"], running.status);

      const unchosen = yield* setPermission({
        threadId,
        key: "no-choice",
        permissionSource: "override",
        runtimeMode: "approval-required",
      }).pipe(Effect.flip);
      assert.include(causeOf(unchosen), "Stop and apply now, or Apply after this run stops");
      // Inheriting is never applied mid-run.
      const widening = yield* setPermission({
        threadId,
        key: "inherit-mid-run",
        permissionSource: "inherit",
        runtimeMode: "auto",
      }).pipe(Effect.flip);
      assert.include(causeOf(widening), "once this run stops");

      yield* setPermission({
        threadId,
        key: "after-run",
        permissionSource: "override",
        runtimeMode: "approval-required",
        whileRunning: "apply-after-run",
      });
      const pending = yield* threadOf(threadId);
      assert.equal(pending.runtimeMode, "approval-required");
      assert.isNotNull(pending.permissionChangePending ?? null);
      // The run keeps going until it stops.
      assert.equal(
        (yield* projectionOf(threadId)).runs.find((run) => run.id === running.id)?.status,
        running.status,
      );
    }),
  );

  it.effect("an older client's mode change during a run applies when the run stops", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const threadId = ThreadId.make("thread:narrow-running-legacy");
      yield* createThread({ threadId, modelSelection: claudeSelection, runtimeMode: "auto" });
      yield* sendMessage({ threadId, key: "busy", dispatchMode: { type: "start_immediately" } });
      yield* setRuntimeMode(threadId, "legacy-narrow", "approval-required");
      const thread = yield* threadOf(threadId);
      assert.equal(thread.runtimeMode, "approval-required");
      assert.isNotNull(thread.permissionChangePending ?? null);
      // Its events stay as before: no permission source appears on a legacy chat.
      assert.isUndefined(thread.permissionSource);
    }),
  );

  it.effect("Stop and apply now interrupts the run", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const threadId = ThreadId.make("thread:narrow-stop");
      yield* createThread({ threadId, modelSelection: claudeSelection, runtimeMode: "auto" });
      yield* sendMessage({ threadId, key: "busy", dispatchMode: { type: "start_immediately" } });
      const run = (yield* projectionOf(threadId)).runs.at(-1)!;
      yield* setPermission({
        threadId,
        key: "stop-and-apply",
        permissionSource: "override",
        runtimeMode: "approval-required",
        whileRunning: "stop-and-apply",
      });
      const stopped = (yield* projectionOf(threadId)).runs.find(
        (candidate) => candidate.id === run.id,
      );
      assert.notInclude(["starting", "running"], stopped?.status);
    }),
  );

  it.effect("a provider switch returns an inheriting chat to an explicit preset", () =>
    Effect.gen(function* () {
      yield* setSnapshots({ claudeInherits: true, codexInherits: true });
      const threadId = ThreadId.make("thread:switch-inherit");
      yield* createThread({
        threadId,
        modelSelection: claudeSelection,
        runtimeMode: "auto",
        permissionSource: "inherit",
      });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("switch-inherit:to-codex"),
        threadId,
        modelSelection: codexSelection,
      });
      // Codex's own settings are not Claude's: the user chooses again (O3).
      assert.deepInclude(yield* threadOf(threadId), {
        permissionSource: "override",
        runtimeMode: "approval-required",
      });
    }),
  );
});
