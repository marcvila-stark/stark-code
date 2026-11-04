import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, HARNESS_FEED, makeHarness } from "./updatesTestHarness.ts";
import * as UpdateSeams from "./updateSeams.ts";
import { describeDisabledUpdates } from "./updateFeedGate.ts";

describe("DesktopUpdates", () => {
  it("preserves complete causes for update poller and event failures", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("updater failed")),
      Cause.die(new Error("updater defect")),
    );
    const pollerError = new DesktopUpdates.DesktopUpdatePollerError({
      poller: "startup",
      cause,
    });
    const eventError = new DesktopUpdates.DesktopUpdateEventHandlingError({
      event: "download-progress",
      cause,
    });
    const reportedError = new DesktopUpdates.DesktopUpdaterReportedError({
      operation: "download",
      cause,
    });
    const unexpectedActionError = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
      action: "install",
      cause,
    });

    assert.strictEqual(pollerError.cause, cause);
    assert.equal(pollerError.poller, "startup");
    assert.equal(pollerError.message, "Desktop update startup poller failed.");
    assert.strictEqual(eventError.cause, cause);
    assert.equal(eventError.event, "download-progress");
    assert.equal(eventError.message, "Failed to handle desktop update download-progress event.");
    assert.strictEqual(reportedError.cause, cause);
    assert.equal(reportedError.operation, "download");
    assert.equal(reportedError.message, "Desktop updater download operation reported an error.");
    assert.strictEqual(unexpectedActionError.cause, cause);
    assert.equal(unexpectedActionError.action, "install");
    assert.equal(
      unexpectedActionError.message,
      "Desktop update install action failed unexpectedly.",
    );
  });

  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.deepEqual(harness.feedUrls(), [HARNESS_FEED]);
          assert.equal(harness.listenerCount(), 6);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps updates off outside the packaged macOS app, whatever the feed says", () =>
    Effect.gen(function* () {
      const configuredState = (harness: ReturnType<typeof makeHarness>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            assert.equal(harness.listenerCount(), 0);
            assert.deepEqual(harness.feedUrls(), []);
            return yield* updates.getState;
          }),
        ).pipe(Effect.provide(harness.layer));

      const linux = yield* configuredState(makeHarness({ platform: "linux" }));
      assert.equal(linux.status, "disabled");
      assert.equal(linux.disabledReason?.code, "unsupported-platform");

      const development = yield* configuredState(
        makeHarness({ env: { VITE_DEV_SERVER_URL: "http://localhost:5733" } }),
      );
      assert.equal(development.status, "disabled");
      assert.equal(development.disabledReason?.code, "development-build");
    }),
  );

  it.effect("subscribe delivers the latest state plus subsequent changes", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const { latest, changes } = yield* updates.subscribe;
        assert.equal(latest.status, "idle");

        const nextState = yield* Stream.runHead(changes).pipe(Effect.forkChild);
        yield* flushCallbacks;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const observed = yield* Fiber.join(nextState);
        assert.equal(Option.getOrThrow(observed).status, "available");
        assert.equal(Option.getOrThrow(observed).availableVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("enables nightly full changelog release notes and broadcasts summaries", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.setChannel("nightly");
        assert.equal(harness.fullChangelog(), true);
        assert.isFalse(harness.allowDowngrade());

        harness.emit("update-available", {
          version: "1.2.4-nightly.20260709.766",
          releaseNotes: [
            {
              version: "1.2.4-nightly.20260709.766",
              note: `<h2>What's Changed</h2><ul><li>feat(client): persist offline environment data by <a>@juliusmarminge</a> in <a>#3795</a></li></ul><h2>Full Changelog</h2>`,
            },
            {
              version: "1.2.4-nightly.20260709.765",
              note: "- [codex] Upgrade Clerk stack by @juliusmarminge in #3821",
            },
            { version: "1.2.4-nightly.20260709.764", note: "- Change 764" },
            { version: "1.2.4-nightly.20260709.763", note: "- Change 763" },
            { version: "1.2.4-nightly.20260709.762", note: "- Change 762" },
            { version: "1.2.4-nightly.20260709.761", note: "- Change 761" },
            { version: "1.2.4-nightly.20260709.760", note: "- Change 760" },
          ],
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "1.2.4-nightly.20260709.766",
            items: ["feat(client): persist offline environment data by @juliusmarminge in #3795"],
            totalItems: 1,
          },
          {
            version: "1.2.4-nightly.20260709.765",
            items: ["[codex] Upgrade Clerk stack by @juliusmarminge in #3821"],
            totalItems: 1,
          },
          { version: "1.2.4-nightly.20260709.764", items: ["Change 764"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.763", items: ["Change 763"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.762", items: ["Change 762"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.761", items: ["Change 761"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 1);
        assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
        assert.equal(harness.sentStates.at(-1)?.omittedReleaseCount, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("checks for newer releases after an update has been downloaded", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.check("poll");
        assert.isTrue(result.checked);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const unchangedState = yield* updates.getState;
        assert.equal(unchangedState.status, "downloaded");
        assert.equal(unchangedState.downloadedVersion, "1.2.4");
        assert.deepEqual(unchangedState.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(unchangedState.omittedReleaseCount, 0);

        const nextResult = yield* updates.check("poll");
        assert.isTrue(nextResult.checked);

        harness.emit("update-available", { version: "1.2.5" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.5");
        assert.isNull(state.downloadedVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed has no update", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-not-available");
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed offers another channel", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-available", { version: "1.2.5-nightly.20260710.1" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "rejects install while a refresh check is in progress and releases the reservation",
    () =>
      Effect.gen(function* () {
        const checkStarted = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const harness = makeHarness({
          checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCheck)),
          ),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;

            const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
            yield* Deferred.await(checkStarted);

            const installResult = yield* updates.install;
            assert.isFalse(installResult.accepted);

            yield* Deferred.succeed(releaseCheck, undefined);
            const checkResult = yield* Fiber.join(checkFiber);
            assert.isTrue(checkResult.checked);

            const followUpCheck = yield* updates.check("manual");
            assert.isTrue(followUpCheck.checked);
            assert.equal(harness.checkCount(), 2);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("rejects refresh checks while install is in progress", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(installStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInstall)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(installStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseInstall, undefined);
          const installResult = yield* Fiber.join(installFiber);
          assert.isTrue(installResult.accepted);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps raw updater event failures out of update state", () => {
    const harness = makeHarness();
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.errorKind, "unknown");
        assert.equal(state.message, "Couldn't check for updates.");
        assert.notInclude(JSON.stringify(state), "secret");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer after a background updater error", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        harness.emit("error", new Error("background updater failure"));
        yield* flushCallbacks;

        // A background failure never hides the ready update.
        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.isNull(state.errorContext);
        assert.equal(state.lastCheckError?.kind, "unknown");

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs the redacted cause of a rejected update check", () => {
    const cause = Object.assign(
      new Error("request failed for https://user:secret@example.com/update?token=secret"),
      { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
    );
    const updaterError = new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "ElectronUpdaterCheckForUpdatesError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "ElectronUpdaterCheckForUpdatesError");
        assert.isNull(loggedAnnotation.channel);
        assert.equal(
          loggedAnnotation.cause,
          "Error [ERR_UPDATER_LATEST_VERSION_NOT_FOUND]: request failed for [redacted URL]",
        );
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(state.errorKind, "feed-unavailable");
        assert.equal(state.message, "The update server returned an error.");
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("logs the redacted cause of an updater error event", () => {
    const harness = makeHarness();
    const cause = Object.assign(new Error("404 Not Found\nHeaders: authorization=secret"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "DesktopUpdaterReportedError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.operation, "background");
        assert.equal(
          loggedAnnotation.cause,
          "Error [ERR_UPDATER_CHANNEL_FILE_NOT_FOUND]: 404 Not Found",
        );
        assert.notInclude(JSON.stringify(loggedAnnotations), "secret");
        const state = yield* updates.getState;
        assert.equal(state.errorKind, "feed-unavailable");
        assert.equal(state.message, "The update server returned an error.");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      setDisableDifferentialDownload: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return disableDifferentialCalls === 1
          ? Effect.void
          : Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Couldn't download 1.2.4.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        setDisableDifferentialDownload: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            return Effect.void;
          }
          if (disableDifferentialCalls === 2) {
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.isNull(interruptedState.message);

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("clears quitting state after an unexpected install setup failure", () => {
    const harness = makeHarness({
      stopBackend: Effect.die(new Error("backend stop failed")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Couldn't install 1.2.4. Stark Code kept running.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("marks the backend stop for an install as an update restart", () => {
    let markersAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        markersAtStop = [...harness.updateRestartMarkers];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(markersAtStop, [
          environment.path.join(environment.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE),
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("records the version an install hands to the installer", () => {
    let recordsAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        recordsAtStop = [...harness.installRecords.values()];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(
          recordsAtStop.map((record) => JSON.parse(record)),
          [{ fromVersion: "1.2.3", targetVersion: "1.2.4" }],
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("flags an install that did not apply and keeps the flag through checks", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
        // Kept, so the next start on 1.2.3 still knows 1.2.4 did not apply.
        assert.isDefined(harness.previousInstallRecord());

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.notAppliedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  const failedUpdate = (failedVersion: string) =>
    JSON.stringify({
      version: 1,
      failedVersion,
      reason: "migration-failed",
      fromVersion: "1.2.3",
      recordedAt: "2026-10-31T08:08:00.000Z",
    });

  it.effect("does not offer a version that failed on this data until the user checks", () => {
    const harness = makeHarness({ failedUpdate: failedUpdate("1.2.4") });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("poll");
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        const skipped = yield* updates.getState;
        assert.equal(skipped.status, "up-to-date");
        assert.equal(skipped.skippedVersion, "1.2.4");
        assert.isNull(skipped.availableVersion);
        assert.equal(harness.downloadCount(), 0);

        // The user asks: the failed version is offered, and the record stays.
        yield* updates.check("web-ui");
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        const offered = yield* updates.getState;
        assert.equal(offered.status, "available");
        assert.equal(offered.availableVersion, "1.2.4");
        assert.isUndefined(offered.skippedVersion);
        assert.isDefined(harness.failedUpdate());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offers a newer version than the failed one and forgets the failure", () => {
    const harness = makeHarness({ failedUpdate: failedUpdate("1.2.4") });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("poll");
        harness.emit("update-available", { version: "1.2.5" });
        yield* flushCallbacks;

        assert.equal((yield* updates.getState).availableVersion, "1.2.5");
        assert.isUndefined(harness.failedUpdate());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("forgets a failed version this app is already newer than", () => {
    const harness = makeHarness({ failedUpdate: failedUpdate("1.2.2") });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isUndefined(harness.failedUpdate());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not flag an install that applied", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isUndefined((yield* updates.getState).notAppliedVersion);
        assert.isUndefined(harness.previousInstallRecord());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("drops the update restart marker when an install is interrupted", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(stopping);
          assert.equal(harness.updateRestartMarkers.size, 1);

          yield* Fiber.interrupt(installFiber);
          assert.equal(harness.updateRestartMarkers.size, 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps windows and restarts backends when the installer rejects the update", () => {
    const harness = makeHarness({
      nativeInstaller: "error",
      nativeError: new Error("Code signature at URL did not pass validation"),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, [
          "prepare",
          "preserve",
          "quiesce",
          "stopBackend",
          "nativeStage",
          "releaseGate",
          "releasePreservation",
          "startBackend",
        ]);
        assert.equal(harness.quitAndInstalls(), 0);
        // A rejected signature drops the download; the next try downloads again.
        assert.equal(result.state.status, "available");
        assert.equal(result.state.errorKind, "signature");
        assert.isNull(result.state.downloadedVersion);
        // The restarted old backend must release its tunnel on a later quit.
        assert.equal(harness.updateRestartMarkers.size, 0);
        // The app never quit, so the next start must not report an unapplied install.
        assert.equal(harness.installRecords.size, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("holds the install reservation until failed-install recovery finishes", () => {
    const recoveryStarted = Deferred.makeUnsafe<void>();
    const releaseRecovery = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      nativeInstaller: "error",
      nativeError: new Error("installer busy"),
      startBackend: Deferred.succeed(recoveryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRecovery)),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const failedInstall = yield* updates.install.pipe(Effect.forkChild);
        yield* Deferred.await(recoveryStarted);
        assert.isFalse(yield* updates.isInstallActive);

        const overlappingInstall = yield* updates.install;
        assert.isFalse(overlappingInstall.accepted);
        harness.emit("error", new Error("duplicate native installer error"));
        yield* flushCallbacks;
        assert.equal(harness.installSteps.filter((step) => step === "nativeStage").length, 1);
        assert.equal(harness.installSteps.filter((step) => step === "startBackend").length, 1);

        yield* Deferred.succeed(releaseRecovery, undefined);
        const failedResult = yield* Fiber.join(failedInstall);
        assert.equal(failedResult.state.errorContext, "install");
        assert.equal(failedResult.state.status, "downloaded");

        const retry = yield* updates.install;
        assert.isTrue(retry.accepted);
        assert.equal(harness.installSteps.filter((step) => step === "nativeStage").length, 2);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("recovers when the installer reports failure through an updater event", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      const harness = makeHarness({
        nativeInstaller: "silent",
        stopBackend: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const install = yield* updates.install.pipe(Effect.forkChild);
          yield* Deferred.await(stopped);
          harness.emit("error", new Error("native installer refused"));
          yield* flushCallbacks;
          yield* Fiber.join(install);

          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.include(harness.installSteps, "startBackend");
          assert.equal((yield* updates.getState).errorContext, "install");

          // Recovery withdrew the request: a late acceptance never quits.
          harness.nativeStage();
          assert.equal(harness.quitAndInstalls(), 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects a prepared install when the downloaded version changed", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;

        const result = yield* updates.installPrepared("1.2.4");
        assert.isFalse(result.accepted);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offers only enabled channels and never switches to a hidden one", () => {
    const harness = makeHarness({ availableChannels: ["latest"] });

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        assert.deepEqual((yield* updates.getState).availableChannels, ["latest"]);
        const state = yield* updates.setChannel("nightly");
        assert.equal(state.channel, "latest");
        assert.equal((yield* settings.get).updateChannel, "latest");
        assert.isFalse((yield* settings.get).updateChannelConfiguredByUser);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("fails channel changes with a typed error while a check is in progress", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const exit = yield* Effect.exit(updates.setChannel("nightly"));
          assert.equal(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const error = Cause.squash(exit.cause);
            assert.instanceOf(error, DesktopUpdates.DesktopUpdateActionInProgressError);
            assert.equal(error.action, "check");
            assert.equal(error.requestedChannel, "nightly");
          }

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects checks while an update channel change is being persisted", () =>
    Effect.gen(function* () {
      const channelChangeStarted = yield* Deferred.make<void>();
      const releaseChannelChange = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Deferred.succeed(channelChangeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseChannelChange)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.await(channelChangeStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseChannelChange, undefined);
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
          assert.equal(harness.checkCount(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves settings failure context when an update channel cannot be persisted", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/settings.json",
      cause: diskFailure,
    });
    const harness = makeHarness({ setUpdateChannelError: settingsFailure });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);

        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        assert.equal(error.channel, "nightly");
        assert.strictEqual(error.cause, settingsFailure);
        assert.strictEqual(error.cause.cause, diskFailure);
        assert.equal(error.message, "Failed to persist the nightly desktop update channel.");
        assert.notInclude(error.message, diskFailure.message);

        const checkResult = yield* updates.check("manual");
        assert.isTrue(checkResult.checked);
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

const networkFailure = (code: string) =>
  new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
    channel: "latest",
    cause: Object.assign(new Error(`getaddrinfo ${code} updates.example.com`), { code }),
  });

const downloadFailure = (code: string) =>
  new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
    channel: "latest",
    cause: Object.assign(new Error(`download failed: ${code}`), { code }),
  });

const withHarness = (
  harness: ReturnType<typeof makeHarness>,
  body: Effect.Effect<
    void,
    never,
    DesktopUpdates.DesktopUpdates | DesktopState.DesktopState | Scope.Scope
  >,
) => Effect.scoped(body).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));

const configureWithDownload = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  yield* updates.configure;
  return updates;
});

/** What a build with a valid feed says while the owner has not switched updates on. */
const NOT_ACTIVATED = describeDisabledUpdates("not-activated");

describe("DesktopUpdates states", () => {
  it.effect("reports why updates are off instead of claiming to be up to date", () => {
    const harness = makeHarness({ feedDisabled: NOT_ACTIVATED });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        const state = yield* updates.getState;
        assert.equal(state.status, "disabled");
        assert.deepEqual(state.disabledReason, NOT_ACTIVATED);
        assert.deepEqual(harness.feedUrls(), []);
        assert.equal(harness.listenerCount(), 0);
        assert.deepEqual(yield* updates.disabledReason, Option.some(NOT_ACTIVATED.message));

        const result = yield* updates.check("menu");
        assert.isFalse(result.checked);
        assert.equal(result.state.status, "disabled");
        assert.equal(harness.checkCount(), 0);
        yield* TestClock.adjust(Duration.hours(2));
        assert.equal(harness.checkCount(), 0);
      }),
    );
  });

  it.effect("keeps an available update and its notes when a background poll fails", () => {
    let failChecks = false;
    const harness = makeHarness({
      checkForUpdates: Effect.suspend(() =>
        failChecks ? Effect.fail(networkFailure("ENOTFOUND")) : Effect.void,
      ),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: kept notes",
        });
        yield* flushCallbacks;

        failChecks = true;
        const statusesDuringPoll: string[] = [];
        const before = harness.sentStates.length;
        yield* updates.check("poll");
        for (const sent of harness.sentStates.slice(before)) statusesDuringPoll.push(sent.status);

        const state = yield* updates.getState;
        assert.notInclude(statusesDuringPoll, "checking");
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: kept notes"], totalItems: 1 },
        ]);
        assert.isNull(state.message);
        assert.equal(state.lastCheckError?.kind, "unreachable");
      }),
    );
  });

  it.effect("says offline only when the machine reports no network", () =>
    Effect.gen(function* () {
      const manualCheck = (isOnline: boolean) => {
        const harness = makeHarness({
          isOnline,
          checkForUpdates: Effect.fail(networkFailure("ENOTFOUND")),
        });
        return Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          return (yield* updates.check("menu")).state;
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      };

      const online = yield* manualCheck(true);
      assert.equal(online.status, "error");
      assert.equal(online.errorKind, "unreachable");
      assert.equal(online.message, "Couldn't reach the update server.");

      const offline = yield* manualCheck(false);
      assert.equal(offline.errorKind, "offline");
      assert.equal(
        offline.message,
        "You're offline. Stark Code checks again when you're back online.",
      );
    }),
  );

  it.effect("downloads in the background once a check finds an update", () => {
    let harness: ReturnType<typeof makeHarness>;
    harness = makeHarness({
      checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        yield* TestClock.adjust(Duration.seconds(15));
        yield* flushCallbacks;
        assert.equal(harness.checkCount(), 1);
        assert.equal(harness.downloadCount(), 1);
        assert.equal((yield* updates.getState).status, "downloading");

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).status, "downloaded");
      }),
    );
  });

  it.effect("retries a failed download with backoff, then stops", () => {
    const harness = makeHarness({ downloadUpdate: Effect.fail(downloadFailure("ECONNRESET")) });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.equal(result.state.status, "available");
        assert.equal(result.state.errorKind, "unreachable");
        assert.equal(result.state.downloadRetry?.attempt, 1);
        assert.equal(result.state.message, "Couldn't reach the update server to download 1.2.4.");

        for (const [delay, attempts] of [
          [30, 2],
          [120, 3],
          [600, 4],
        ] as const) {
          yield* TestClock.adjust(Duration.seconds(delay));
          yield* flushCallbacks;
          assert.equal(harness.downloadCount(), attempts);
        }
        const exhausted = yield* updates.getState;
        assert.isUndefined(exhausted.downloadRetry);
        assert.isTrue(exhausted.canRetry);
        yield* TestClock.adjust(Duration.minutes(30));
        assert.equal(harness.downloadCount(), 4);
      }),
    );
  });

  it.effect("does not retry a download that ran out of disk space", () => {
    const harness = makeHarness({ downloadUpdate: Effect.fail(downloadFailure("ENOSPC")) });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const { state } = yield* updates.download;
        assert.equal(state.errorKind, "disk-full");
        assert.equal(state.message, "Not enough disk space to download 1.2.4.");
        assert.isUndefined(state.downloadRetry);
        // Past every backoff delay, before the next hourly check.
        yield* TestClock.adjust(Duration.minutes(30));
        assert.equal(harness.downloadCount(), 1);
      }),
    );
  });

  it.effect("cancels a download and ignores the transfer's late completion", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = makeHarness({
        downloadUpdate: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* withHarness(
        harness,
        Effect.gen(function* () {
          const updates = yield* configureWithDownload;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const download = yield* updates.download.pipe(Effect.forkChild);
          yield* Deferred.await(started);
          assert.equal((yield* updates.getState).status, "downloading");

          const cancelled = yield* updates.cancelDownload;
          assert.isTrue(cancelled.accepted);
          assert.equal(cancelled.state.status, "available");
          const downloadResult = yield* Fiber.join(download);
          assert.isFalse(downloadResult.completed);

          harness.emit("download-progress", { percent: 80 });
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const state = yield* updates.getState;
          assert.equal(state.status, "available");
          assert.isNull(state.downloadedVersion);

          // A cancelled version is not downloaded again in the background.
          yield* updates.check("poll");
          assert.equal(harness.downloadCount(), 1);
        }),
      );
    }),
  );

  it.effect("offers a restart only for a download that passed its signature check", () => {
    const harness = makeHarness({
      verify: Effect.succeed({
        _tag: "Rejected",
        kind: "signature",
        detail: "team identifier mismatch",
      }),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.errorKind, "signature");
        assert.isNull(state.downloadedVersion);
        assert.equal(
          state.message,
          "The download for 1.2.4 isn't signed by Stark Future, so it was deleted.",
        );
        assert.isFalse((yield* updates.install).accepted);
        assert.deepEqual(harness.installSteps, []);
      }),
    );
  });

  it.effect("checks every precondition before stopping anything, in order", () => {
    const harness = makeHarness();
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.equal(result.state.status, "restarting");
        assert.deepEqual(harness.installSteps, [
          "prepare",
          "preserve",
          "quiesce",
          "stopBackend",
          "nativeStage",
          "nativeInstall",
        ]);
        assert.equal(harness.preserveRequests[0]?.version, "1.2.4");
        assert.deepEqual(harness.quiesceRequests[0]?.referencedAttachmentIds, ["draft-upload"]);
        assert.equal(harness.quitAndInstalls(), 1);
        assert.equal(harness.electronQuitAndInstalls(), 0);
      }),
    );
  });

  it.effect("refuses to restart while a server reports work, and stops nothing", () => {
    const harness = makeHarness({
      installGate: () =>
        Effect.succeed({
          _tag: "Blocked",
          blockers: [
            { kind: "active-task", message: "Tasks are running.", count: 2 },
            { kind: "pending-approval", message: "A task needs approval.", count: 1 },
          ],
        }),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* configureWithDownload;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isFalse(result.accepted);
        assert.equal(result.state.status, "downloaded");
        assert.equal(result.state.installBlockers?.length, 2);
        assert.equal(
          result.state.message,
          "Stark Code can't restart yet: 2 tasks are running and 1 task is waiting for your approval.",
        );
        assert.deepEqual(harness.installSteps, ["prepare", "releaseGate", "releasePreservation"]);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.equal(harness.quitAndInstalls(), 0);

        // The update stays ready; nothing offers a way to restart anyway.
        assert.isFalse(yield* updates.isActionActive);
      }),
    );
  });

  it.effect("aborts the restart when a window does not confirm its drafts were saved", () => {
    const harness = makeHarness({
      preserve: () =>
        Effect.succeed({
          _tag: "Failed",
          blockers: [
            {
              kind: "window-unresponsive",
              message: "A window didn't confirm its drafts were saved.",
              count: 1,
            },
          ],
        }),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isFalse(result.accepted);
        assert.equal(result.state.installBlockers?.[0]?.kind, "window-unresponsive");
        assert.deepEqual(harness.installSteps, [
          "prepare",
          "preserve",
          "releaseGate",
          "releasePreservation",
        ]);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("checks the download again at restart and drops it if it no longer passes", () => {
    let verifications = 0;
    const harness = makeHarness({
      verify: Effect.suspend(() => {
        verifications += 1;
        return Effect.succeed<UpdateSeams.DesktopUpdateArtifactVerdict>(
          verifications === 1
            ? { _tag: "Verified" }
            : { _tag: "Rejected", kind: "invalid-artifact", detail: "sha256 changed" },
        );
      }),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-available", { version: "1.2.4" });
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).status, "downloaded");

        const result = yield* updates.install;
        assert.equal(result.state.status, "available");
        assert.equal(result.state.errorKind, "invalid-artifact");
        assert.deepEqual(harness.installSteps, ["releaseGate", "releasePreservation"]);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("checks the same downloaded ZIP when it arrives and again before the restart", () => {
    const harness = makeHarness();
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-downloaded", {
          version: "1.2.4",
          downloadedFile: "/cache/pending/Stark-Code-1.2.4-arm64.zip",
        });
        yield* flushCallbacks;
        yield* updates.install;
        assert.deepEqual(harness.verifyRequests, [
          { version: "1.2.4", downloadedFile: "/cache/pending/Stark-Code-1.2.4-arm64.zip" },
          { version: "1.2.4", downloadedFile: "/cache/pending/Stark-Code-1.2.4-arm64.zip" },
        ]);
      }),
    );
  });

  it.effect("reports a failed backup in its outcome's words and installs nothing", () => {
    const harness = makeHarness({
      quiesce: Effect.succeed({
        _tag: "Failed",
        kind: "disk-full",
        message:
          "There is not enough free disk space to back up your data, so the update did not install. Your tasks were restarted.",
      }),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const result = yield* updates.install;
        assert.equal(result.state.errorKind, "disk-full");
        assert.equal(
          result.state.message,
          "There is not enough free disk space to back up your data, so the update did not install. Your tasks were restarted.",
        );
        assert.deepEqual(harness.installSteps, [
          "prepare",
          "preserve",
          "quiesce",
          "releaseGate",
          "releasePreservation",
        ]);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("stops nothing when the servers cannot drain or back up", () => {
    const harness = makeHarness({
      quiesce: Effect.succeed({
        _tag: "Blocked",
        blockers: [{ kind: "backend-busy", message: "A server is busy." }],
      }),
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const result = yield* updates.install;
        assert.isFalse(result.accepted);
        assert.equal(
          result.state.message,
          "Stark Code can't restart yet: a Stark server is still busy.",
        );
        assert.deepEqual(harness.installSteps, [
          "prepare",
          "preserve",
          "quiesce",
          "releaseGate",
          "releasePreservation",
        ]);
      }),
    );
  });

  it.effect("resumes when the installer never answers and never quits for it afterwards", () => {
    const staged = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      nativeInstaller: "silent",
      onNativeStage: () => {
        Deferred.doneUnsafe(staged, Effect.void);
      },
    });
    return withHarness(
      harness,
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* configureWithDownload;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const install = yield* updates.install.pipe(Effect.forkChild);
        yield* Deferred.await(staged);
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(60));
        const result = yield* Fiber.join(install);

        assert.equal(result.state.status, "downloaded");
        assert.equal(result.state.errorKind, "install-stalled");
        assert.include(harness.installSteps, "startBackend");
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        // The installer finishes late: recorded, never acted on.
        harness.nativeStage();
        yield* flushCallbacks;
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal((yield* updates.getState).stagedVersion, "1.2.4");
      }),
    );
  });

  it.effect("never allows a downgrade, also across channel changes", () => {
    const harness = makeHarness();
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        assert.isFalse(harness.allowDowngrade());
        yield* updates.setChannel("nightly").pipe(Effect.orDie);
        assert.isFalse(harness.allowDowngrade());
        yield* updates.setChannel("latest").pipe(Effect.orDie);
        assert.isFalse(harness.allowDowngrade());
      }),
    );
  });

  it.effect("postpones a ready update until undone or a newer one is ready", () => {
    const harness = makeHarness();
    return withHarness(
      harness,
      Effect.gen(function* () {
        const updates = yield* configureWithDownload;
        assert.isUndefined((yield* updates.setPostponed(true)).postponedUntil);

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const postponed = yield* updates.setPostponed(true);
        assert.equal(postponed.postponedUntil, "1970-01-02T00:00:00.000Z");
        assert.equal(postponed.status, "downloaded");
        assert.isUndefined((yield* updates.setPostponed(false)).postponedUntil);

        yield* updates.setPostponed(true);
        harness.emit("update-available", { version: "1.2.5" });
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;
        assert.isUndefined((yield* updates.getState).postponedUntil);
      }),
    );
  });
});

describe("describeUpdateErrorCause", () => {
  it("preserves network and nested failure reasons", () => {
    const networkError = Object.assign(new Error("getaddrinfo ENOTFOUND updates.example.com"), {
      code: "ENOTFOUND",
    });
    const cause = new Error("fetch failed", { cause: networkError });

    assert.equal(
      DesktopUpdates.describeUpdateErrorCause(Cause.fail(cause)),
      "Error: fetch failed; caused by Error [ENOTFOUND]: getaddrinfo ENOTFOUND updates.example.com",
    );
    assert.include(DesktopUpdates.describeUpdateErrorCause(Cause.die(networkError)), "[ENOTFOUND]");
  });

  it("removes URLs, credentials, response bodies, and headers from summaries", () => {
    const messages = [
      "Cannot download https://user:url-secret@example.com/update?token=query-secret, status 403",
      "Request failed: Bearer bearer-secret",
      "Request failed: Basic basic-secret",
      "Request failed: Authorization: Bearer header-secret",
      "Request failed: Cookie=session-secret",
      "Request failed: api_key=\"key-secret\" password='password-secret' access_token=token-secret",
      '404 Not Found\n{"body":"body-secret"}\nHeaders: cookie=header-secret',
      "Request failed\rHeaders: cookie=header-secret",
    ];

    for (const message of messages) {
      const summary = DesktopUpdates.describeUpdateErrorCause(new Error(message));
      assert.include(summary, "Error:");
      assert.notInclude(summary, "secret");
      assert.notInclude(summary, "https://");
      assert.notInclude(summary, "Headers:");
    }
    assert.equal(
      DesktopUpdates.describeUpdateErrorCause("404 Not Found\nbody-secret"),
      "404 Not Found",
    );
  });

  it("bounds long messages, parallel failures, and cyclic causes", () => {
    const longError = new Error("x".repeat(10_000));
    const parallel = Cause.combine(Cause.fail(longError), Cause.die(longError));
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(parallel).length, 1024);

    const cyclic = new Error("retry failed");
    cyclic.cause = cyclic;
    assert.include(DesktopUpdates.describeUpdateErrorCause(cyclic), "[truncated cause]");
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(cyclic).length, 1024);
  });

  it("does not serialize arbitrary payloads or let unreadable errors break logging", () => {
    assert.equal(DesktopUpdates.describeUpdateErrorCause({ payload: "secret" }), "object");
    const unreadable = Object.defineProperty({}, "message", {
      get() {
        throw new Error("unreadable error");
      },
    });
    assert.equal(DesktopUpdates.describeUpdateErrorCause(unreadable), "UnknownError");
  });
});
