/**
 * Approval answers through the real orchestrator (PLAN-002 §3.1, §3.3): which
 * offered option an answer resolves to, what the respond effect hands the
 * adapter, who may save a rule, and how delivery moves once answered.
 *
 * Requests are seeded as the ingestor writes them; no effect worker runs, so
 * the queued respond effect is exactly what the adapter would receive, and
 * delivery moves only through the internal commands the effect worker and the
 * ingestor send. `PermissionAnswersReplay` covers the worker end to end.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ProviderApprovalOption,
  type ProviderApprovalOptionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@starkfuture/contracts";
import * as Effect from "effect/Effect";

import { DispatchSettingsWrite } from "../DispatchSettingsWrite.ts";
import * as Orchestrator from "../Orchestrator.ts";
import {
  causeOf,
  codexSelection,
  layerPermissionRuntime,
  projectionOf,
  queuedEffectTypes,
  queuedResponds,
  seedPendingApproval,
  setSnapshots,
  storedEventTypes,
} from "./PermissionTestkit.ts";

/** A Codex 0.163 command approval as the Codex package (D2) lists it. */
const CODEX_COMMAND_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { optionId: "deny:0", decision: "decline", label: "Deny", effect: "deny" },
  { optionId: "once:0", decision: "accept", label: "Allow once", scope: "once", effect: "allow" },
  {
    optionId: "session:0",
    decision: "acceptForSession",
    label: "Allow for this session",
    scope: "session",
    effect: "allow",
  },
  {
    optionId: "persistent:0",
    decision: "acceptAlways",
    label: "Always allow (Codex, every project)",
    scope: "persistent",
    effect: "allow",
    persistsTo: "codex-rules",
    rulePreview: ['prefix_rule(pattern=["npm","test"], decision="allow")'],
    nativePayload: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } },
  },
  {
    // A saved block rule answers Deny too, but only its option id picks it.
    optionId: "persistent:1",
    decision: "decline",
    label: "Always block registry.npmjs.org",
    scope: "persistent",
    effect: "deny",
    persistsTo: "codex-network-rules",
    rulePreview: ['network_policy_amendment(host="registry.npmjs.org", action="deny")'],
    nativePayload: {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: "registry.npmjs.org", action: "deny" },
      },
    },
  },
  {
    optionId: "deny-stop:0",
    decision: "cancel",
    label: "Deny and stop",
    effect: "deny_and_stop",
  },
];

/** A Claude request as an adapter without option ids (before D1) offers it. */
const CLAUDE_LEGACY_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Allow once" },
];

interface RequestRef {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
}

const respond = (
  input: RequestRef & {
    readonly key: string;
    readonly optionId?: ProviderApprovalOptionId;
    readonly decision?: ProviderApprovalOption["decision"];
    readonly feedback?: string;
  },
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`respond:${input.key}`),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
    }),
  );

const withoutSettingsWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, DispatchSettingsWrite, false);

it.layer(layerPermissionRuntime)("approval answers resolve to offered options", (it) => {
  it.effect.each([
    ["decline", "deny:0", "decline"],
    ["accept", "once:0", "accept"],
    ["acceptForSession", "session:0", "acceptForSession"],
    ["cancel", "deny-stop:0", "cancel"],
  ] as const)(
    "an older client's plain %s becomes the narrowest offered option (%s)",
    ([decision, optionId, sentDecision]) =>
      Effect.gen(function* () {
        yield* setSnapshots({});
        const seeded = yield* seedPendingApproval({
          name: `older-client-${decision}`,
          options: CODEX_COMMAND_OPTIONS,
          modelSelection: codexSelection,
        });
        yield* respond({ key: `older-client-${decision}`, ...seeded, decision });
        const answered = yield* seeded.requestOf;
        assert.equal(answered.status, "resolved");
        assert.equal(answered.chosen?.optionId, optionId);
        assert.equal(answered.decision, sentDecision);
        // The adapter receives the option id, so it sends that option's exact
        // native response rather than re-deriving one from the decision.
        const [effect] = yield* queuedResponds(seeded.threadId);
        assert.deepInclude(effect, {
          type: "runtime-request.respond",
          optionId,
          decision: sentDecision,
        });
      }),
  );

  it.effect("an older client's Deny never saves the block rule that also answers Deny", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({
        name: "older-client-deny-not-block-rule",
        options: CODEX_COMMAND_OPTIONS,
        modelSelection: codexSelection,
      });
      // No settings-write: a persistent choice would be refused, a plain deny is not.
      yield* withoutSettingsWrite(
        respond({ key: "older-client-deny-not-block-rule", ...seeded, decision: "decline" }),
      );
      const answered = yield* seeded.requestOf;
      assert.equal(answered.chosen?.optionId, "deny:0");
      assert.isUndefined(answered.chosen?.persistsTo);
      assert.isUndefined(answered.chosen?.nativePayload);
    }),
  );

  it.effect("records the exact native response of a saved rule the user chose", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({
        name: "persistent-exact-payload",
        options: CODEX_COMMAND_OPTIONS,
        modelSelection: codexSelection,
      });
      yield* respond({ key: "persistent-exact-payload", ...seeded, optionId: "persistent:1" });
      const answered = yield* seeded.requestOf;
      assert.deepStrictEqual(answered.chosen, {
        optionId: "persistent:1",
        decision: "decline",
        scope: "persistent",
        effect: "deny",
        persistsTo: "codex-network-rules",
        nativePayload: CODEX_COMMAND_OPTIONS[4]!.nativePayload,
      });
      // A saved block rule is still a denial: the request's node is cancelled.
      assert.equal(answered.decision, "decline");
    }),
  );

  it.effect("refuses answers the request does not offer and sends nothing to the provider", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({
        name: "unoffered-answers",
        options: CLAUDE_LEGACY_OPTIONS,
      });
      const before = yield* storedEventTypes(seeded.threadId);
      const refusals: Array<[string, Parameters<typeof respond>[0]]> = [
        // A stale session answer used to become Allow once silently.
        ["no longer offered", { key: "stale-session", ...seeded, decision: "acceptForSession" }],
        ["no longer offered", { key: "stale-always", ...seeded, decision: "acceptAlways" }],
        ["no longer offered", { key: "unknown-id", ...seeded, optionId: "session:0" }],
        [
          "does not match the chosen option",
          { key: "mismatch", ...seeded, optionId: "once:0", decision: "decline" },
        ],
        [
          "does not send a reason",
          { key: "reason-on-allow", ...seeded, optionId: "once:0", feedback: "Go ahead." },
        ],
      ];
      for (const [reason, answer] of refusals) {
        const refused = yield* respond(answer).pipe(Effect.flip);
        assert.include(causeOf(refused), reason, answer.key);
      }
      assert.equal((yield* seeded.requestOf).status, "pending");
      assert.deepEqual(yield* storedEventTypes(seeded.threadId), before);
      assert.deepEqual(yield* queuedResponds(seeded.threadId), []);

      // A refused answer leaves the request answerable.
      yield* respond({ key: "after-refusals", ...seeded, optionId: "deny:0" });
      assert.deepEqual((yield* seeded.requestOf).chosen, {
        optionId: "deny:0",
        decision: "decline",
      });
      const again = yield* respond({ key: "second-answer", ...seeded, optionId: "once:0" }).pipe(
        Effect.flip,
      );
      assert.include(causeOf(again), "is resolved");
      assert.lengthOf(yield* queuedResponds(seeded.threadId), 1);
    }),
  );

  it.effect("refuses a denial the request does not list (O7: only listed decisions)", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({
        name: "unlisted-stop",
        options: CLAUDE_LEGACY_OPTIONS,
      });
      const refused = yield* respond({ key: "unlisted-stop", ...seeded, decision: "cancel" }).pipe(
        Effect.flip,
      );
      assert.include(causeOf(refused), "no longer offered");
      assert.equal((yield* seeded.requestOf).status, "pending");
      assert.equal((yield* seeded.nodeOf).status, "waiting");
      assert.deepEqual(yield* queuedResponds(seeded.threadId), []);
    }),
  );

  it.effect("sends a reason only with an option that accepts one", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({
        name: "deny-with-reason",
        options: [
          {
            optionId: "deny:0",
            decision: "decline",
            label: "Decline",
            effect: "deny",
            acceptsFeedback: true,
          },
          {
            optionId: "deny-stop:0",
            decision: "cancel",
            label: "Decline and stop",
            effect: "deny_and_stop",
            acceptsFeedback: true,
          },
          { optionId: "once:0", decision: "accept", label: "Allow once", scope: "once" },
        ],
      });
      yield* respond({
        key: "deny-with-reason",
        ...seeded,
        optionId: "deny-stop:0",
        feedback: "Use the fixture instead.",
      });
      const answered = yield* seeded.requestOf;
      assert.deepEqual(answered.chosen, {
        optionId: "deny-stop:0",
        decision: "cancel",
        effect: "deny_and_stop",
        feedback: "Use the fixture instead.",
      });
      const [effect] = yield* queuedResponds(seeded.threadId);
      assert.deepInclude(effect, {
        optionId: "deny-stop:0",
        decision: "cancel",
        feedback: "Use the fixture instead.",
      });
    }),
  );
});

it.layer(layerPermissionRuntime)("saving a rule needs settings-write", (it) => {
  it.effect("refuses every persistent answer from a client without settings-write", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({
        name: "persistent-needs-settings-write",
        options: [
          ...CLAUDE_LEGACY_OPTIONS,
          {
            decision: "acceptAlways",
            label: "Always allow in this project",
            persistsTo: "claude-local-settings",
            rulePreview: ["Bash(npm test)"],
          },
          CODEX_COMMAND_OPTIONS[4]!,
        ],
      });
      // The legacy decision, its server-issued id, and a saved block rule.
      for (const answer of [
        { key: "always-by-decision", decision: "acceptAlways" as const },
        { key: "always-by-id", optionId: "persistent:0" as const },
        { key: "block-rule-by-id", optionId: "persistent:1" as const },
      ]) {
        const refused = yield* withoutSettingsWrite(respond({ ...answer, ...seeded })).pipe(
          Effect.flip,
        );
        assert.include(causeOf(refused), "needs permission to change settings", answer.key);
      }
      assert.equal((yield* seeded.requestOf).status, "pending");
      assert.deepEqual(yield* queuedResponds(seeded.threadId), []);

      // The same answers go through for a client that holds the scope.
      yield* Effect.provideService(
        respond({ key: "always-with-scope", ...seeded, decision: "acceptAlways" }),
        DispatchSettingsWrite,
        true,
      );
      const answered = yield* seeded.requestOf;
      assert.equal(answered.chosen?.optionId, "persistent:0");
      assert.equal(answered.chosen?.persistsTo, "claude-local-settings");
    }),
  );

  it.effect("lets a client without settings-write answer once, for the session, or deny", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      for (const optionId of ["once:0", "session:0", "deny:0", "deny-stop:0"] as const) {
        const seeded = yield* seedPendingApproval({
          name: `operate-only-${optionId.replace(":", "-")}`,
          options: CODEX_COMMAND_OPTIONS,
          modelSelection: codexSelection,
        });
        yield* withoutSettingsWrite(respond({ key: seeded.threadId, ...seeded, optionId }));
        assert.equal((yield* seeded.requestOf).chosen?.optionId, optionId);
      }
    }),
  );
});

it.layer(layerPermissionRuntime)("delivery moves on once, apart from the answer", (it) => {
  const answered = (name: string) =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({ name, options: CLAUDE_LEGACY_OPTIONS });
      yield* respond({ key: name, ...seeded, decision: "accept" });
      const request = yield* seeded.requestOf;
      // Answered is not delivered.
      assert.equal(request.status, "resolved");
      assert.deepInclude(request.delivery, { state: "pending", attempts: 0 });
      return seeded;
    });
  const deliveryUpdate = (
    seeded: RequestRef,
    key: string,
    state: "delivered" | "not_delivered" | "uncertain",
  ) =>
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "runtime-request.delivery.update",
        commandId: CommandId.make(`delivery:${key}`),
        threadId: seeded.threadId,
        requestId: seeded.requestId,
        state,
        ...(state === "delivered" ? {} : { reason: "The provider process was gone." }),
      }),
    );
  const providerClosed = (seeded: RequestRef, key: string) =>
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "runtime-request.provider-closed",
        commandId: CommandId.make(`closed:${key}`),
        threadId: seeded.threadId,
        requestId: seeded.requestId,
      }),
    );

  it.effect("pending → delivered, then refuses every later update and a provider close", () =>
    Effect.gen(function* () {
      const seeded = yield* answered("delivered-once");
      yield* deliveryUpdate(seeded, "delivered-once:ok", "delivered");
      const delivered = yield* seeded.requestOf;
      assert.deepInclude(delivered.delivery, { state: "delivered", attempts: 1 });
      assert.isUndefined(delivered.lost);
      for (const state of ["delivered", "not_delivered", "uncertain"] as const) {
        const late = yield* deliveryUpdate(seeded, `delivered-once:late-${state}`, state).pipe(
          Effect.flip,
        );
        assert.include(causeOf(late), "already delivered");
      }
      const closed = yield* providerClosed(seeded, "delivered-once:closed").pipe(Effect.flip);
      assert.include(causeOf(closed), "already resolved");
      assert.equal((yield* seeded.requestOf).delivery?.state, "delivered");
    }),
  );

  it.effect(
    "pending → not_delivered opens the request as lost so the user can ask again once",
    () =>
      Effect.gen(function* () {
        const seeded = yield* answered("not-delivered");
        yield* deliveryUpdate(seeded, "not-delivered:failed", "not_delivered");
        const lost = yield* seeded.requestOf;
        assert.deepInclude(lost.delivery, {
          state: "not_delivered",
          attempts: 1,
          reason: "The provider process was gone.",
        });
        assert.equal(lost.lost?.cause, "delivery_failed");
        // Nothing ran, so the loss is certain.
        assert.isUndefined(lost.lost?.deliveryUncertain);
        const late = yield* deliveryUpdate(seeded, "not-delivered:late", "delivered").pipe(
          Effect.flip,
        );
        assert.include(causeOf(late), "already not_delivered");

        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "runtime-request.ask-again",
          commandId: CommandId.make("not-delivered:ask-again"),
          threadId: seeded.threadId,
          requestIds: [seeded.requestId],
        });
        assert.isDefined((yield* seeded.requestOf).lost?.askedAgainAt);
        const projection = yield* projectionOf(seeded.threadId);
        assert.lengthOf(projection.runs, 1);
        assert.include(yield* queuedEffectTypes(seeded.threadId), "provider-turn.start");
        const twice = yield* orchestrator
          .dispatch({
            type: "runtime-request.ask-again",
            commandId: CommandId.make("not-delivered:ask-again-twice"),
            threadId: seeded.threadId,
            requestIds: [seeded.requestId],
          })
          .pipe(Effect.flip);
        assert.include(causeOf(twice), "already asked again or dismissed");
        assert.lengthOf((yield* projectionOf(seeded.threadId)).runs, 1);
      }),
  );

  it.effect("pending → uncertain says the answer may have reached the provider", () =>
    Effect.gen(function* () {
      const seeded = yield* answered("uncertain");
      yield* deliveryUpdate(seeded, "uncertain:once", "uncertain");
      const uncertain = yield* seeded.requestOf;
      assert.deepInclude(uncertain.delivery, { state: "uncertain", attempts: 1 });
      assert.deepInclude(uncertain.lost, { cause: "delivery_failed", deliveryUncertain: true });
      // A retry may still land; the attempt count says how many were made.
      yield* deliveryUpdate(seeded, "uncertain:retried", "delivered");
      const delivered = yield* seeded.requestOf;
      assert.deepInclude(delivered.delivery, { state: "delivered", attempts: 2 });
      // The loss stays as history but is closed: nothing offers Ask again for an
      // answer that arrived.
      assert.equal(delivered.lost?.cause, "delivery_failed");
      assert.isDefined(delivered.lost?.dismissedAt);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const askAgain = yield* orchestrator
        .dispatch({
          type: "runtime-request.ask-again",
          commandId: CommandId.make("uncertain:ask-again"),
          threadId: seeded.threadId,
          requestIds: [seeded.requestId],
        })
        .pipe(Effect.flip);
      assert.include(causeOf(askAgain), "already asked again or dismissed");
    }),
  );

  it.effect("a provider close on an answered request marks it not needed, keeping attempts", () =>
    Effect.gen(function* () {
      const seeded = yield* answered("closed-after-answer");
      yield* providerClosed(seeded, "closed-after-answer");
      const closed = yield* seeded.requestOf;
      assert.equal(closed.status, "resolved");
      assert.deepInclude(closed.delivery, { state: "not_needed", attempts: 0 });
      assert.isUndefined(closed.lost);
      // The choice stays on record; nothing answers it again.
      assert.equal(closed.chosen?.optionId, "once:0");
      const again = yield* respond({
        key: "closed-after-answer:again",
        ...seeded,
        decision: "accept",
      }).pipe(Effect.flip);
      assert.include(causeOf(again), "is resolved");
      const late = yield* deliveryUpdate(seeded, "closed-after-answer:late", "delivered").pipe(
        Effect.flip,
      );
      assert.include(causeOf(late), "already not_needed");
    }),
  );

  it.effect("a provider close on an unanswered request expires it and closes its card", () =>
    Effect.gen(function* () {
      yield* setSnapshots({});
      const seeded = yield* seedPendingApproval({
        name: "closed-unanswered",
        options: CLAUDE_LEGACY_OPTIONS,
      });
      // Delivery is for answers; an unanswered request has none to update.
      const early = yield* deliveryUpdate(seeded, "closed-unanswered:early", "delivered").pipe(
        Effect.flip,
      );
      assert.include(causeOf(early), "no answer awaiting delivery");
      yield* providerClosed(seeded, "closed-unanswered");
      const expired = yield* seeded.requestOf;
      assert.equal(expired.status, "expired");
      assert.isUndefined(expired.delivery);
      assert.isUndefined(expired.chosen);
      assert.equal((yield* seeded.nodeOf).status, "cancelled");
      assert.equal((yield* seeded.itemOf).status, "cancelled");
      // The user can no longer answer, and nothing is queued for the provider.
      const late = yield* respond({
        key: "closed-unanswered:late",
        ...seeded,
        decision: "accept",
      }).pipe(Effect.flip);
      assert.include(causeOf(late), "is expired");
      assert.deepEqual(yield* queuedResponds(seeded.threadId), []);
      const twice = yield* providerClosed(seeded, "closed-unanswered:twice").pipe(Effect.flip);
      assert.include(causeOf(twice), "already expired");
    }),
  );
});
