import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import {
  STARK_UPDATE_OWNERSHIP,
  bakedRehearsalOf,
  checkOwnSignature,
  designatedRequirementForTeam,
  parseCodeSignatureSummary,
  parseDesignatedRequirement,
  readBakedUpdatePolicy,
  type BakedUpdatePolicy,
  type CodeSignatureSummary,
  type UpdateOwnership,
  type ValidatedStarkUpdateFeed,
} from "./updateFeedPolicy.ts";
import * as UpdateSeams from "./updateSeams.ts";

/**
 * Checks a downloaded update before it is offered and again before the
 * restart (PLAN-002 §1.5): the cached ZIP is extracted, its app must satisfy
 * the pinned Stark requirement (Apple anchor, this bundle id, the
 * stark.brand.json team) and this app's own designated requirement, which is
 * what Squirrel.Mac checks later; its version must be the one offered and its
 * baked update policy must be this app's. The ZIP's sha256 is recorded, so
 * bytes that change after the first check void it. Squirrel's own check stays
 * the backstop.
 */

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-updater");

export interface CandidateFacts {
  readonly offeredVersion: string;
  /** `codesign --verify --deep --strict -R '=<pinned requirement>'` accepted it. */
  readonly pinnedRequirementAccepted: boolean;
  /** Same against this app's own requirement; null when this app has none to test. */
  readonly ownRequirementAccepted: boolean | null;
  readonly signature: CodeSignatureSummary;
  readonly bundleId: string | undefined;
  readonly version: string | undefined;
  readonly policy: BakedUpdatePolicy | null;
}

const rejected = (
  kind: "signature" | "invalid-artifact",
  detail: string,
): UpdateSeams.DesktopUpdateArtifactVerdict => ({ _tag: "Rejected", kind, detail });

/** Whether two baked policies name the same feed and rehearsal profile. Faults may differ. */
export function sameUpdatePolicy(
  candidate: BakedUpdatePolicy,
  own: Pick<ValidatedStarkUpdateFeed, "kind" | "url" | "channels" | "appleTeamId">,
  ownRehearsalProfile: string | null,
): boolean {
  return (
    candidate.kind === own.kind &&
    candidate.url === own.url &&
    candidate.appleTeamId === own.appleTeamId &&
    candidate.channels.length === own.channels.length &&
    candidate.channels.every((channel, index) => own.channels[index] === channel) &&
    (bakedRehearsalOf(candidate)?.profile ?? null) === ownRehearsalProfile
  );
}

/** The verdict on an extracted candidate, from what codesign, Info.plist and its package.json said. */
export function judgeCandidate(
  facts: CandidateFacts,
  context: {
    readonly feed: Pick<ValidatedStarkUpdateFeed, "kind" | "url" | "channels" | "appleTeamId">;
    readonly ownRehearsalProfile: string | null;
    readonly ownership?: UpdateOwnership;
  },
): UpdateSeams.DesktopUpdateArtifactVerdict {
  const ownership = context.ownership ?? STARK_UPDATE_OWNERSHIP;
  const signatureProblem = checkOwnSignature(facts.signature, context.feed.kind, ownership);
  if (signatureProblem !== null) return rejected("signature", `signature ${signatureProblem}`);
  if (!facts.pinnedRequirementAccepted) {
    return rejected("signature", "not signed by the Stark team as this app");
  }
  if (facts.ownRequirementAccepted === false) {
    return rejected("signature", "does not satisfy this app's designated requirement");
  }
  if (facts.bundleId !== ownership.bundleId) return rejected("signature", "bundle id differs");
  if (facts.version !== facts.offeredVersion) {
    return rejected("invalid-artifact", "version differs from the offer");
  }
  if (facts.policy === null) return rejected("invalid-artifact", "no baked update policy");
  if (!sameUpdatePolicy(facts.policy, context.feed, context.ownRehearsalProfile)) {
    return rejected("invalid-artifact", "baked update policy differs");
  }
  return { _tag: "Verified" };
}

interface ToolResult {
  readonly exitCode: number;
  readonly output: string;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const feedGate = yield* UpdateSeams.DesktopUpdateFeedGate;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ownApp = path.resolve(environment.resourcesPath, "..", "..");
  const ownRehearsalProfile = environment.rehearsal?.profile ?? null;
  /** sha256 of each ZIP that passed, by path: changed bytes void the pass. */
  const verifiedDigests = new Map<string, string>();

  const run = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, [...args], { stdin: "ignore" }),
        );
        const [output, exitCode] = yield* Effect.all(
          [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { exitCode: Number(exitCode), output } satisfies ToolResult;
      }),
    );

  const ownRequirement = yield* Effect.cached(
    run("/usr/bin/codesign", ["-d", "-r-", ownApp]).pipe(
      Effect.map((result) => parseDesignatedRequirement(result.output).text ?? null),
      Effect.orElseSucceed(() => null),
    ),
  );

  const sha256 = (file: string) =>
    run("/usr/bin/shasum", ["-a", "256", file]).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? (/^([0-9a-f]{64})\s/u.exec(result.output)?.[1] ?? null) : null,
      ),
    );

  const plistValue = (plist: string, key: string) =>
    run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.output.trim() : undefined)),
    );

  const extractApp = (
    zip: string,
  ): Effect.Effect<string | null, PlatformError.PlatformError, Scope.Scope> =>
    Effect.gen(function* () {
      // Electron's asar support shows the extracted app.asar to the main
      // process as a directory, so a recursive remove from here fails with
      // ENOTEMPTY, fails the check and leaks the extracted app. /bin/rm sees
      // plain files.
      const directory = yield* Effect.acquireRelease(
        fileSystem.makeTempDirectory({ prefix: "stark-update-verify-" }),
        (created) =>
          run("/bin/rm", ["-rf", created]).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : logWarning("could not remove a checked update's extracted copy", {
                    exitCode: result.exitCode,
                  }),
            ),
            Effect.ignore,
          ),
      );
      const extracted = yield* run("/usr/bin/ditto", ["-x", "-k", zip, directory]);
      if (extracted.exitCode !== 0) return null;
      const apps = (yield* fileSystem.readDirectory(directory)).filter((entry) =>
        entry.endsWith(".app"),
      );
      return apps.length === 1 && apps[0] !== undefined ? path.join(directory, apps[0]) : null;
    });

  const inspect = (
    app: string,
    offeredVersion: string,
    teamId: string,
  ): Effect.Effect<CandidateFacts, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const pinned = designatedRequirementForTeam({
        teamId,
        bundleId: STARK_UPDATE_OWNERSHIP.bundleId,
      });
      const verify = (requirement: string) =>
        run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", `=${requirement}`, app]);
      const own = yield* ownRequirement;
      const plist = path.join(app, "Contents", "Info.plist");
      const packageJson = yield* fileSystem
        .readFileString(path.join(app, "Contents", "Resources", "app.asar", "package.json"))
        .pipe(Effect.option, Effect.map(Option.getOrUndefined));
      const baked = readBakedUpdatePolicy(packageJson);
      return {
        offeredVersion,
        pinnedRequirementAccepted: (yield* verify(pinned)).exitCode === 0,
        ownRequirementAccepted: own === null ? null : (yield* verify(own)).exitCode === 0,
        signature: parseCodeSignatureSummary(
          (yield* run("/usr/bin/codesign", ["--display", "--verbose=2", "-r-", app])).output,
        ),
        bundleId: yield* plistValue(plist, "CFBundleIdentifier"),
        version: yield* plistValue(plist, "CFBundleShortVersionString"),
        policy: packageJson !== undefined && baked.ok ? baked.policy : null,
      } satisfies CandidateFacts;
    });

  const verify = Effect.fn("desktop.updates.verifyDownloadedUpdate")(function* (input: {
    readonly version: string;
    readonly downloadedFile: string | null;
  }) {
    const decision = yield* feedGate.resolve;
    if (decision._tag !== "Enabled") {
      return rejected("signature", "updates are off for this build");
    }
    const feed = decision.feed;
    const teamId = STARK_UPDATE_OWNERSHIP.appleTeamId;
    if (teamId === null) return rejected("signature", "no Apple team is pinned");
    const file = input.downloadedFile;
    if (file === null) return rejected("invalid-artifact", "the download is missing");
    const digest = yield* sha256(file).pipe(Effect.orElseSucceed(() => null));
    if (digest === null) return rejected("invalid-artifact", "the download is unreadable");
    const earlier = verifiedDigests.get(file);
    if (earlier !== undefined && earlier !== digest) {
      verifiedDigests.delete(file);
      return rejected("invalid-artifact", "the download changed after it was checked");
    }
    const verdict = yield* Effect.scoped(
      extractApp(file).pipe(
        Effect.flatMap((app) =>
          app === null
            ? Effect.succeed(rejected("invalid-artifact", "the download holds no single app"))
            : inspect(app, input.version, teamId).pipe(
                Effect.map((facts) => judgeCandidate(facts, { feed, ownRehearsalProfile })),
              ),
        ),
      ),
    ).pipe(
      Effect.catchCause(() =>
        Effect.succeed(rejected("invalid-artifact", "the download could not be checked")),
      ),
    );
    if (verdict._tag === "Verified") {
      verifiedDigests.set(file, digest);
      return verdict;
    }
    verifiedDigests.delete(file);
    // A rejected download is never offered again; the next check downloads afresh.
    yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
    yield* logWarning("removed a downloaded update that failed its check", {
      version: input.version,
      detail: verdict.detail,
    });
    return verdict;
  });

  return UpdateSeams.DesktopUpdateArtifactVerifier.of({ verify });
});

/** Needs the feed gate, the desktop environment, a FileSystem and a ChildProcessSpawner. */
export const layer = Layer.effect(UpdateSeams.DesktopUpdateArtifactVerifier, make);
