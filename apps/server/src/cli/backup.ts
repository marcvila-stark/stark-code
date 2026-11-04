// @effect-diagnostics nodeBuiltinImport:off - Paths of the state directory and backups, resolved before any service runs.
import * as NodePath from "node:path";

import {
  ATTACHMENT_HOLDS_FILE,
  AttachmentHolds,
  type StateBackupManifest,
} from "@starkfuture/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as AppBuild from "../appBuild.ts";
import { pendingAttachmentFiles, readAttachmentHolds } from "../attachmentStore.ts";
import * as MaintenanceIntent from "../maintenance/MaintenanceIntent.ts";
import * as RecoveryHold from "../maintenance/RecoveryHold.ts";
import * as StateAccess from "../persistence/StateAccess.ts";
import * as StateBackup from "../persistence/StateBackup.ts";
import * as StateFiles from "../persistence/StateFiles.ts";
import * as StateRestore from "../persistence/StateRestore.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class BackupNotAdmittedError extends Schema.TaggedError<BackupNotAdmittedError>()(
  "BackupNotAdmittedError",
  { requestId: Schema.String },
) {
  override get message(): string {
    return "The update that started this backup no longer holds the data. Nothing was changed.";
  }
}

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print one JSON line instead of text."),
  Flag.withDefault(false),
);

const appVersionFlag = Flag.String("app-version").pipe(
  Flag.withDescription(
    "The Stark Code version to act as (defaults to the app this CLI is bundled in).",
  ),
  Flag.optional,
);

const encodeAttachmentHolds = Schema.encodeSync(Schema.fromJsonString(AttachmentHolds));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const resolveLocation = (flags: CliAuthLocationFlags) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return { config, stateDir: NodePath.dirname(config.dbPath) };
  });

/** Prints the outcome; on failure also as `{ ok: false, error, message }` with `--json`. */
const report = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  json: boolean,
  effect: Effect.Effect<A, E, R>,
  describe: (value: A) => { readonly json: Record<string, unknown>; readonly text: string },
) =>
  effect.pipe(
    Effect.tap((value) => {
      const described = describe(value);
      return Console.log(json ? encodeJsonLine({ ok: true, ...described.json }) : described.text);
    }),
    Effect.tapError((error) =>
      json
        ? Console.log(encodeJsonLine({ ok: false, error: error._tag, message: error.message }))
        : Effect.void,
    ),
    Effect.asVoid,
  );

const describeManifest = (manifest: StateBackupManifest) =>
  `${manifest.id}: ${manifest.reason}, Stark Code ${manifest.app.version}, ${manifest.counts.threads} threads, ${manifest.counts.messages} messages, created ${manifest.createdAt}`;

const createCommand = Command.make("create", {
  ...authLocationFlags,
  reason: Flag.Literals("reason", ["pre-install", "manual"]).pipe(
    Flag.withDescription("Why the backup is taken."),
    Flag.withDefault("manual" as const),
  ),
  intent: Flag.String("intent").pipe(
    Flag.withDescription(
      "The maintenance request that holds the data exclusively and admits this backup.",
    ),
    Flag.optional,
  ),
  appVersion: appVersionFlag,
  targetVersion: Flag.String("target-version").pipe(Flag.optional),
  drafts: Flag.String("drafts").pipe(
    Flag.withDescription("The windows' composer drafts, exported as JSON."),
    Flag.optional,
  ),
  draftsFormat: Flag.Int("drafts-format").pipe(Flag.optional),
  stash: Flag.String("stash").pipe(
    Flag.withDescription("The windows' prompt stash, exported as JSON."),
    Flag.optional,
  ),
  stashFormat: Flag.String("stash-format").pipe(Flag.optional),
  attachment: Flag.String("attachment").pipe(
    Flag.withDescription("A pending upload the drafts or stash reference. Repeat for more."),
    Flag.atLeast(0),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Back up this Stark home's database, settings and drafts. No server may be running.",
  ),
  Command.withHandler((flags) =>
    report(
      flags.json,
      Effect.scoped(
        Effect.gen(function* () {
          const { config, stateDir } = yield* resolveLocation(flags);
          if (Option.isSome(flags.intent)) {
            // The desktop app holds the maintenance lock for this update; its
            // intent admits exactly this backup.
            const intent = yield* MaintenanceIntent.read(stateDir);
            if (
              Option.isNone(intent) ||
              intent.value.requestId !== flags.intent.value ||
              intent.value.phase !== "backup"
            ) {
              return yield* new BackupNotAdmittedError({ requestId: flags.intent.value });
            }
          } else {
            yield* StateAccess.acquireMaintenanceLock(stateDir, "exclusive");
          }
          yield* StateAccess.excludeServer(stateDir);
          const nowMs = yield* Clock.currentTimeMillis;
          const build = yield* AppBuild.current;
          const appVersion = Option.getOrElse(flags.appVersion, () => build.version);
          const result = yield* StateBackup.create({
            baseDir: config.baseDir,
            stateDir,
            dbPath: config.dbPath,
            reason: flags.reason,
            appVersion,
            appCommit: AppBuild.commitFor(build, appVersion),
            targetVersion: Option.getOrNull(flags.targetVersion),
            drafts: Option.getOrUndefined(
              Option.map(flags.drafts, (path) => ({
                path,
                format: Option.getOrElse(flags.draftsFormat, () => 0),
              })),
            ),
            stash: Option.getOrUndefined(
              Option.map(flags.stash, (path) => ({
                path,
                format: Option.getOrElse(flags.stashFormat, () => "unknown"),
              })),
            ),
            attachmentPaths: pendingAttachmentFiles(config.attachmentsDir, flags.attachment),
          });
          if (flags.attachment.length > 0) {
            // The drafts still point at these uploads after the update; the
            // startup sweep must not take them.
            const ops = yield* StateFiles.StateFileOps;
            const attachmentIds = [
              ...new Set([
                ...readAttachmentHolds(config.attachmentsDir, nowMs),
                ...flags.attachment,
              ]),
            ];
            yield* Effect.try(() =>
              StateFiles.writeFileDurably(
                ops,
                NodePath.join(stateDir, ATTACHMENT_HOLDS_FILE),
                `${encodeAttachmentHolds({
                  version: 1,
                  heldAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
                  attachmentIds,
                })}\n`,
              ),
            ).pipe(Effect.ignore({ log: true }));
          }
          return result;
        }),
      ),
      (result) => ({
        json: { id: result.id, path: result.path, manifest: result.manifest },
        text: `Backed up to ${result.path}\n${describeManifest(result.manifest)}`,
      }),
    ),
  ),
);

const verifyCommand = Command.make("verify", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Backup id.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Check a backup's files against its manifest."),
  Command.withHandler((flags) =>
    report(
      flags.json,
      Effect.gen(function* () {
        const { config } = yield* resolveLocation(flags);
        return yield* StateBackup.verify(
          NodePath.join(StateBackup.backupsDirectory(config.baseDir), flags.id),
        );
      }),
      (manifest) => ({ json: { manifest }, text: `Verified ${describeManifest(manifest)}` }),
    ),
  ),
);

const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List backups, newest first."),
  Command.withHandler((flags) =>
    report(
      flags.json,
      Effect.gen(function* () {
        const { config } = yield* resolveLocation(flags);
        return yield* StateBackup.list(config.baseDir);
      }),
      (backups) => ({
        json: { backups: backups.map((backup) => backup.manifest) },
        text:
          backups.length === 0
            ? "No backups."
            : backups.map((backup) => describeManifest(backup.manifest)).join("\n"),
      }),
    ),
  ),
);

const restoreCommand = Command.make("restore", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Backup id.")),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Verify the backup and check it can be restored, changing nothing."),
    Flag.withDefault(false),
  ),
  appVersion: appVersionFlag,
  currentDrafts: Flag.String("current-drafts").pipe(Flag.optional),
  currentStash: Flag.String("current-stash").pipe(Flag.optional),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Restore a backup. Replaced files are kept; background work waits until `backup resume`.",
  ),
  Command.withHandler((flags) =>
    report(
      flags.json,
      Effect.scoped(
        Effect.gen(function* () {
          const { config, stateDir } = yield* resolveLocation(flags);
          const build = yield* AppBuild.current;
          const runningVersion = Option.getOrElse(flags.appVersion, () => build.version);
          const backupDir = NodePath.join(StateBackup.backupsDirectory(config.baseDir), flags.id);
          if (flags.dryRun) {
            const manifest = yield* StateBackup.verify(backupDir);
            const incompatibility = StateRestore.incompatibility(manifest, runningVersion);
            return {
              dryRun: true,
              backupId: flags.id,
              backupAppVersion: manifest.app.version,
              restorable: incompatibility === null,
              incompatibility,
              displacedPath: null,
            };
          }
          yield* StateAccess.acquireMaintenanceLock(stateDir, "exclusive");
          yield* StateAccess.excludeServer(stateDir);
          // An earlier restore that crashed is finished or undone first.
          yield* StateRestore.recoverInterrupted(config.baseDir);
          const nowIso = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
          yield* MaintenanceIntent.write(stateDir, {
            version: 1,
            requestId: `restore:${flags.id}`,
            phase: "restoring",
            ownerPid: process.pid,
            fromVersion: runningVersion,
            toVersion: null,
            backupId: flags.id,
            updatedAt: nowIso,
          });
          const restored = yield* StateRestore.restore({
            baseDir: config.baseDir,
            stateDir,
            attachmentsDir: config.attachmentsDir,
            backupId: flags.id,
            runningVersion,
            currentDrafts: Option.getOrUndefined(flags.currentDrafts),
            currentStash: Option.getOrUndefined(flags.currentStash),
          }).pipe(
            // Without a journal nothing moved, so the intent has nothing to resolve.
            Effect.onError(() =>
              StateFiles.exists(StateRestore.journalPath(config.baseDir))
                ? Effect.void
                : MaintenanceIntent.clear(stateDir).pipe(Effect.ignore),
            ),
          );
          yield* MaintenanceIntent.clear(stateDir);
          return {
            dryRun: false,
            backupId: restored.backupId,
            backupAppVersion: restored.backupAppVersion,
            restorable: true,
            incompatibility: null,
            displacedPath: restored.displacedPath,
          };
        }),
      ),
      (result) => ({
        json: result,
        text: result.dryRun
          ? result.restorable
            ? `Backup ${result.backupId} (Stark Code ${result.backupAppVersion}) can be restored.`
            : `Backup ${result.backupId} cannot be restored by this version (${result.incompatibility}).`
          : `Restored from the ${result.backupAppVersion} backup; replaced data is in ${result.displacedPath}; background work is paused until you run \`backup resume\`.`,
      }),
    ),
  ),
);

const resumeCommand = Command.make("resume", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription(
    "Resume scheduled tasks, continuations and cleanup after a restore. Run it with Stark Code stopped.",
  ),
  Command.withHandler((flags) =>
    report(
      flags.json,
      Effect.scoped(
        Effect.gen(function* () {
          const { stateDir } = yield* resolveLocation(flags);
          yield* StateAccess.acquireMaintenanceLock(stateDir, "exclusive");
          yield* StateAccess.excludeServer(stateDir);
          const held = yield* RecoveryHold.read(stateDir);
          yield* RecoveryHold.release(stateDir);
          return Option.isSome(held);
        }),
      ),
      (released) => ({
        json: { released },
        text: released ? "Background work resumes on the next start." : "Nothing was on hold.",
      }),
    ),
  ),
);

export const backupCommand = Command.make("backup").pipe(
  Command.withDescription("Back up, verify and restore this Stark home's data."),
  Command.withSubcommands([
    createCommand,
    verifyCommand,
    listCommand,
    restoreCommand,
    resumeCommand,
  ]),
);
