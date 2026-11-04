import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopUpdateRestartAck,
  DesktopUpdateRestartPrepareRequest,
} from "@starkfuture/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  DesktopRestartPreservation,
  DesktopRestartStorageFlushError,
  layerTest,
} from "./restartPreservation.ts";

const REQUEST: DesktopUpdateRestartPrepareRequest = { requestId: "restart-1", version: "1.2.4" };

const saved = (referencedAttachmentIds: ReadonlyArray<string> = []): DesktopUpdateRestartAck => ({
  requestId: REQUEST.requestId,
  outcome: "saved",
  blockers: [],
  referencedAttachmentIds,
});

function makeTransport(options: { readonly flushFails?: boolean } = {}) {
  const prepared: DesktopUpdateRestartPrepareRequest[] = [];
  const released: string[] = [];
  const closed = new Set<number>();
  let flushes = 0;
  return {
    prepared,
    released,
    closed,
    flushes: () => flushes,
    layer: (onPrepare?: () => void) =>
      Layer.merge(
        layerTest({
          broadcastPrepare: (request) =>
            Effect.sync(() => {
              prepared.push(request);
              onPrepare?.();
            }),
          broadcastRelease: (requestId) =>
            Effect.sync(() => {
              released.push(requestId);
            }),
          isAlive: (id) => !closed.has(id),
          flushStorage: () =>
            options.flushFails
              ? Effect.fail(new DesktopRestartStorageFlushError({ cause: new Error("disk") }))
              : Effect.sync(() => {
                  flushes += 1;
                }),
        }),
        TestClock.layer(),
      ),
  };
}

describe("DesktopRestartPreservation", () => {
  it.effect("saves when every registered window confirms, then flushes storage", () => {
    const transport = makeTransport();
    return Effect.gen(function* () {
      const preservation = yield* DesktopRestartPreservation;
      yield* preservation.setParticipant(1, true);
      yield* preservation.setParticipant(2, true);
      const result = yield* preservation.preserve(REQUEST).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(transport.prepared, [REQUEST]);

      yield* preservation.acknowledge(1, saved(["upload-a"]));
      yield* preservation.acknowledge(2, {
        ...saved(["upload-b", "upload-a"]),
        draftsJson: '{"version":9}',
        stashJson: '{"version":2}',
      });
      const outcome = yield* Fiber.join(result);
      assert.equal(outcome._tag, "Saved");
      // The windows share one storage; the copy one of them sent goes to the backup.
      assert.equal(outcome._tag === "Saved" && outcome.draftsJson, '{"version":9}');
      assert.equal(outcome._tag === "Saved" && outcome.stashJson, '{"version":2}');
      assert.sameMembers(outcome._tag === "Saved" ? [...outcome.referencedAttachmentIds] : [], [
        "upload-a",
        "upload-b",
      ]);
      assert.equal(transport.flushes(), 1);
    }).pipe(Effect.provide(transport.layer()));
  });

  it.effect("aborts when a window does not answer in time", () => {
    const transport = makeTransport();
    return Effect.gen(function* () {
      const preservation = yield* DesktopRestartPreservation;
      yield* preservation.setParticipant(1, true);
      yield* preservation.setParticipant(2, true);
      const result = yield* preservation.preserve(REQUEST).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* preservation.acknowledge(1, saved());
      yield* TestClock.adjust(Duration.seconds(10));

      const outcome = yield* Fiber.join(result);
      assert.deepEqual(outcome, {
        _tag: "Failed",
        blockers: [
          {
            kind: "window-unresponsive",
            message: "A window didn't confirm its drafts were saved.",
            count: 1,
          },
        ],
      });
      assert.equal(transport.flushes(), 0);
    }).pipe(Effect.provide(transport.layer()));
  });

  it.effect("aborts with the window's reasons when it could not save", () => {
    const transport = makeTransport();
    return Effect.gen(function* () {
      const preservation = yield* DesktopRestartPreservation;
      yield* preservation.setParticipant(1, true);
      const result = yield* preservation.preserve(REQUEST).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* preservation.acknowledge(1, {
        requestId: REQUEST.requestId,
        outcome: "failed",
        blockers: [{ kind: "upload-in-progress", message: "A file is uploading.", count: 2 }],
        referencedAttachmentIds: [],
      });
      const outcome = yield* Fiber.join(result);
      assert.equal(outcome._tag, "Failed");
      assert.deepEqual(outcome._tag === "Failed" ? outcome.blockers : [], [
        { kind: "upload-in-progress", message: "A file is uploading.", count: 2 },
      ]);
    }).pipe(Effect.provide(transport.layer()));
  });

  it.effect("ignores answers to another request and from unregistered windows", () => {
    const transport = makeTransport();
    return Effect.gen(function* () {
      const preservation = yield* DesktopRestartPreservation;
      yield* preservation.setParticipant(1, true);
      const result = yield* preservation.preserve(REQUEST).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* preservation.acknowledge(1, { ...saved(), requestId: "restart-0" });
      yield* preservation.acknowledge(9, saved());
      yield* TestClock.adjust(Duration.seconds(10));
      assert.equal((yield* Fiber.join(result))._tag, "Failed");
    }).pipe(Effect.provide(transport.layer()));
  });

  it.effect("fails when the saved storage cannot be written to disk", () => {
    const transport = makeTransport({ flushFails: true });
    return Effect.gen(function* () {
      const preservation = yield* DesktopRestartPreservation;
      const outcome = yield* preservation.preserve(REQUEST);
      assert.deepEqual(outcome, {
        _tag: "Failed",
        blockers: [{ kind: "storage-failed", message: "Drafts couldn't be written to disk." }],
      });
    }).pipe(Effect.provide(transport.layer()));
  });

  it.effect("waits only for windows that are still open and still listening", () => {
    const transport = makeTransport();
    return Effect.gen(function* () {
      const preservation = yield* DesktopRestartPreservation;
      yield* preservation.setParticipant(1, true);
      yield* preservation.setParticipant(2, true);
      yield* preservation.setParticipant(3, true);
      yield* preservation.setParticipant(2, false);
      transport.closed.add(3);
      const result = yield* preservation.preserve(REQUEST).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* preservation.acknowledge(1, saved());
      assert.equal((yield* Fiber.join(result))._tag, "Saved");

      yield* preservation.release(REQUEST.requestId);
      assert.deepEqual(transport.released, [REQUEST.requestId]);
    }).pipe(Effect.provide(transport.layer()));
  });
});
