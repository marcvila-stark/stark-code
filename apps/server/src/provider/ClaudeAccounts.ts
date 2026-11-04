import {
  ClaudeAccountsCommand,
  ClaudeAccountsError,
  type ClaudeAccount,
  type ClaudeAccountsSnapshot,
} from "@starkfuture/contracts";
import { isCommandMissingCause } from "@starkfuture/provider-core/server/snapshotProbe";
import { collectUint8StreamText } from "@starkfuture/provider-core/server/collectStreamText";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@starkfuture/shared/shell";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import {
  CLAUDE_ACCOUNT_IDENTITY_SCRIPT,
  claudeSwapPythonInterpreter,
} from "./ClaudeAccountIdentity.ts";

const NOTICE =
  "Switches this machine's shared Claude login. Other Claude terminals and editors may follow. Isolated Claude profiles are unchanged. Running sessions may need restarting; no messages are replayed. Use only one automatic switcher on this machine.";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const validStatuses = new Set([
  "ok",
  "token_expired",
  "api_key",
  "keychain_unavailable",
  "relogin_required",
  "foreign_credential",
  "no_credentials",
  "unavailable",
]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const label = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 512 ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const json = (value: string): unknown => JSON.parse(value);
const eventRecord = (line: string) => {
  try {
    return line.length <= 65536 ? record(json(line)) : undefined;
  } catch {
    return undefined;
  }
};
type AccountIdentity = Pick<ClaudeAccount, "number" | "email" | "organizationUuid">;
const Identities = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      email: Schema.String,
      organizationUuid: Schema.NullOr(Schema.String),
    }),
  ),
);
const encodeIdentities = Schema.encodeSync(Identities);
const decodeIdentities = Schema.decodeUnknownSync(Identities);

function parseAccounts(
  output: string,
): Pick<ClaudeAccountsSnapshot, "accounts" | "activeAccountNumber"> {
  const payload = record(json(output));
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.accounts)) throw new Error("schema");
  const accounts: ClaudeAccount[] = payload.accounts.map((raw) => {
    const account = record(raw);
    const accountNumber = number(account?.number);
    const email = label(account?.email);
    if (!account || accountNumber === null || email === null) throw new Error("account");
    const usage = record(account.usage);
    const windows: ClaudeAccount["windows"][number][] = [];
    const addWindow = (name: string, rawWindow: unknown) => {
      const window = record(rawWindow);
      if (!window || typeof window.pct !== "number" || !Number.isFinite(window.pct)) return;
      const resetsAt = label(window.resetsAt);
      windows.push({
        name,
        percent: Math.max(0, Math.min(100, window.pct)),
        resetsAt: resetsAt && Number.isFinite(Date.parse(resetsAt)) ? resetsAt : null,
      });
    };
    // Cached last-good usage is deliberately not presented as current quota.
    addWindow("5 hours", usage?.fiveHour);
    addWindow("7 days", usage?.sevenDay);
    for (const scoped of Array.isArray(usage?.scoped) ? usage.scoped : []) {
      const name = label(record(scoped)?.name);
      if (name) addWindow(name, scoped);
    }
    return {
      number: accountNumber,
      email,
      organizationName: label(account.organizationName),
      organizationUuid: label(account.organizationUuid),
      alias: label(account.alias),
      active: account.active === true,
      disabled: account.disabled === true,
      usageStatus:
        typeof account.usageStatus === "string" && validStatuses.has(account.usageStatus)
          ? account.usageStatus
          : "unavailable",
      usageAgeSeconds:
        typeof account.usageAgeSeconds === "number" && Number.isFinite(account.usageAgeSeconds)
          ? Math.max(0, account.usageAgeSeconds)
          : null,
      windows,
    };
  });
  if (new Set(accounts.map((account) => account.number)).size !== accounts.length)
    throw new Error("duplicate");
  const active = number(payload.activeAccountNumber);
  return {
    accounts,
    activeAccountNumber: accounts.some((account) => account.number === active) ? active : null,
  };
}

/** The only boundary that invokes cswap. Credentials never leave its own store. */
export class ClaudeAccountsRuntime extends Context.Service<
  ClaudeAccountsRuntime,
  {
    readonly run: (
      args: readonly string[],
    ) => Effect.Effect<{ readonly code: number; readonly stdout: string }, ClaudeAccountsError>;
    readonly startAuto: (
      args: readonly string[],
      onLine: (line: string) => Effect.Effect<void>,
    ) => Effect.Effect<
      { readonly exited: Effect.Effect<number, ClaudeAccountsError> },
      ClaudeAccountsError,
      Scope.Scope
    >;
    readonly credentialsChanged: Effect.Effect<void>;
    readonly activeAccount: (
      accounts: readonly AccountIdentity[],
    ) => Effect.Effect<AccountIdentity | null>;
  }
>()("stark-code/provider/ClaudeAccounts/ClaudeAccountsRuntime") {}

export class ClaudeAccounts extends Context.Service<
  ClaudeAccounts,
  {
    readonly snapshot: Effect.Effect<ClaudeAccountsSnapshot, ClaudeAccountsError>;
    readonly command: (
      input: ClaudeAccountsCommand,
    ) => Effect.Effect<ClaudeAccountsSnapshot, ClaudeAccountsError>;
  }
>()("stark-code/provider/ClaudeAccounts") {}

const Preferences = Schema.Struct({
  enabled: Schema.Boolean,
  threshold: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(50),
    Schema.isLessThanOrEqualTo(99),
  ),
});
const decodePreferences = Schema.decodeUnknownSync(Preferences);
const decodeCommand = Schema.decodeUnknownSync(ClaudeAccountsCommand);
const isClaudeAccountsError = Schema.is(ClaudeAccountsError);

const make = Effect.gen(function* () {
  const runtime = yield* ClaudeAccountsRuntime;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const lifetime = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const preferencePath = path.join(stateDir, "claude-accounts.json");
  const persisted = yield* fs.readFileString(preferencePath).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => decodePreferences(json(text)),
        catch: () => new ClaudeAccountsError({ reason: "storage" }),
      }),
    ),
    Effect.orElseSucceed(() => ({ enabled: false, threshold: 90 })),
  );
  const automatic = yield* Ref.make<ClaudeAccountsSnapshot["automatic"]>({
    enabled: false,
    threshold: persisted.threshold,
    lastOutcome: null,
  });
  const commandNotice = yield* Ref.make<string | null>(null);
  let autoScope: Scope.Closeable | undefined;
  let generation = 0;
  const persist = (value: typeof persisted) =>
    fs.makeDirectory(stateDir, { recursive: true }).pipe(
      Effect.andThen(
        fs.writeFileString(`${preferencePath}.tmp`, JSON.stringify(value), { mode: 0o600 }),
      ),
      Effect.andThen(fs.rename(`${preferencePath}.tmp`, preferencePath)),
      Effect.mapError(() => new ClaudeAccountsError({ reason: "storage" })),
    );
  const readAccounts = runtime.run(["list", "--json"]).pipe(
    Effect.flatMap((result) =>
      result.code !== 0
        ? Effect.fail(new ClaudeAccountsError({ reason: "failed" }))
        : Effect.try({
            try: () => parseAccounts(result.stdout),
            catch: () => new ClaudeAccountsError({ reason: "failed" }),
          }),
    ),
    Effect.flatMap((data) =>
      runtime.activeAccount(data.accounts).pipe(
        Effect.map((identity) => {
          const matches = identity
            ? data.accounts.filter(
                (account) =>
                  account.number === identity.number &&
                  account.email === identity.email &&
                  account.organizationUuid === identity.organizationUuid,
              )
            : [];
          const activeNumber = matches.length === 1 ? matches[0]!.number : null;
          return {
            activeAccountNumber: activeNumber,
            accounts: data.accounts.map((account) => ({
              ...account,
              active: account.number === activeNumber,
              // cswap may have measured the live credential under a stale config's
              // organization. Never display that quota as another organization's.
              ...(account.active && account.number !== activeNumber
                ? { windows: [], usageStatus: "unavailable" as const, usageAgeSeconds: null }
                : {}),
            })),
          };
        }),
      ),
    ),
  );
  const snapshot: ClaudeAccounts["Service"]["snapshot"] = readAccounts.pipe(
    Effect.flatMap((data) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(automatic);
        const warning = yield* Ref.get(commandNotice);
        return {
          available: true,
          ...data,
          automatic: current,
          notice: [
            warning,
            data.accounts.length > 0 && data.activeAccountNumber === null
              ? "The active organization could not be confirmed from Claude's current login."
              : null,
            NOTICE,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }),
    ),
    Effect.catchTags({
      ClaudeAccountsError: (error) =>
        error.reason === "unavailable"
          ? Ref.get(automatic).pipe(
              Effect.map((current) => ({
                available: false,
                accounts: [],
                activeAccountNumber: null,
                automatic: current,
                notice: error.message,
              })),
            )
          : Effect.fail(error),
    }),
  );
  const stopAuto = Effect.gen(function* () {
    generation += 1;
    const previous = autoScope;
    autoScope = undefined;
    // Closing waits for the owned child; cswap can finish an in-flight switch after SIGTERM.
    if (previous) yield* Scope.close(previous, Exit.void);
    yield* Ref.update(automatic, (current) => ({ ...current, enabled: false }));
  });
  const onLine = (line: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const event = eventRecord(line);
      if (event?.schemaVersion !== 1) return;
      let outcome: string | undefined;
      switch (event.event) {
        case "switch":
          if (event.dryRun === true) return;
          outcome = "Switched the shared Claude login. Running sessions may need restarting.";
          yield* runtime.credentialsChanged;
          break;
        case "all-exhausted":
          outcome = "Every eligible organization is at its limit. Waiting for a reset.";
          break;
        case "error":
          outcome = "Automatic switching could not check accounts; it will retry.";
          break;
        case "account-quarantined":
          outcome = "An account needs attention and was skipped.";
          break;
        case "no-switch":
          outcome = "Checked limits; kept the current organization.";
          break;
        default:
          return;
      }
      yield* Ref.update(automatic, (current) => ({ ...current, lastOutcome: outcome ?? null }));
    });
  const startAuto = (threshold: number) =>
    Effect.gen(function* () {
      yield* stopAuto;
      const owned = yield* Scope.make();
      const nextGeneration = ++generation;
      autoScope = owned;
      const started = yield* runtime
        .startAuto(
          [
            "auto",
            "--json",
            "--threshold",
            String(threshold),
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
          onLine,
        )
        .pipe(
          Scope.provide(owned),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? stopAuto : Effect.void)),
        );
      yield* Ref.set(automatic, {
        enabled: true,
        threshold,
        lastOutcome: "Watching all Claude quota windows. No messages are replayed.",
      });
      yield* started.exited.pipe(
        Effect.orElseSucceed(() => -1),
        Effect.flatMap(() =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (generation !== nextGeneration) return;
              yield* Ref.update(automatic, (current) => ({
                ...current,
                enabled: false,
                lastOutcome: "Automatic switching stopped. Enable it again to retry.",
              }));
              yield* persist({ enabled: false, threshold }).pipe(Effect.ignore);
              autoScope = undefined;
              yield* Scope.close(owned, Exit.void);
            }),
          ),
        ),
        Effect.forkIn(lifetime),
      );
    });
  yield* Effect.addFinalizer(() => stopAuto);
  if (persisted.enabled)
    yield* startAuto(persisted.threshold).pipe(
      Effect.catch(() =>
        Ref.update(automatic, (current) => ({
          ...current,
          enabled: false,
          lastOutcome:
            "Automatic switching could not start. Check claude-swap and enable it again.",
        })),
      ),
    );

  const command: ClaudeAccounts["Service"]["command"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const action = yield* Effect.try({
          try: () => decodeCommand(input),
          catch: () => new ClaudeAccountsError({ reason: "invalid" }),
        });
        if (action.action === "automatic") {
          if (action.enabled) {
            const data = yield* readAccounts;
            if (
              data.accounts.filter(
                (account) => !account.disabled && account.usageStatus !== "api_key",
              ).length < 2
            )
              return yield* new ClaudeAccountsError({ reason: "invalid" });
            yield* startAuto(action.threshold).pipe(
              Effect.andThen(persist({ enabled: true, threshold: action.threshold })),
              Effect.onExit((exit) => (Exit.isFailure(exit) ? stopAuto : Effect.void)),
            );
          } else {
            yield* stopAuto;
            yield* Ref.update(automatic, (current) => ({
              ...current,
              threshold: action.threshold,
              lastOutcome: "Stark Code automatic switching is off.",
            }));
            yield* persist({ enabled: false, threshold: action.threshold }).pipe(
              Effect.tapError(() =>
                // Unlink needs no new disk space; remove an old opt-in if replacing it failed.
                fs.remove(preferencePath).pipe(Effect.ignore),
              ),
            );
          }
        } else {
          if (action.action !== "capture") {
            const data = yield* readAccounts;
            if (
              !data.accounts.some(
                (account) =>
                  account.number === action.accountNumber &&
                  account.email === action.expectedEmail &&
                  account.organizationUuid === action.expectedOrganizationUuid,
              )
            )
              return yield* new ClaudeAccountsError({ reason: "invalid" });
          }
          const args =
            action.action === "capture"
              ? ["add"]
              : action.action === "switch"
                ? ["switch", String(action.accountNumber), "--json"]
                : [action.eligible ? "enable" : "disable", String(action.accountNumber)];
          const result = yield* runtime.run(args);
          if (result.code !== 0) return yield* new ClaudeAccountsError({ reason: "failed" });
          if (action.action === "switch") {
            yield* runtime.credentialsChanged;
            const switched = yield* Effect.try({
              try: () => record(json(result.stdout)),
              catch: () => new ClaudeAccountsError({ reason: "failed" }),
            });
            if (switched?.schemaVersion !== 1 || typeof switched.switched !== "boolean")
              return yield* new ClaudeAccountsError({ reason: "failed" });
            // cswap warnings can include local paths or credential-store context. Keep them local.
            yield* Ref.set(
              commandNotice,
              Array.isArray(switched.warnings) && switched.warnings.length > 0
                ? "Claude-swap reported a credential warning. Check cswap in Terminal before starting more Claude sessions."
                : null,
            );
          }
        }
        return yield* snapshot;
      }),
    );
  return ClaudeAccounts.of({ snapshot, command });
});

export const layer = Layer.effect(ClaudeAccounts, make);

export const runtimeLayer = Layer.effect(
  ClaudeAccountsRuntime,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = { ...(yield* HostProcess.Environment) };
    for (const key of [
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    ])
      delete environment[key];
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const home = yield* HostProcess.HomeDirectory;
    const sharedContinuationKey = `claude:home:${path.resolve(home, ".claude")}`;
    const refreshCredentials = instances.listInstances.pipe(
      Effect.flatMap((all) =>
        Effect.forEach(
          all.filter(
            (instance) =>
              instance.driverKind === "claudeAgent" &&
              instance.continuationIdentity.continuationKey === sharedContinuationKey,
          ),
          (instance) =>
            (instance.invalidateCaches ?? Effect.void).pipe(
              Effect.andThen(instance.snapshot.invalidateAccount ?? Effect.void),
              Effect.andThen(registry.refreshInstance(instance.instanceId)),
            ),
          { concurrency: 2, discard: true },
        ),
      ),
    );
    const spawn = (args: readonly string[]) =>
      Effect.gen(function* () {
        const command = yield* resolveSpawnCommand("cswap", args, { env: environment });
        return yield* spawner.spawn(
          ChildProcess.make(command.command, command.args, {
            env: environment,
            shell: command.shell,
            stdin: "ignore",
            forceKillAfter: "10 seconds",
          }),
        );
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ClaudeAccountsError({
              reason: isCommandMissingCause(cause) ? "unavailable" : "failed",
            }),
        ),
      );
    const run: ClaudeAccountsRuntime["Service"]["run"] = (args) =>
      Effect.gen(function* () {
        const child = yield* spawn(args);
        const [stdout, , exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_OUTPUT_BYTES }),
            Stream.runDrain(child.stderr),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (stdout.truncated || stdout.invalidUtf8)
          return yield* new ClaudeAccountsError({ reason: "failed" });
        return { code: Number(exitCode), stdout: stdout.text };
      }).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
        Effect.mapError((cause) =>
          isClaudeAccountsError(cause) ? cause : new ClaudeAccountsError({ reason: "failed" }),
        ),
      );
    const startAuto: ClaudeAccountsRuntime["Service"]["startAuto"] = (args, onLine) =>
      Effect.gen(function* () {
        const child = yield* spawn(args);
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach(onLine),
          Effect.ignore,
          Effect.forkScoped,
        );
        yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
        return {
          exited: child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(() => new ClaudeAccountsError({ reason: "failed" })),
          ),
        };
      });
    const lookupActiveAccount: ClaudeAccountsRuntime["Service"]["activeAccount"] = (accounts) =>
      Effect.gen(function* () {
        if (accounts.length === 0) return null;
        const launcher = yield* resolveCommandPath("cswap", { env: environment });
        if (!launcher) return null;
        if ((yield* fs.stat(launcher)).size > 65_536) return null;
        const source = yield* fs.readFileString(launcher);
        const interpreter = claudeSwapPythonInterpreter(source);
        if (!interpreter) return null;
        const child = yield* spawner.spawn(
          ChildProcess.make(
            interpreter,
            [
              "-I",
              "-c",
              CLAUDE_ACCOUNT_IDENTITY_SCRIPT,
              encodeIdentities(
                accounts.map(({ number, email, organizationUuid }) => ({
                  number,
                  email,
                  organizationUuid,
                })),
              ),
            ],
            { env: environment, stdin: "ignore", forceKillAfter: "2 seconds" },
          ),
        );
        const [stdout, , code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 4096 }),
            Stream.runDrain(child.stderr),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0 || stdout.truncated || stdout.invalidUtf8) return null;
        const result = eventRecord(stdout.text);
        const identity = record(result?.identity);
        const accountNumber = number(identity?.number);
        const email = label(identity?.email);
        const organizationUuid = label(identity?.organizationUuid);
        if (
          result?.schemaVersion !== 1 ||
          accountNumber === null ||
          email === null ||
          (identity?.organizationUuid !== null && organizationUuid === null)
        )
          return null;
        return { number: accountNumber, email, organizationUuid };
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.scoped,
        Effect.timeout("15 seconds"),
        Effect.orElseSucceed(() => null),
      );
    // Menu refreshes and concurrent consumers share one bounded read. An explicit
    // switch invalidates this before refreshing provider state; an external CLI
    // change is reflected within 60 seconds. Cache failures too to avoid polling
    // the profile endpoint during an outage.
    const identityCache = yield* Cache.make({
      capacity: 1,
      timeToLive: "60 seconds",
      lookup: (key: string) => lookupActiveAccount(decodeIdentities(key)),
    });
    const activeAccount: ClaudeAccountsRuntime["Service"]["activeAccount"] = (accounts) =>
      Cache.get(
        identityCache,
        encodeIdentities(
          accounts.map(({ number, email, organizationUuid }) => ({
            number,
            email,
            organizationUuid,
          })),
        ),
      );
    const credentialsChanged = Cache.invalidateAll(identityCache).pipe(
      Effect.andThen(refreshCredentials),
    );
    return ClaudeAccountsRuntime.of({ run, startAuto, credentialsChanged, activeAccount });
  }),
);
