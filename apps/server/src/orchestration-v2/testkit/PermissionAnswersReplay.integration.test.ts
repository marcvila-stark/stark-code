/**
 * An approval answered end to end: the recorded Claude `tool_call_denied_write`
 * session asks to write a file, the answer goes through the orchestrator, the
 * effect worker and the adapter, and the replay checks the exact response
 * Claude receives. No new recording: the transcript is the one the fixture
 * suite already replays.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type ThreadId,
} from "@starkfuture/contracts";
import { claudeModelEnvironment } from "@starkfuture/shared/claudeModelPolicy";
import { PROVIDER_PRIVACY_ENV } from "@starkfuture/shared/providerPrivacy";
import { STARK_PAGES_ENV } from "@starkfuture/shared/starkPages";
import * as IdAllocator from "@starkfuture/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@starkfuture/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@starkfuture/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { DispatchSettingsWrite } from "../DispatchSettingsWrite.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";
import {
  DENIED_WRITE_POLICY,
  TOOL_CALL_DENIED_WRITE_PROMPT,
  TOOL_CALL_DENIED_WRITE_TARGET,
} from "./fixtures/tool_call_denied_write/input.ts";
import { causeOf } from "./PermissionTestkit.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/**
 * The recording predates the environment Stark now puts in every Claude
 * session's settings (helper model policy, privacy and Pages variables), which
 * makes every Claude replay fixture fail at `query.open` on this base. Only
 * that field is brought up to date; every other frame is compared as recorded.
 */
function withCurrentSettingsEnv(transcript: ProviderReplayTranscript): ProviderReplayTranscript {
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound" || entry.label !== "query.open") return entry;
      const frame = entry.frame as {
        readonly options: { readonly settings?: Record<string, unknown> };
      };
      return {
        ...entry,
        frame: {
          ...frame,
          options: {
            ...frame.options,
            settings: {
              ...frame.options.settings,
              env: claudeModelEnvironment({ ...PROVIDER_PRIVACY_ENV, ...STARK_PAGES_ENV }),
            },
          },
        },
      };
    }),
  };
}
const FIXTURE = "tool_call_denied_write";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))),
);

/**
 * Waits for the thread's projection to show `select`, the way the scenario
 * runner (`OrchestratorScenario`) waits on replays: the replay adapter feeds
 * recorded frames between polls, and a wait gives up only after both an
 * iteration budget and a wall-clock deadline are spent.
 */
const awaitProjection = <A>(
  threadId: ThreadId,
  label: string,
  select: (projection: OrchestrationV2ThreadProjection) => A | undefined,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const deadline = performance.now() + 60_000;
    for (let attempt = 0; ; attempt++) {
      const found = select(yield* orchestrator.getThreadProjection(threadId));
      if (found !== undefined) return found;
      if (attempt >= 10_000 && performance.now() >= deadline) {
        return yield* Effect.die(new Error(`Timed out waiting for ${label}.`));
      }
      yield* yieldToRuntime;
    }
  });

/**
 * The approval card a client answers from. The adapter emits the request,
 * then its card, and the orchestrator checks an answer against the card's
 * options, so a test answers only once the card is there.
 */
const pendingApprovalCard = (threadId: ThreadId) =>
  awaitProjection(threadId, "the approval card", (projection) => {
    const card = projection.turnItems.find(
      (item) => item.type === "approval_request" && item.status === "waiting",
    );
    return card?.type === "approval_request"
      ? projection.runtimeRequests.find((request) => request.id === card.requestId)
      : undefined;
  });

const runSettled = (threadId: ThreadId) =>
  awaitProjection(threadId, "the run to settle", (projection) =>
    projection.runs.find((run) =>
      ["completed", "failed", "interrupted", "cancelled"].includes(run.status),
    ),
  );

/**
 * Replays the denied-write session up to its permission request, then hands
 * the pending request to `answer`. The run must then finish as recorded.
 */
const replayDeniedWrite = <A, E, R>(
  name: string,
  answer: (input: {
    readonly threadId: ThreadId;
    readonly request: OrchestrationV2RuntimeRequest;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const raw = yield* readProviderReplayTranscript(
      new URL(`./fixtures/${FIXTURE}/claude_transcript.ndjson`, import.meta.url),
    ).pipe(Effect.provide(NodeServices.layer));
    const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
      withCurrentSettingsEnv(
        materializeReplayTranscriptRuntimeInstructions(raw, {
          driver: CLAUDE,
          model: CLAUDE_MODEL_SELECTION.model,
        }),
      ),
    );
    const workspace = yield* checkpointWorkspace(`${FIXTURE}-${name}`);
    const materialized = yield* materializeFixtureInput({
      scenario: FIXTURE,
      fixtureInput: { steps: [{ type: "message", text: TOOL_CALL_DENIED_WRITE_PROMPT }] },
      driver: CLAUDE,
      modelSelection: CLAUDE_MODEL_SELECTION,
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
    const [create, message] = materialized.commands as [
      Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
      Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    ];
    const threadId = create.threadId;
    const scenario = {
      name: `${FIXTURE}/permission-${name}`,
      transcript,
      commands: materialized.commands,
      runtimePolicyOverride: { ...DENIED_WRITE_POLICY, cwd: workspace },
    };
    const result = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch(create);
      yield* TestClock.adjust("1 millis");
      // The fixture suite dispatches a message that waits on an approval in the
      // background as well: its dispatch settles only after the answer.
      const sent = yield* orchestrator.dispatch(message).pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 millis");
      const request = yield* pendingApprovalCard(threadId);
      const answered = yield* answer({ threadId, request });
      yield* TestClock.adjust("1 millis");
      const run = yield* runSettled(threadId);
      yield* Fiber.join(sent);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      return { answered, run, projection };
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
      ),
      provideDeterministicTestRuntime,
      Effect.scoped,
    );
    // The recorded denial reached Claude, so the write never happened.
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    assert.isFalse(yield* fs.exists(path.join(workspace, TOOL_CALL_DENIED_WRITE_TARGET)));
    return { threadId, ...result };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("approval answers reach Claude exactly", () => {
  it.effect("an older client's plain Decline reaches Claude as the narrowest denial", () =>
    Effect.gen(function* () {
      const { run, projection } = yield* replayDeniedWrite(
        "older-client",
        ({ threadId, request }) =>
          Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
            orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("permission-older-client:decline"),
              threadId,
              requestId: request.id,
              decision: "decline",
            }),
          ),
      );
      assert.equal(run.status, "completed");
      const request = projection.runtimeRequests[0]!;
      assert.equal(request.status, "resolved");
      assert.equal(request.decision, "decline");
      // Decline, not Decline and stop: the run went on to Claude's reply.
      assert.equal(request.chosen?.optionId, "deny:0");
      assert.equal(request.chosen?.decision, "decline");
      // The effect worker reports that Claude took the answer.
      assert.equal(request.delivery?.state, "delivered");
    }),
  );

  it.effect("refused answers leave the request waiting until an offered option arrives", () =>
    Effect.gen(function* () {
      const refusals: Array<string> = [];
      const { run, projection } = yield* replayDeniedWrite("refusals", ({ threadId, request }) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const attempt = (
            key: string,
            answer: Partial<Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>>,
          ) =>
            orchestrator
              .dispatch({
                type: "runtime-request.respond",
                commandId: CommandId.make(`permission-refusals:${key}`),
                threadId,
                requestId: request.id,
                ...answer,
              })
              .pipe(
                Effect.flip,
                Effect.map((error) => refusals.push(`${key}: ${causeOf(error)}`)),
              );
          // An id the request never offered, an id with a contradicting
          // decision, a reason on Allow once, and a saved rule from a client
          // without settings-write. If any reached Claude, the replay would
          // fail on an unrecorded response.
          yield* attempt("unknown-id", { optionId: "session:9" });
          yield* attempt("mismatch", { optionId: "deny:0", decision: "accept" });
          yield* attempt("reason-on-allow", { optionId: "once:0", feedback: "Go ahead." });
          yield* attempt("always", { decision: "acceptAlways" }).pipe(
            Effect.provideService(DispatchSettingsWrite, false),
          );
          const still = (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests[0]!;
          assert.equal(still.status, "pending");
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("permission-refusals:deny"),
            threadId,
            requestId: request.id,
            optionId: "deny:0",
          });
          // A second answer to the same request is refused.
          yield* attempt("second-answer", { optionId: "once:0" });
        }),
      );
      assert.lengthOf(refusals, 5, refusals.join("\n"));
      assert.include(refusals[0], "no longer offered");
      assert.include(refusals[1], "does not match");
      assert.include(refusals[2], "does not send a reason");
      assert.match(refusals[3]!, /no longer offered|needs permission to change settings/);
      assert.include(refusals[4], "is resolved");
      assert.equal(run.status, "completed");
      assert.equal(projection.runtimeRequests[0]!.chosen?.optionId, "deny:0");
    }),
  );
});
