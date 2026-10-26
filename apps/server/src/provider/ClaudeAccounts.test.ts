import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ClaudeAccountsError } from "@starkfuture/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../config.ts";
import * as ClaudeAccounts from "./ClaudeAccounts.ts";

const savedAccounts = [
  {
    number: 1,
    email: "owner@example.test",
    organizationUuid: "org-one",
    organizationName: "One",
    active: true,
    usageStatus: "ok",
    usage: { fiveHour: { pct: 98, resetsAt: "2026-10-17T18:00:00Z" }, sevenDay: { pct: 30 } },
  },
  {
    number: 2,
    email: "owner@example.test",
    organizationUuid: "org-two",
    organizationName: "Two",
    active: false,
    usageStatus: "ok",
    usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 20 } },
  },
];
const identity = {
  accountNumber: 2,
  expectedEmail: "owner@example.test",
  expectedOrganizationUuid: "org-two",
};

const makeRuntime = Effect.gen(function* () {
  const calls: string[][] = [];
  const changes = yield* Ref.make(0);
  const closed = yield* Ref.make(0);
  const exit = yield* Deferred.make<number>();
  const acquired = yield* Deferred.make<void>();
  let onLine: ((line: string) => Effect.Effect<void>) | undefined;
  let startFailure = false;
  let unavailable = false;
  let hangStart = false;
  let mutation = { code: 0, stdout: JSON.stringify({ schemaVersion: 1, switched: true }) };
  let payload: unknown = { schemaVersion: 1, activeAccountNumber: 1, accounts: savedAccounts };
  let activeAccount:
    | Parameters<ClaudeAccounts.ClaudeAccountsRuntime["Service"]["activeAccount"]>[0][number]
    | null = {
    number: 1,
    email: "owner@example.test",
    organizationUuid: "org-one",
  };
  const runtime = ClaudeAccounts.ClaudeAccountsRuntime.of({
    run: (args) =>
      Effect.gen(function* () {
        calls.push([...args]);
        if (unavailable) return yield* new ClaudeAccountsError({ reason: "unavailable" });
        return args[0] === "list" ? { code: 0, stdout: JSON.stringify(payload) } : mutation;
      }),
    startAuto: (args, callback) =>
      Effect.gen(function* () {
        calls.push([...args]);
        if (startFailure) return yield* new ClaudeAccountsError({ reason: "unavailable" });
        onLine = callback;
        yield* Effect.addFinalizer(() =>
          Ref.update(closed, (value) => value + 1).pipe(Effect.andThen(Deferred.succeed(exit, 0))),
        );
        yield* Deferred.succeed(acquired, undefined);
        if (hangStart) return yield* Effect.never;
        return { exited: Deferred.await(exit) };
      }),
    credentialsChanged: Ref.update(changes, (value) => value + 1),
    activeAccount: () => Effect.sync(() => activeAccount),
  });
  return {
    calls,
    changes,
    closed,
    runtime,
    acquired,
    emit: (event: unknown) => onLine?.(JSON.stringify(event)) ?? Effect.die("Auto was not started"),
    setPayload: (next: unknown) => {
      payload = next;
    },
    setActiveAccount: (next: typeof activeAccount) => {
      activeAccount = next;
    },
    unavailable: () => {
      unavailable = true;
    },
    failStart: () => {
      startFailure = true;
    },
    hangStart: () => {
      hangStart = true;
    },
    setMutation: (next: typeof mutation) => {
      mutation = next;
    },
  };
});
type Harness = Effect.Success<typeof makeRuntime>;

const withHarness = <A, E, R>(test: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* makeRuntime;
    return yield* test(harness).pipe(
      Effect.provide(ClaudeAccounts.layer),
      Effect.provideService(ClaudeAccounts.ClaudeAccountsRuntime, harness.runtime),
      Effect.provide(ServerConfig.layerTest("/workspace", { prefix: "claude-accounts-test-" })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("keeps one login's organizations distinct and only returns allowlisted metadata", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      harness.setPayload({
        schemaVersion: 1,
        activeAccountNumber: 1,
        unclaimedCredentials: ["private-path"],
        accounts: [
          { ...savedAccounts[0], token: "secret", usageAgeSeconds: 4 },
          {
            ...savedAccounts[1],
            usage: undefined,
            usageStatus: "relogin_required",
            lastGoodUsage: { fiveHour: { pct: 0 } },
          },
        ],
      });
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      const snapshot = yield* service.snapshot;
      expect(snapshot.accounts).toHaveLength(2);
      expect(snapshot.accounts.map((account) => account.organizationUuid)).toEqual([
        "org-one",
        "org-two",
      ]);
      expect(snapshot.accounts[0]?.windows[0]?.percent).toBe(98);
      expect(snapshot.accounts[1]?.windows).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain("secret");
      expect(JSON.stringify(snapshot)).not.toContain("private-path");
      expect(snapshot.automatic.enabled).toBe(false);
      expect(harness.calls).toEqual([["list", "--json"]]);
    }),
  ),
);

it.effect("switches the validated organization without forcing or replaying a session", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      yield* service.command({ action: "switch", ...identity });
      expect(harness.calls).toEqual([
        ["list", "--json"],
        ["switch", "2", "--json"],
        ["list", "--json"],
      ]);
      expect(yield* Ref.get(harness.changes)).toBe(1);
    }),
  ),
);

it.effect(
  "uses the current credential identity when same-email organization metadata stays stale",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const service = yield* ClaudeAccounts.ClaudeAccounts;
        expect((yield* service.snapshot).activeAccountNumber).toBe(1);
        // cswap keeps reporting slot 1 from .claude.json, while the login is slot 2.
        harness.setActiveAccount({
          number: 2,
          email: identity.expectedEmail,
          organizationUuid: "org-two",
        });
        const switched = yield* service.command({ action: "switch", ...identity });
        expect(switched.activeAccountNumber).toBe(2);
        expect(switched.accounts.map((account) => account.active)).toEqual([false, true]);
        expect(switched.accounts[0]?.windows).toEqual([]);
        expect(switched.accounts[0]?.usageStatus).toBe("unavailable");
        expect(switched.accounts[1]?.windows[0]?.percent).toBe(10);
        const refreshed = yield* service.snapshot;
        expect(refreshed.activeAccountNumber).toBe(2);
        expect(refreshed.accounts.map((account) => account.active)).toEqual([false, true]);
        harness.setActiveAccount({
          number: 1,
          email: identity.expectedEmail,
          organizationUuid: "org-one",
        });
        expect((yield* service.snapshot).activeAccountNumber).toBe(1);
      }),
    ),
);

it.effect("does not guess an active organization from email, old flags, or a reused slot", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      for (const identity of [
        null,
        { number: 2, email: "owner@example.test", organizationUuid: "different-org" },
        { number: 2, email: "different@example.test", organizationUuid: "org-two" },
      ]) {
        harness.setActiveAccount(identity);
        const snapshot = yield* service.snapshot;
        expect(snapshot.activeAccountNumber).toBeNull();
        expect(snapshot.accounts.every((account) => !account.active)).toBe(true);
        expect(snapshot.notice).toContain("could not be confirmed");
      }
    }),
  ),
);

it.effect("rejects a stale slot that now belongs to another organization", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      const result = yield* Effect.result(
        service.command({ action: "switch", ...identity, expectedOrganizationUuid: "old-org" }),
      );
      expect(result._tag).toBe("Failure");
      expect(harness.calls).toEqual([["list", "--json"]]);
      expect(yield* Ref.get(harness.changes)).toBe(0);
    }),
  ),
);

it.effect("sets automatic eligibility only on the expected saved identity", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      yield* service.command({ action: "setEligible", ...identity, eligible: false });
      expect(harness.calls).toContainEqual(["disable", "2"]);
      const bad = yield* Effect.result(
        service.command({
          action: "setEligible",
          ...identity,
          expectedEmail: "other@example.test",
          eligible: true,
        }),
      );
      expect(bad._tag).toBe("Failure");
      expect(harness.calls).not.toContainEqual(["enable", "2"]);
    }),
  ),
);

it.effect("captures the current login without an overwrite slot or interactive alias prompt", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      yield* service.command({ action: "capture" });
      expect(harness.calls).toEqual([["add"], ["list", "--json"]]);
    }),
  ),
);

it.effect("reports an unavailable engine and never starts automatic switching by default", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      harness.unavailable();
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      const snapshot = yield* service.snapshot;
      expect(snapshot.available).toBe(false);
      expect(snapshot.automatic.enabled).toBe(false);
      expect(snapshot.accounts).toEqual([]);
    }),
  ),
);

it.effect(
  "owns one automatic process, filters event payloads and waits for stop before reporting off",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const service = yield* ClaudeAccounts.ClaudeAccounts;
        const enabled = yield* service.command({
          action: "automatic",
          enabled: true,
          threshold: 90,
        });
        expect(enabled.automatic.enabled).toBe(true);
        expect(harness.calls.filter((args) => args[0] === "auto")).toEqual([
          [
            "auto",
            "--json",
            "--threshold",
            "90",
            "--interval",
            "60",
            "--cooldown",
            "300",
            "--strategy",
            "best",
            "--model",
            "all",
            "--no-include-api-key-accounts",
          ],
        ]);
        yield* harness.emit({ schemaVersion: 1, event: "switch", dryRun: true });
        expect(yield* Ref.get(harness.changes)).toBe(0);
        yield* harness.emit({
          schemaVersion: 1,
          event: "switch",
          dryRun: false,
          warnings: ["token=secret"],
        });
        expect(yield* Ref.get(harness.changes)).toBe(1);
        expect(JSON.stringify(yield* service.snapshot)).not.toContain("secret");
        yield* harness.emit({
          schemaVersion: 1,
          event: "all-exhausted",
          earliestResetAt: "2026-10-18T00:00:00Z",
        });
        expect((yield* service.snapshot).automatic.lastOutcome).toContain(
          "Every eligible organization",
        );
        const disabled = yield* service.command({
          action: "automatic",
          enabled: false,
          threshold: 85,
        });
        expect(disabled.automatic.enabled).toBe(false);
        expect(yield* Ref.get(harness.closed)).toBe(1);
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        expect(JSON.parse(yield* fs.readFileString(`${stateDir}/claude-accounts.json`))).toEqual({
          enabled: false,
          threshold: 85,
        });
      }),
    ),
);

it.effect("does not persist enabled when the automatic child cannot start", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      harness.failStart();
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      expect(
        (yield* Effect.result(
          service.command({ action: "automatic", enabled: true, threshold: 90 }),
        ))._tag,
      ).toBe("Failure");
      expect((yield* service.snapshot).automatic.enabled).toBe(false);
    }),
  ),
);

it.effect("closes an acquired child if enabling is interrupted before launch completes", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      harness.hangStart();
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      const startup = yield* service
        .command({ action: "automatic", enabled: true, threshold: 90 })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(harness.acquired);
      yield* Fiber.interrupt(startup);
      expect(yield* Ref.get(harness.closed)).toBe(1);
      expect((yield* service.snapshot).automatic.enabled).toBe(false);
    }),
  ),
);

it.effect("stops automatic switching even when writing the disabled preference fails", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      yield* service.command({ action: "automatic", enabled: true, threshold: 90 });
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(`${stateDir}/claude-accounts.json.tmp`);
      expect(
        (yield* Effect.result(
          service.command({ action: "automatic", enabled: false, threshold: 90 }),
        ))._tag,
      ).toBe("Failure");
      expect(yield* Ref.get(harness.closed)).toBe(1);
      expect((yield* service.snapshot).automatic.enabled).toBe(false);
      expect(yield* fs.exists(`${stateDir}/claude-accounts.json`)).toBe(false);
    }),
  ),
);

it.effect("surfaces a safe credential warning without forwarding engine output", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      harness.setMutation({
        code: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          switched: true,
          warnings: ["secret-private-credential-path"],
        }),
      });
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      const snapshot = yield* service.command({ action: "switch", ...identity });
      expect(snapshot.notice).toContain("credential warning");
      expect(snapshot.notice).not.toContain("secret-private-credential-path");
    }),
  ),
);

it.effect("rejects malformed success and account payloads with fixed errors", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      harness.setMutation({ code: 0, stdout: "private-output-not-json" });
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      const switched = yield* Effect.result(service.command({ action: "switch", ...identity }));
      expect(switched._tag).toBe("Failure");
      expect(JSON.stringify(switched)).not.toContain("private-output-not-json");
      harness.setPayload({
        schemaVersion: 1,
        accounts: [{ ...savedAccounts[0], number: "wrong" }],
      });
      expect((yield* Effect.result(service.snapshot))._tag).toBe("Failure");
    }),
  ),
);

it.effect("refuses automatic switching with fewer than two eligible subscription accounts", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      harness.setPayload({
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [savedAccounts[0], { ...savedAccounts[1], disabled: true }],
      });
      const service = yield* ClaudeAccounts.ClaudeAccounts;
      expect(
        (yield* Effect.result(
          service.command({ action: "automatic", enabled: true, threshold: 90 }),
        ))._tag,
      ).toBe("Failure");
      expect(harness.calls.some((args) => args[0] === "auto")).toBe(false);
    }),
  ),
);

it.effect("closes an automatic process when its app scope ends", () =>
  Effect.gen(function* () {
    const harness = yield* makeRuntime;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ClaudeAccounts.ClaudeAccounts;
        yield* service.command({ action: "automatic", enabled: true, threshold: 90 });
      }).pipe(
        Effect.provide(ClaudeAccounts.layer),
        Effect.provideService(ClaudeAccounts.ClaudeAccountsRuntime, harness.runtime),
        Effect.provide(
          ServerConfig.layerTest("/workspace", { prefix: "claude-accounts-shutdown-" }),
        ),
      ),
    );
    expect(yield* Ref.get(harness.closed)).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
