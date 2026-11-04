#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off preferSchemaOverJson:off - Maintainer release tool: plain Node so it can run on the publishing Mac without the app runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeUtil from "node:util";
import Plist from "plist";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifest,
} from "./lib/update-manifest.ts";
import * as Seams from "./lib/update-release-seams.ts";

/**
 * Publishes one verified desktop release to the Stark update feed.
 *
 * Order matters, because an updater can read the feed at any moment:
 * 1. every check below passes locally, before any network call;
 * 2. a lock object serializes competing publishers;
 * 3. every artifact (ZIP, DMG, blockmaps) is uploaded under its versioned,
 *    immutable name and read back;
 * 4. only then is the channel manifest (`latest-mac.yml`) replaced, in one
 *    conditional write, so clients never see a manifest that names a file
 *    that is not there yet.
 *
 * Dry run is the default. `--execute` uploads. Nothing here creates
 * credentials: S3 uses the AWS CLI's existing profile, HTTPS uses a token
 * from the environment, and neither is ever printed.
 */

export const CHANNEL_MANIFEST_KEY = "latest-mac.yml";
export const LOCK_KEY = ".publish-lock.json";
const ARTIFACT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CHANNEL_CACHE_CONTROL = "no-cache";
const DEFAULT_ARCHES = ["arm64", "x64"] as const;
const NOTARIZED_DEVELOPER_ID_SOURCE = "Notarized Developer ID";

export interface PublishCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunCommand = (command: string, args: ReadonlyArray<string>) => Promise<CommandResult>;

export interface PublishSeams {
  readonly approvedOrigins: () => ReadonlyArray<string>;
  readonly teamId: () => string | null;
  readonly bundleId: () => string;
  readonly designatedRequirement: (input: { teamId: string; bundleId: string }) => string;
  readonly assertSafeManifestFileUrl: (url: string) => void;
  readonly readBakedPolicy: (appPath: string) => Seams.BakedUpdatePolicy | undefined;
}

export const defaultPublishSeams: PublishSeams = {
  approvedOrigins: Seams.approvedUpdateFeedOrigins,
  teamId: Seams.pinnedAppleTeamId,
  bundleId: Seams.pinnedBundleId,
  designatedRequirement: Seams.designatedRequirementForTeam,
  assertSafeManifestFileUrl: Seams.assertSafeManifestFileUrl,
  readBakedPolicy: (appPath) =>
    Seams.parseBakedUpdatePolicy(Seams.readPackagedAppPackageJson(appPath)),
};

export interface VerifyDeps {
  readonly seams: PublishSeams;
  readonly runCommand: RunCommand;
  readonly makeTempDir: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Versions

interface ParsedVersion {
  readonly core: ReadonlyArray<number>;
  readonly prerelease: ReadonlyArray<string>;
}

function parseVersion(version: string): ParsedVersion {
  const withoutBuild = version.split("+", 1)[0] ?? "";
  const dash = withoutBuild.indexOf("-");
  const core = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split(".").map(Number);
  if (core.length !== 3 || core.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`'${version}' is not a semantic version.`);
  }
  return { core, prerelease: dash === -1 ? [] : withoutBuild.slice(dash + 1).split(".") };
}

/** Semantic-version precedence: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) return Math.sign(Number(l) - Number(r));
    if (lNumeric) return -1;
    if (rNumeric) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Feed URL policy

function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".invalid")) {
    return true;
  }
  if (host.includes(":")) {
    // IPv6 literal: loopback, unspecified, unique-local, link-local or IPv4-mapped.
    return (
      host === "::1" ||
      host === "::" ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("::ffff:")
    );
  }
  const octets = host.split(".").map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

/**
 * The public feed URL must be an approved Stark-owned HTTPS origin. Every
 * problem is returned, so a dry run shows the full list of what still blocks.
 */
export function feedUrlProblems(
  feedUrl: string,
  approvedOrigins: ReadonlyArray<string>,
): ReadonlyArray<string> {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return [`'${feedUrl}' is not a URL`];
  }
  const problems: string[] = [];
  if (url.protocol !== "https:") problems.push("the feed must use https");
  if (url.username !== "" || url.password !== "") problems.push("the feed URL has credentials");
  if (url.search !== "" || url.hash !== "") problems.push("the feed URL has a query or fragment");
  if (!url.pathname.endsWith("/")) problems.push("the feed URL must end in '/'");
  if (isForbiddenHost(url.hostname)) {
    problems.push(`'${url.hostname}' is a loopback, private or local host`);
  }
  const normalizedApproved = approvedOrigins.flatMap((origin) => {
    try {
      return [new URL(origin).origin];
    } catch {
      return [];
    }
  });
  if (normalizedApproved.length === 0) {
    problems.push(
      "no update origin is approved (stark.brand.json updateFeedOrigins is empty; hosting decision S1 is open)",
    );
  } else if (!normalizedApproved.includes(url.origin)) {
    problems.push(`${url.origin} is not an approved update origin`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Local verification

interface ProofArtifact {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface LoadedProof {
  readonly dir: string;
  readonly raw: Record<string, unknown>;
  readonly version: string;
  readonly arch: string;
  readonly commit: string;
  readonly artifacts: ReadonlyArray<ProofArtifact>;
}

export interface VerifiedArtifact {
  readonly arch: string;
  readonly file: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface VerifiedRelease {
  readonly version: string;
  readonly commit: string;
  readonly feedUrl: string;
  readonly arches: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<VerifiedArtifact>;
  readonly manifest: string;
}

export interface VerificationResult {
  readonly checks: ReadonlyArray<PublishCheck>;
  /** Present only when every check passed. */
  readonly release: VerifiedRelease | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

async function digestFile(filePath: string, algorithm: "sha256" | "sha512") {
  const hash = NodeCrypto.createHash(algorithm);
  for await (const chunk of NodeFS.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash;
}

const contentTypeFor = (file: string) =>
  file.endsWith(".zip")
    ? "application/zip"
    : file.endsWith(".dmg")
      ? "application/x-apple-diskimage"
      : file.endsWith(".yml")
        ? "text/yaml"
        : "application/octet-stream";

async function loadProof(dir: string): Promise<LoadedProof | string> {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = asRecord(
      JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "release-proof.json"), "utf8")),
    );
  } catch (cause) {
    return `no readable release-proof.json in ${dir} (${String(cause)})`;
  }
  if (raw === undefined || raw["schema"] !== 1) return `${dir}: unsupported release-proof schema`;
  const artifacts = Array.isArray(raw["artifacts"]) ? raw["artifacts"] : [];
  const parsedArtifacts = artifacts.flatMap((entry) => {
    const record = asRecord(entry);
    return record &&
      typeof record["file"] === "string" &&
      typeof record["bytes"] === "number" &&
      typeof record["sha256"] === "string"
      ? [{ file: record["file"], bytes: record["bytes"], sha256: record["sha256"] }]
      : [];
  });
  if (
    typeof raw["version"] !== "string" ||
    typeof raw["arch"] !== "string" ||
    typeof raw["commit"] !== "string"
  ) {
    return `${dir}: release-proof.json lacks version, arch or commit`;
  }
  return {
    dir,
    raw,
    version: raw["version"],
    arch: raw["arch"],
    commit: raw["commit"],
    artifacts: parsedArtifacts,
  };
}

function checkProofPolicy(
  proof: LoadedProof,
  input: { readonly feedUrl: string; readonly teamId: string | null },
): ReadonlyArray<PublishCheck> {
  const mac = asRecord(proof.raw["mac"]) ?? {};
  const feed = asRecord(proof.raw["feed"]);
  const policy = asRecord(proof.raw["policy"]);
  const label = `${proof.arch} (${proof.dir})`;
  const distributable =
    mac["distributable"] === true &&
    mac["signingMode"] === "developer-id" &&
    mac["appStapled"] === true &&
    mac["dmgStapled"] === true &&
    mac["gatekeeper"] === NOTARIZED_DEVELOPER_ID_SOURCE;
  // U0 writes the packaged feed into the proof as kind `stark`; `mock` and the
  // old `github` kind never publish.
  const feedKindOk = feed?.["kind"] === "stark";
  const feedUrlOk = feed?.["url"] === input.feedUrl;
  const channelOk = (feed?.["channel"] ?? proof.raw["channel"]) === "latest";
  const rehearsal = proof.raw["rehearsal"] ?? policy?.["rehearsal"] ?? null;
  return [
    {
      id: `proof-distributable:${proof.arch}`,
      ok: distributable,
      detail: distributable
        ? `${label}: notarized Developer ID build, app and DMG stapled, Gatekeeper accepted`
        : `${label}: not distributable (mode ${String(mac["signingMode"])}, distributable ${String(mac["distributable"])}, gatekeeper ${String(mac["gatekeeper"])})`,
    },
    {
      id: `proof-feed:${proof.arch}`,
      ok: feedKindOk && feedUrlOk && channelOk,
      detail:
        feedKindOk && feedUrlOk && channelOk
          ? `${label}: baked feed is the Stark feed ${input.feedUrl} on channel latest`
          : `${label}: baked feed is ${JSON.stringify(feed)}; expected kind stark, url ${input.feedUrl}, channel latest`,
    },
    {
      id: `proof-not-rehearsal:${proof.arch}`,
      ok: rehearsal === null,
      detail:
        rehearsal === null
          ? `${label}: no rehearsal profile or fault baked in`
          : `${label}: carries a rehearsal profile or fault and must never be published`,
    },
    {
      id: `proof-team:${proof.arch}`,
      ok: input.teamId !== null && mac["teamId"] === input.teamId,
      detail:
        input.teamId === null
          ? "no Apple Team ID is pinned (stark.brand.json appleTeamId; signing decision S2 is open)"
          : mac["teamId"] === input.teamId
            ? `${label}: signed by team ${input.teamId}`
            : `${label}: signed by team ${String(mac["teamId"])}, expected ${input.teamId}`,
    },
  ];
}

async function verifyArtifactFiles(
  proof: LoadedProof,
): Promise<{ checks: PublishCheck[]; artifacts: VerifiedArtifact[] }> {
  const checks: PublishCheck[] = [];
  const artifacts: VerifiedArtifact[] = [];
  const required = [".zip", ".zip.blockmap", ".dmg"].map((suffix) => `-${proof.arch}${suffix}`);
  for (const suffix of required) {
    const present = proof.artifacts.some((artifact) => artifact.file.endsWith(suffix));
    checks.push({
      id: `artifact-present:${proof.arch}${suffix.slice(proof.arch.length + 1)}`,
      ok: present,
      detail: present
        ? `${proof.arch}: proof lists a *${suffix}`
        : `${proof.arch}: proof lists no *${suffix}`,
    });
  }
  for (const artifact of proof.artifacts) {
    if (artifact.file === "latest-mac.yml" || !/\.(zip|dmg|blockmap)$/.test(artifact.file)) {
      continue;
    }
    const filePath = NodePath.join(proof.dir, artifact.file);
    let ok = false;
    let detail: string;
    try {
      const stat = await NodeFSP.stat(filePath);
      const sha256 = (await digestFile(filePath, "sha256")).digest("hex");
      ok = stat.size === artifact.bytes && sha256 === artifact.sha256;
      detail = ok
        ? `${artifact.file}: ${stat.size} bytes, sha256 matches the proof`
        : `${artifact.file}: size or sha256 differs from release-proof.json`;
      if (ok) {
        artifacts.push({
          arch: proof.arch,
          file: artifact.file,
          path: filePath,
          bytes: stat.size,
          sha256,
          contentType: contentTypeFor(artifact.file),
        });
      }
    } catch (cause) {
      detail = `${artifact.file}: unreadable (${String(cause)})`;
    }
    checks.push({ id: `artifact-hash:${artifact.file}`, ok, detail });
  }
  return { checks, artifacts };
}

async function verifyManifest(
  proofs: ReadonlyArray<LoadedProof>,
  artifacts: ReadonlyArray<VerifiedArtifact>,
  input: { readonly version: string; readonly arches: ReadonlyArray<string>; seams: PublishSeams },
): Promise<{ checks: PublishCheck[]; manifest: string | undefined }> {
  const checks: PublishCheck[] = [];
  let merged: UpdateManifest | undefined;
  try {
    for (const proof of proofs) {
      const manifestPath = NodePath.join(proof.dir, CHANNEL_MANIFEST_KEY);
      const parsed = parseUpdateManifest(
        await NodeFSP.readFile(manifestPath, "utf8"),
        manifestPath,
        "macOS",
      );
      merged = merged === undefined ? parsed : mergeUpdateManifests(merged, parsed, "macOS");
    }
  } catch (cause) {
    checks.push({ id: "manifest-parse", ok: false, detail: String(cause) });
    return { checks, manifest: undefined };
  }
  if (merged === undefined) {
    checks.push({ id: "manifest-parse", ok: false, detail: "no build manifest found" });
    return { checks, manifest: undefined };
  }
  checks.push({
    id: "manifest-version",
    ok: merged.version === input.version,
    detail: `manifest version ${merged.version}, proofs ${input.version}`,
  });
  const kind = merged.extras[Seams.MANIFEST_FEED_KIND_KEY];
  checks.push({
    id: "manifest-kind",
    ok: kind === undefined || kind === "stark",
    detail:
      kind === undefined || kind === "stark"
        ? "manifest does not declare a mock feed"
        : `manifest declares ${Seams.MANIFEST_FEED_KIND_KEY}: ${String(kind)}`,
  });
  for (const file of merged.files) {
    let safe = true;
    try {
      input.seams.assertSafeManifestFileUrl(file.url);
    } catch (cause) {
      safe = false;
      checks.push({ id: `manifest-url:${file.url}`, ok: false, detail: String(cause) });
    }
    if (!safe) continue;
    const artifact = artifacts.find((candidate) => candidate.file === file.url);
    if (artifact === undefined) {
      checks.push({
        id: `manifest-file:${file.url}`,
        ok: false,
        detail: `${file.url} is not a verified artifact of this release`,
      });
      continue;
    }
    const sha512 = (await digestFile(artifact.path, "sha512")).digest("base64");
    const ok = sha512 === file.sha512 && artifact.bytes === file.size;
    checks.push({
      id: `manifest-file:${file.url}`,
      ok,
      detail: ok
        ? `${file.url}: sha512 and size match the file`
        : `${file.url}: manifest sha512 or size does not match the file`,
    });
  }
  for (const arch of input.arches) {
    const listed = merged.files.some((file) => file.url.endsWith(`-${arch}.zip`));
    checks.push({
      id: `manifest-arch:${arch}`,
      ok: listed,
      detail: listed ? `manifest lists the ${arch} ZIP` : `manifest lists no ${arch} ZIP`,
    });
  }
  return {
    checks,
    manifest: serializeUpdateManifest(merged, { platformLabel: "macOS" }),
  };
}

function parseFlatYaml(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/);
    if (match?.[1] && match[2] !== undefined) {
      entries[match[1]] = match[2].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
    }
  }
  return entries;
}

/**
 * Extracts the update ZIP and checks the app inside against the pinned Stark
 * identity and the feed it is about to be published to.
 */
async function verifyUpdatePayload(
  artifact: VerifiedArtifact,
  input: {
    readonly version: string;
    readonly feedUrl: string;
    readonly teamId: string | null;
    readonly deps: VerifyDeps;
  },
): Promise<ReadonlyArray<PublishCheck>> {
  const id = (name: string) => `payload-${name}:${artifact.arch}`;
  const tempDir = await input.deps.makeTempDir();
  try {
    const extracted = await input.deps.runCommand("ditto", ["-x", "-k", artifact.path, tempDir]);
    if (extracted.exitCode !== 0) {
      return [{ id: id("extract"), ok: false, detail: `ditto could not extract ${artifact.file}` }];
    }
    const apps = (await NodeFSP.readdir(tempDir)).filter((entry) => entry.endsWith(".app"));
    if (apps.length !== 1 || apps[0] === undefined) {
      return [
        {
          id: id("extract"),
          ok: false,
          detail: `${artifact.file} holds ${apps.length} apps, not 1`,
        },
      ];
    }
    const appPath = NodePath.join(tempDir, apps[0]);
    const checks: PublishCheck[] = [];
    const bundleId = input.deps.seams.bundleId();

    if (input.teamId === null) {
      checks.push({
        id: id("signature"),
        ok: false,
        detail: "no pinned Team ID to verify against",
      });
    } else {
      try {
        const requirement = input.deps.seams.designatedRequirement({
          teamId: input.teamId,
          bundleId,
        });
        const verified = await input.deps.runCommand("codesign", [
          "--verify",
          "--deep",
          "--strict",
          "--verbose=2",
          "-R",
          `=${requirement}`,
          appPath,
        ]);
        checks.push({
          id: id("signature"),
          ok: verified.exitCode === 0,
          detail:
            verified.exitCode === 0
              ? `codesign accepts the app against the pinned requirement for team ${input.teamId}`
              : `codesign rejects the app: ${verified.stderr.trim().split("\n").at(-1) ?? ""}`,
        });
      } catch (cause) {
        checks.push({ id: id("signature"), ok: false, detail: String(cause) });
      }
    }

    try {
      const info = asRecord(
        Plist.parse(
          await NodeFSP.readFile(NodePath.join(appPath, "Contents", "Info.plist"), "utf8"),
        ),
      );
      const identityOk =
        info?.["CFBundleIdentifier"] === bundleId &&
        info["CFBundleShortVersionString"] === input.version;
      checks.push({
        id: id("bundle"),
        ok: identityOk,
        detail: identityOk
          ? `bundle ${bundleId} version ${input.version}`
          : `bundle ${String(info?.["CFBundleIdentifier"])} version ${String(info?.["CFBundleShortVersionString"])}; expected ${bundleId} ${input.version}`,
      });
    } catch (cause) {
      checks.push({
        id: id("bundle"),
        ok: false,
        detail: `Info.plist unreadable: ${String(cause)}`,
      });
    }

    try {
      const updateConfig = parseFlatYaml(
        await NodeFSP.readFile(
          NodePath.join(appPath, "Contents", "Resources", "app-update.yml"),
          "utf8",
        ),
      );
      const ok =
        updateConfig["provider"] === "generic" &&
        updateConfig["url"] === input.feedUrl &&
        updateConfig["channel"] === "latest";
      checks.push({
        id: id("app-update-yml"),
        ok,
        detail: ok
          ? `app-update.yml points at ${input.feedUrl} on channel latest`
          : `app-update.yml is provider ${String(updateConfig["provider"])}, url ${String(updateConfig["url"])}, channel ${String(updateConfig["channel"])}`,
      });
    } catch (cause) {
      checks.push({
        id: id("app-update-yml"),
        ok: false,
        detail: `no readable app-update.yml: ${String(cause)}`,
      });
    }

    try {
      const policy = input.deps.seams.readBakedPolicy(appPath);
      const ok =
        policy !== undefined &&
        policy.kind === "stark" &&
        policy.url === input.feedUrl &&
        policy.rehearsal === null &&
        policy.appleTeamId === input.teamId;
      checks.push({
        id: id("baked-policy"),
        ok,
        detail: ok
          ? "baked policy is the Stark feed with the pinned team and no rehearsal profile"
          : policy === undefined
            ? "the app carries no baked update policy"
            : `baked policy is kind ${policy.kind}, url ${String(policy.url)}, team ${String(policy.appleTeamId)}, rehearsal ${policy.rehearsal === null ? "none" : "present"}`,
      });
    } catch (cause) {
      checks.push({ id: id("baked-policy"), ok: false, detail: String(cause) });
    }
    return checks;
  } finally {
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Runs every local check. Nothing here touches the network, so a dry run
 * always reports the complete list of gates that still block a release.
 */
export async function verifyRelease(
  input: {
    readonly buildDirs: ReadonlyArray<string>;
    readonly feedUrl: string;
    readonly arches: ReadonlyArray<string>;
  },
  deps: VerifyDeps,
): Promise<VerificationResult> {
  const checks: PublishCheck[] = [];
  const urlProblems = feedUrlProblems(input.feedUrl, deps.seams.approvedOrigins());
  checks.push({
    id: "feed-url",
    ok: urlProblems.length === 0,
    detail: urlProblems.length === 0 ? `${input.feedUrl} is approved` : urlProblems.join("; "),
  });

  const proofs: LoadedProof[] = [];
  for (const dir of input.buildDirs) {
    const proof = await loadProof(NodePath.resolve(dir));
    if (typeof proof === "string") {
      checks.push({ id: `proof:${dir}`, ok: false, detail: proof });
    } else {
      proofs.push(proof);
    }
  }
  const versions = new Set(proofs.map((proof) => proof.version));
  const commits = new Set(proofs.map((proof) => proof.commit));
  const proofArches = proofs.map((proof) => proof.arch).toSorted();
  const wantedArches = [...input.arches].toSorted();
  checks.push({
    id: "same-release",
    ok: proofs.length > 0 && versions.size === 1 && commits.size === 1,
    detail: `versions ${[...versions].join(", ") || "none"}; commits ${[...commits].join(", ") || "none"}`,
  });
  checks.push({
    id: "arch-complete",
    ok: proofArches.join(",") === wantedArches.join(","),
    detail: `builds for ${proofArches.join(", ") || "nothing"}; required ${wantedArches.join(", ")}`,
  });
  const version = proofs[0]?.version ?? "";
  if (version !== "") {
    try {
      parseVersion(version);
    } catch (cause) {
      checks.push({ id: "version", ok: false, detail: String(cause) });
    }
  }

  const teamId = deps.seams.teamId();
  const artifacts: VerifiedArtifact[] = [];
  for (const proof of proofs) {
    checks.push(...checkProofPolicy(proof, { feedUrl: input.feedUrl, teamId }));
    const files = await verifyArtifactFiles(proof);
    checks.push(...files.checks);
    artifacts.push(...files.artifacts);
  }

  const manifest = await verifyManifest(proofs, artifacts, {
    version,
    arches: input.arches,
    seams: deps.seams,
  });
  checks.push(...manifest.checks);

  for (const zip of artifacts.filter((artifact) => artifact.file.endsWith(".zip"))) {
    checks.push(
      ...(await verifyUpdatePayload(zip, { version, feedUrl: input.feedUrl, teamId, deps })),
    );
  }

  const passed = checks.every((check) => check.ok) && manifest.manifest !== undefined;
  return {
    checks,
    release:
      passed && manifest.manifest !== undefined
        ? {
            version,
            commit: proofs[0]?.commit ?? "",
            feedUrl: input.feedUrl,
            arches: input.arches,
            artifacts,
            manifest: manifest.manifest,
          }
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Upload plan and execution

export interface FeedObject {
  readonly etag: string;
  readonly bytes: number;
  /** Hex sha256 when the store keeps it as metadata. */
  readonly sha256: string | undefined;
}

export type FeedBody = { readonly path: string } | { readonly bytes: Uint8Array };

export interface FeedPutOptions {
  readonly contentType: string;
  readonly cacheControl: string;
  readonly sha256: string;
}

/** The few conditional operations publishing needs from an object store. */
export interface FeedObjectClient {
  readonly describe: string;
  head(key: string): Promise<FeedObject | undefined>;
  get(key: string): Promise<{ readonly object: FeedObject; readonly body: Uint8Array } | undefined>;
  /** Creates the object only if the key is free. */
  putIfAbsent(key: string, body: FeedBody, options: FeedPutOptions): Promise<"created" | "exists">;
  /** Replaces the object only if it still has `expected` (an etag), or is still absent. */
  putIfMatch(
    key: string,
    body: FeedBody,
    options: FeedPutOptions,
    expected: { readonly etag: string } | "absent",
  ): Promise<"written" | "conflict">;
  delete(key: string): Promise<void>;
}

export interface UploadStep {
  readonly order: number;
  readonly kind: "lock" | "artifact" | "verify" | "channel" | "unlock";
  readonly key: string;
  readonly condition: "if-absent" | "if-match" | "read-back" | "delete";
  readonly bytes: number;
  readonly sha256?: string;
}

const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** The ordered steps `--execute` performs; a dry run prints them. */
export function planUpload(release: VerifiedRelease): ReadonlyArray<UploadStep> {
  const manifestBytes = new TextEncoder().encode(release.manifest);
  const steps: Omit<UploadStep, "order">[] = [
    { kind: "lock", key: LOCK_KEY, condition: "if-absent", bytes: 0 },
    ...release.artifacts.map((artifact) => ({
      kind: "artifact" as const,
      key: artifact.file,
      condition: "if-absent" as const,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
    ...release.artifacts.map((artifact) => ({
      kind: "verify" as const,
      key: artifact.file,
      condition: "read-back" as const,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
    {
      kind: "channel",
      key: CHANNEL_MANIFEST_KEY,
      condition: "if-match",
      bytes: manifestBytes.length,
      sha256: sha256Hex(manifestBytes),
    },
    { kind: "unlock", key: LOCK_KEY, condition: "delete", bytes: 0 },
  ];
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}

export class PublishRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRefusedError";
  }
}

export interface UploadOutcome {
  readonly uploaded: ReadonlyArray<string>;
  readonly alreadyPresent: ReadonlyArray<string>;
  readonly previousManifest: string | null;
  readonly previousVersion: string | null;
}

async function sha256OfStored(client: FeedObjectClient, key: string, head: FeedObject) {
  if (head.sha256 !== undefined) return head.sha256;
  const stored = await client.get(key);
  return stored === undefined ? undefined : sha256Hex(stored.body);
}

/**
 * Publishes a verified release. Artifacts are immutable: an existing key with
 * the same bytes is reused, different bytes stop the publish. The channel
 * manifest goes last, in one conditional write against the version read at
 * the start, so a competing publisher that skipped the lock still loses.
 */
export async function executeUpload(
  release: VerifiedRelease,
  client: FeedObjectClient,
  options: { readonly now: () => Date; readonly nonce: string },
): Promise<UploadOutcome> {
  const lockBody = new TextEncoder().encode(
    `${JSON.stringify({ version: release.version, startedAt: options.now().toISOString(), nonce: options.nonce })}\n`,
  );
  const lock = await client.putIfAbsent(
    LOCK_KEY,
    { bytes: lockBody },
    { contentType: "application/json", cacheControl: "no-store", sha256: sha256Hex(lockBody) },
  );
  if (lock === "exists") {
    const holder = await client.get(LOCK_KEY);
    throw new PublishRefusedError(
      `Another publish holds ${LOCK_KEY} (${holder === undefined ? "gone now" : new TextDecoder().decode(holder.body).trim()}). Wait for it, or remove the lock by hand after confirming nobody is publishing.`,
    );
  }

  try {
    const current = await client.get(CHANNEL_MANIFEST_KEY);
    let previousVersion: string | null = null;
    const previousManifest = current === undefined ? null : new TextDecoder().decode(current.body);
    if (previousManifest !== null) {
      const parsed = parseUpdateManifest(previousManifest, CHANNEL_MANIFEST_KEY, "macOS");
      previousVersion = parsed.version;
      if (parsed.extras[Seams.MANIFEST_FEED_KIND_KEY] === "mock") {
        throw new PublishRefusedError(
          "The live channel manifest declares the mock feed. Investigate before publishing.",
        );
      }
      if (compareVersions(release.version, parsed.version) <= 0) {
        throw new PublishRefusedError(
          `The feed already offers ${parsed.version}; ${release.version} would not be newer. Downgrades and re-publishes are refused.`,
        );
      }
    }

    const uploaded: string[] = [];
    const alreadyPresent: string[] = [];
    for (const artifact of release.artifacts) {
      const putOptions = {
        contentType: artifact.contentType,
        cacheControl: ARTIFACT_CACHE_CONTROL,
        sha256: artifact.sha256,
      };
      const existing = await client.head(artifact.file);
      const result =
        existing === undefined
          ? await client.putIfAbsent(artifact.file, { path: artifact.path }, putOptions)
          : "exists";
      if (result === "created") {
        uploaded.push(artifact.file);
        continue;
      }
      const stored = existing ?? (await client.head(artifact.file));
      const storedSha =
        stored === undefined ? undefined : await sha256OfStored(client, artifact.file, stored);
      if (storedSha !== artifact.sha256) {
        throw new PublishRefusedError(
          `${artifact.file} already exists in the feed with different bytes. Artifacts are immutable; publish a new version instead.`,
        );
      }
      alreadyPresent.push(artifact.file);
    }

    for (const artifact of release.artifacts) {
      const stored = await client.head(artifact.file);
      if (stored === undefined || stored.bytes !== artifact.bytes) {
        throw new PublishRefusedError(
          `${artifact.file} did not read back with ${artifact.bytes} bytes; the channel manifest was not changed.`,
        );
      }
    }

    const manifestBytes = new TextEncoder().encode(release.manifest);
    const written = await client.putIfMatch(
      CHANNEL_MANIFEST_KEY,
      { bytes: manifestBytes },
      {
        contentType: "text/yaml",
        cacheControl: CHANNEL_CACHE_CONTROL,
        sha256: sha256Hex(manifestBytes),
      },
      current === undefined ? "absent" : { etag: current.object.etag },
    );
    if (written === "conflict") {
      throw new PublishRefusedError(
        `${CHANNEL_MANIFEST_KEY} changed while this publish ran; it was not replaced. The uploaded artifacts are immutable and harmless.`,
      );
    }
    const readBack = await client.get(CHANNEL_MANIFEST_KEY);
    if (readBack === undefined || sha256Hex(readBack.body) !== sha256Hex(manifestBytes)) {
      throw new PublishRefusedError(
        `${CHANNEL_MANIFEST_KEY} did not read back as written. Check the feed by hand.`,
      );
    }
    return { uploaded, alreadyPresent, previousManifest, previousVersion };
  } finally {
    await client.delete(LOCK_KEY);
  }
}

// ---------------------------------------------------------------------------
// Object store clients

async function bodyBytes(body: FeedBody): Promise<Uint8Array> {
  return "bytes" in body ? body.bytes : new Uint8Array(await NodeFSP.readFile(body.path));
}

/**
 * A local directory standing in for the feed. It is a dry run, not a
 * production uploader: it exists to rehearse ordering, immutability and the
 * lock without a network.
 */
export function makeDirectoryFeedClient(root: string): FeedObjectClient {
  const resolve = (key: string) => {
    Seams.assertSafeManifestFileUrl(key.replace(/^\./, "x"));
    return NodePath.join(root, key);
  };
  const statObject = async (key: string): Promise<FeedObject | undefined> => {
    try {
      const bytes = new Uint8Array(await NodeFSP.readFile(resolve(key)));
      const sha256 = sha256Hex(bytes);
      return { etag: sha256, bytes: bytes.length, sha256 };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  };
  const stage = async (key: string, body: FeedBody) => {
    await NodeFSP.mkdir(root, { recursive: true });
    const staged = NodePath.join(root, `.${key}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`);
    await NodeFSP.writeFile(staged, await bodyBytes(body), { flag: "wx" });
    return staged;
  };
  return {
    describe: `dir:${root} (dry run, not a production uploader)`,
    head: statObject,
    get: async (key) => {
      const object = await statObject(key);
      return object === undefined
        ? undefined
        : { object, body: new Uint8Array(await NodeFSP.readFile(resolve(key))) };
    },
    putIfAbsent: async (key, body) => {
      const staged = await stage(key, body);
      try {
        // link() fails when the target exists, which makes the create atomic.
        await NodeFSP.link(staged, resolve(key));
        return "created";
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw cause;
      } finally {
        await NodeFSP.rm(staged, { force: true });
      }
    },
    putIfMatch: async (key, body, _options, expected) => {
      const current = await statObject(key);
      if (expected === "absent" ? current !== undefined : current?.etag !== expected.etag) {
        return "conflict";
      }
      const staged = await stage(key, body);
      await NodeFSP.rename(staged, resolve(key));
      return "written";
    },
    delete: async (key) => {
      await NodeFSP.rm(resolve(key), { force: true });
    },
  };
}

/**
 * S3 or an S3-compatible store through the AWS CLI's existing session.
 * Conditional writes use `--if-none-match '*'` and `--if-match <etag>`;
 * uploads carry a SHA-256 checksum the store verifies.
 */
export function makeS3FeedClient(input: {
  readonly bucket: string;
  readonly prefix: string;
  readonly endpointUrl?: string | undefined;
  readonly profile?: string | undefined;
  readonly runCommand: RunCommand;
  readonly makeTempDir: () => Promise<string>;
}): FeedObjectClient {
  const prefix = input.prefix.replace(/^\/+/, "").replace(/\/?$/, "/").replace(/^\/$/, "");
  const common = [
    ...(input.endpointUrl === undefined ? [] : ["--endpoint-url", input.endpointUrl]),
    ...(input.profile === undefined ? [] : ["--profile", input.profile]),
    "--output",
    "json",
  ];
  const s3api = (args: ReadonlyArray<string>) =>
    input.runCommand("aws", ["s3api", ...args, ...common]);
  const isMissing = (result: CommandResult) => /\b(404|NoSuchKey|Not Found)\b/.test(result.stderr);
  const isPreconditionFailure = (result: CommandResult) =>
    /\b(412|PreconditionFailed|ConditionalRequestConflict|409)\b/.test(result.stderr);
  const key = (name: string) => `${prefix}${name}`;
  const parseHead = (stdout: string): FeedObject => {
    const head = asRecord(JSON.parse(stdout)) ?? {};
    const metadata = asRecord(head["Metadata"]) ?? {};
    return {
      etag: String(head["ETag"] ?? ""),
      bytes: Number(head["ContentLength"] ?? -1),
      sha256: typeof metadata["sha256"] === "string" ? metadata["sha256"] : undefined,
    };
  };
  const withBodyFile = async <A>(body: FeedBody, use: (path: string) => Promise<A>) => {
    if ("path" in body) return use(body.path);
    const dir = await input.makeTempDir();
    const file = NodePath.join(dir, "body");
    try {
      await NodeFSP.writeFile(file, body.bytes);
      return await use(file);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  };
  const put = (name: string, body: FeedBody, options: FeedPutOptions, condition: string[]) =>
    withBodyFile(body, (file) =>
      s3api([
        "put-object",
        "--bucket",
        input.bucket,
        "--key",
        key(name),
        "--body",
        file,
        "--content-type",
        options.contentType,
        "--cache-control",
        options.cacheControl,
        "--metadata",
        `sha256=${options.sha256}`,
        "--checksum-sha256",
        Buffer.from(options.sha256, "hex").toString("base64"),
        ...condition,
      ]),
    );
  const fail = (operation: string, result: CommandResult): never => {
    throw new Error(`aws s3api ${operation} failed: ${result.stderr.trim().split("\n").at(-1)}`);
  };
  return {
    describe: `s3://${input.bucket}/${prefix}${input.endpointUrl ? ` via ${input.endpointUrl}` : ""}`,
    head: async (name) => {
      const result = await s3api(["head-object", "--bucket", input.bucket, "--key", key(name)]);
      if (result.exitCode === 0) return parseHead(result.stdout);
      return isMissing(result) ? undefined : fail("head-object", result);
    },
    get: async (name) => {
      const dir = await input.makeTempDir();
      const file = NodePath.join(dir, "object");
      try {
        const result = await s3api([
          "get-object",
          "--bucket",
          input.bucket,
          "--key",
          key(name),
          file,
        ]);
        if (result.exitCode !== 0)
          return isMissing(result) ? undefined : fail("get-object", result);
        return {
          object: parseHead(result.stdout),
          body: new Uint8Array(await NodeFSP.readFile(file)),
        };
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    },
    putIfAbsent: async (name, body, options) => {
      const result = await put(name, body, options, ["--if-none-match", "*"]);
      if (result.exitCode === 0) return "created";
      return isPreconditionFailure(result) ? "exists" : fail("put-object", result);
    },
    putIfMatch: async (name, body, options, expected) => {
      const result = await put(
        name,
        body,
        options,
        expected === "absent" ? ["--if-none-match", "*"] : ["--if-match", expected.etag],
      );
      if (result.exitCode === 0) return "written";
      return isPreconditionFailure(result) ? "conflict" : fail("put-object", result);
    },
    delete: async (name) => {
      const result = await s3api(["delete-object", "--bucket", input.bucket, "--key", key(name)]);
      if (result.exitCode !== 0) fail("delete-object", result);
    },
  };
}

/**
 * A generic HTTPS object endpoint that honours `If-None-Match: *` and
 * `If-Match` on PUT (WebDAV-style). The bearer token comes from the
 * environment and is never logged.
 */
export function makeHttpsFeedClient(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
}): FeedObjectClient {
  const base = input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`;
  const auth = { authorization: `Bearer ${input.token}` };
  const toObject = (response: Response): FeedObject => ({
    etag: response.headers.get("etag") ?? "",
    bytes: Number(response.headers.get("content-length") ?? -1),
    sha256: response.headers.get("x-stark-sha256") ?? undefined,
  });
  const put = async (
    name: string,
    body: FeedBody,
    options: FeedPutOptions,
    condition: Record<string, string>,
  ) => {
    const payload =
      "bytes" in body
        ? body.bytes
        : (NodeStream.Readable.toWeb(
            NodeFS.createReadStream(body.path),
          ) as ReadableStream<Uint8Array>);
    return input.fetch(new URL(name, base), {
      method: "PUT",
      headers: {
        ...auth,
        ...condition,
        "content-type": options.contentType,
        "cache-control": options.cacheControl,
        "x-stark-sha256": options.sha256,
      },
      body: payload,
      redirect: "error",
      ...("bytes" in body ? {} : { duplex: "half" }),
    } as RequestInit);
  };
  const expectOk = (operation: string, response: Response) => {
    if (!response.ok)
      throw new Error(`${operation} ${response.url} failed with HTTP ${response.status}`);
  };
  return {
    describe: base,
    head: async (name) => {
      const response = await input.fetch(new URL(name, base), {
        method: "HEAD",
        headers: auth,
        redirect: "error",
      });
      if (response.status === 404) return undefined;
      expectOk("HEAD", response);
      return toObject(response);
    },
    get: async (name) => {
      const response = await input.fetch(new URL(name, base), {
        headers: auth,
        redirect: "error",
      });
      if (response.status === 404) return undefined;
      expectOk("GET", response);
      return { object: toObject(response), body: new Uint8Array(await response.arrayBuffer()) };
    },
    putIfAbsent: async (name, body, options) => {
      const response = await put(name, body, options, { "if-none-match": "*" });
      if (response.status === 412) return "exists";
      expectOk("PUT", response);
      return "created";
    },
    putIfMatch: async (name, body, options, expected) => {
      const response = await put(
        name,
        body,
        options,
        expected === "absent" ? { "if-none-match": "*" } : { "if-match": expected.etag },
      );
      if (response.status === 412) return "conflict";
      expectOk("PUT", response);
      return "written";
    },
    delete: async (name) => {
      const response = await input.fetch(new URL(name, base), {
        method: "DELETE",
        headers: auth,
        redirect: "error",
      });
      if (response.status !== 404) expectOk("DELETE", response);
    },
  };
}

/** `s3://bucket/prefix/`, `https://host/path/` or `dir:/absolute/path`. */
export function parsePublishTarget(
  target: string,
):
  | { readonly kind: "s3"; readonly bucket: string; readonly prefix: string }
  | { readonly kind: "https"; readonly url: string }
  | { readonly kind: "dir"; readonly path: string } {
  if (target.startsWith("dir:")) return { kind: "dir", path: NodePath.resolve(target.slice(4)) };
  const url = new URL(target);
  if (url.protocol === "s3:") {
    return { kind: "s3", bucket: url.hostname, prefix: url.pathname };
  }
  if (url.protocol === "https:") return { kind: "https", url: url.toString() };
  throw new Error(`Unsupported publish target '${target}'. Use s3://, https:// or dir:.`);
}

// ---------------------------------------------------------------------------
// CLI

const runCommandWithNode: RunCommand = (command, args) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          exitCode: error === null ? 0 : typeof code === "number" ? code : 127,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

const makeTempDirWithNode = () =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-publish-update-"));

function formatReport(input: {
  readonly checks: ReadonlyArray<PublishCheck>;
  readonly plan: ReadonlyArray<UploadStep>;
  readonly target: string;
  readonly execute: boolean;
}): string {
  const lines = [
    `Publish ${input.execute ? "EXECUTE" : "DRY RUN"} to ${input.target}`,
    "",
    "Checks:",
    ...input.checks.map((check) => `  ${check.ok ? "PASS" : "FAIL"}  ${check.id}: ${check.detail}`),
    "",
  ];
  const blocked = input.checks.filter((check) => !check.ok).length;
  if (blocked > 0) {
    lines.push(`BLOCKED: ${blocked} check(s) failed. Nothing was uploaded.`);
  } else {
    lines.push("Upload plan (channel manifest last):");
    for (const step of input.plan) {
      lines.push(
        `  ${String(step.order).padStart(2)}. ${step.kind.padEnd(8)} ${step.condition.padEnd(9)} ${step.key}${step.bytes > 0 ? ` (${step.bytes} bytes${step.sha256 ? `, sha256 ${step.sha256.slice(0, 16)}…` : ""})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

const usage = `Usage: node scripts/publish-update-feed.ts --build <dir> [--build <dir>] \\
    --feed-url https://<approved origin>/<path>/ --target <s3://bucket/prefix/ | https://… | dir:/path> \\
    [--arch arm64 --arch x64] [--s3-endpoint-url <url>] [--aws-profile <name>] [--record <file>] [--execute]

Dry run by default: verifies every gate locally and prints the upload plan.
--execute uploads artifacts, then replaces latest-mac.yml last.
HTTPS targets read the upload token from STARK_CODE_UPDATE_UPLOAD_TOKEN.`;

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      build: { type: "string", multiple: true },
      "feed-url": { type: "string" },
      target: { type: "string" },
      arch: { type: "string", multiple: true },
      "s3-endpoint-url": { type: "string" },
      "aws-profile": { type: "string" },
      record: { type: "string" },
      execute: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.build?.length || !values["feed-url"] || !values.target) {
    console.error(usage);
    return values.help ? 0 : 2;
  }
  const feedUrl = values["feed-url"];
  const target = parsePublishTarget(values.target);
  const arches = values.arch?.length ? values.arch : [...DEFAULT_ARCHES];
  const deps: VerifyDeps = {
    seams: defaultPublishSeams,
    runCommand: runCommandWithNode,
    makeTempDir: makeTempDirWithNode,
  };

  const verification = await verifyRelease({ buildDirs: values.build, feedUrl, arches }, deps);
  const plan = verification.release === undefined ? [] : planUpload(verification.release);
  console.log(
    formatReport({
      checks: verification.checks,
      plan,
      target: values.target,
      execute: values.execute,
    }),
  );

  let outcome: UploadOutcome | undefined;
  let failure: string | undefined;
  if (values.execute && verification.release !== undefined) {
    const client =
      target.kind === "dir"
        ? makeDirectoryFeedClient(target.path)
        : target.kind === "s3"
          ? makeS3FeedClient({
              bucket: target.bucket,
              prefix: target.prefix,
              endpointUrl: values["s3-endpoint-url"],
              profile: values["aws-profile"],
              runCommand: runCommandWithNode,
              makeTempDir: makeTempDirWithNode,
            })
          : makeHttpsFeedClient({
              baseUrl: target.url,
              token: process.env["STARK_CODE_UPDATE_UPLOAD_TOKEN"] ?? "",
              fetch: globalThis.fetch,
            });
    try {
      outcome = await executeUpload(verification.release, client, {
        now: () => new Date(),
        nonce: NodeCrypto.randomUUID(),
      });
      console.log(
        `Published ${verification.release.version} to ${client.describe}: ${outcome.uploaded.length} uploaded, ${outcome.alreadyPresent.length} already present, channel manifest replaced (was ${outcome.previousVersion ?? "empty"}).`,
      );
    } catch (cause) {
      failure = String(cause instanceof Error ? cause.message : cause);
      console.error(`Publish stopped: ${failure}`);
    }
  }

  const recordPath =
    values.record ?? NodePath.join(NodePath.resolve(values.build[0] ?? "."), "publish-record.json");
  await NodeFSP.writeFile(
    recordPath,
    `${JSON.stringify(
      {
        schema: 1,
        recordedAt: new Date().toISOString(),
        mode: values.execute ? "execute" : "dry-run",
        target: values.target,
        feedUrl,
        arches,
        checks: verification.checks,
        plan,
        outcome: outcome ?? null,
        failure: failure ?? null,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Record: ${recordPath}`);
  if (verification.release === undefined || failure !== undefined) return 1;
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      console.error(cause);
      process.exitCode = 1;
    },
  );
}
