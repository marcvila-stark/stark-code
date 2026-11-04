import { UPDATE_MANIFEST_FEED_KIND_KEY, checkUpdateFileUrl } from "./update-feed-ownership.ts";

export interface UpdateManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export type UpdateManifestScalar = string | number | boolean;

export interface UpdateManifest {
  readonly version: string;
  readonly releaseDate: string;
  readonly files: ReadonlyArray<UpdateManifestFile>;
  readonly extras: Readonly<Record<string, UpdateManifestScalar>>;
}

interface MutableUpdateManifestFile {
  url?: string;
  sha512?: string;
  size?: number;
}

function stripSingleQuotes(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * A manifest may only name files inside its own feed directory: the same rule
 * the app applies before it downloads anything (see updateFeedPolicy.ts).
 */
function assertFeedRelativeFileUrl(url: string, location: string, platformLabel: string): void {
  const problem = checkUpdateFileUrl(url);
  if (problem !== null) {
    throw new Error(
      `Invalid ${platformLabel} update manifest at ${location}: file url '${url}' is not a plain name inside the feed (${problem}).`,
    );
  }
}

function parseFileRecord(
  currentFile: MutableUpdateManifestFile | null,
  sourcePath: string,
  lineNumber: number,
  platformLabel: string,
): UpdateManifestFile | null {
  if (currentFile === null) {
    return null;
  }
  if (
    typeof currentFile.url !== "string" ||
    typeof currentFile.sha512 !== "string" ||
    typeof currentFile.size !== "number"
  ) {
    throw new Error(
      `Invalid ${platformLabel} update manifest at ${sourcePath}:${lineNumber}: incomplete file entry.`,
    );
  }
  assertFeedRelativeFileUrl(currentFile.url, `${sourcePath}:${lineNumber}`, platformLabel);
  return {
    url: currentFile.url,
    sha512: currentFile.sha512,
    size: currentFile.size,
  };
}

function parseScalarValue(rawValue: string): UpdateManifestScalar {
  const trimmed = rawValue.trim();
  const isQuoted = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2;
  const value = isQuoted ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed;
  if (isQuoted) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

export function parseUpdateManifest(
  raw: string,
  sourcePath: string,
  platformLabel: string,
): UpdateManifest {
  const lines = raw.split(/\r?\n/);
  const files: UpdateManifestFile[] = [];
  const extras: Record<string, UpdateManifestScalar> = {};
  let version: string | null = null;
  let releaseDate: string | null = null;
  let legacyPath: { readonly value: UpdateManifestScalar; readonly lineNumber: number } | null =
    null;
  let inFiles = false;
  let currentFile: MutableUpdateManifestFile | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;

    const fileUrlMatch = line.match(/^  - url:\s*(.+)$/);
    if (fileUrlMatch?.[1]) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber, platformLabel);
      if (finalized) files.push(finalized);
      currentFile = { url: stripSingleQuotes(fileUrlMatch[1].trim()) };
      inFiles = true;
      continue;
    }

    const fileShaMatch = line.match(/^    sha512:\s*(.+)$/);
    if (fileShaMatch?.[1]) {
      if (currentFile === null) {
        throw new Error(
          `Invalid ${platformLabel} update manifest at ${sourcePath}:${lineNumber}: sha512 without a file entry.`,
        );
      }
      currentFile.sha512 = stripSingleQuotes(fileShaMatch[1].trim());
      continue;
    }

    const fileSizeMatch = line.match(/^    size:\s*(\d+)$/);
    if (fileSizeMatch?.[1]) {
      if (currentFile === null) {
        throw new Error(
          `Invalid ${platformLabel} update manifest at ${sourcePath}:${lineNumber}: size without a file entry.`,
        );
      }
      currentFile.size = Number(fileSizeMatch[1]);
      continue;
    }

    if (line === "files:") {
      inFiles = true;
      continue;
    }

    if (inFiles && currentFile !== null) {
      const finalized = parseFileRecord(currentFile, sourcePath, lineNumber, platformLabel);
      if (finalized) files.push(finalized);
      currentFile = null;
    }
    inFiles = false;

    const topLevelMatch = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (!topLevelMatch?.[1] || topLevelMatch[2] === undefined) {
      throw new Error(
        `Invalid ${platformLabel} update manifest at ${sourcePath}:${lineNumber}: unsupported line '${line}'.`,
      );
    }

    const [, key, rawValue] = topLevelMatch;
    const value = parseScalarValue(rawValue);

    if (key === "version") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid ${platformLabel} update manifest at ${sourcePath}:${lineNumber}: version must be a string.`,
        );
      }
      version = value;
      continue;
    }

    if (key === "releaseDate") {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid ${platformLabel} update manifest at ${sourcePath}:${lineNumber}: releaseDate must be a string.`,
        );
      }
      releaseDate = value;
      continue;
    }

    // electron-builder still writes the legacy top-level `path` and `sha512`;
    // they are dropped on output, but `path` must name a listed file.
    if (key === "path") {
      legacyPath = { value, lineNumber };
      continue;
    }
    if (key === "sha512") {
      continue;
    }

    extras[key] = value;
  }

  const finalized = parseFileRecord(currentFile, sourcePath, lines.length, platformLabel);
  if (finalized) files.push(finalized);

  if (!version) {
    throw new Error(`Invalid ${platformLabel} update manifest at ${sourcePath}: missing version.`);
  }
  if (!releaseDate) {
    throw new Error(
      `Invalid ${platformLabel} update manifest at ${sourcePath}: missing releaseDate.`,
    );
  }
  if (files.length === 0) {
    throw new Error(`Invalid ${platformLabel} update manifest at ${sourcePath}: missing files.`);
  }
  if (legacyPath !== null) {
    const location = `${sourcePath}:${legacyPath.lineNumber}`;
    const pathValue = String(legacyPath.value);
    assertFeedRelativeFileUrl(pathValue, location, platformLabel);
    if (!files.some((file) => file.url === pathValue)) {
      throw new Error(
        `Invalid ${platformLabel} update manifest at ${location}: path '${pathValue}' is not one of its files.`,
      );
    }
  }

  return {
    version,
    releaseDate,
    files,
    extras,
  };
}

function mergeExtras(
  primary: Readonly<Record<string, UpdateManifestScalar>>,
  secondary: Readonly<Record<string, UpdateManifestScalar>>,
  platformLabel: string,
): Record<string, UpdateManifestScalar> {
  const merged: Record<string, UpdateManifestScalar> = { ...primary };

  for (const [key, value] of Object.entries(secondary)) {
    const existing = merged[key];
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `Cannot merge ${platformLabel} update manifests: conflicting '${key}' values ('${existing}' vs '${value}').`,
      );
    }
    merged[key] = value;
  }

  return merged;
}

export function mergeUpdateManifests(
  primary: UpdateManifest,
  secondary: UpdateManifest,
  platformLabel: string,
): UpdateManifest {
  if (primary.version !== secondary.version) {
    throw new Error(
      `Cannot merge ${platformLabel} update manifests with different versions (${primary.version} vs ${secondary.version}).`,
    );
  }

  const filesByUrl = new Map<string, UpdateManifestFile>();
  for (const file of [...primary.files, ...secondary.files]) {
    assertFeedRelativeFileUrl(file.url, "merge input", platformLabel);
    const existing = filesByUrl.get(file.url);
    if (existing && (existing.sha512 !== file.sha512 || existing.size !== file.size)) {
      throw new Error(
        `Cannot merge ${platformLabel} update manifests: conflicting file entry for ${file.url}.`,
      );
    }
    filesByUrl.set(file.url, file);
  }

  return {
    version: primary.version,
    releaseDate:
      primary.releaseDate >= secondary.releaseDate ? primary.releaseDate : secondary.releaseDate,
    files: [...filesByUrl.values()],
    extras: mergeExtras(primary.extras, secondary.extras, platformLabel),
  };
}

function quoteYamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function serializeScalarValue(value: UpdateManifestScalar): string {
  if (typeof value === "string") {
    return quoteYamlString(value);
  }
  return String(value);
}

export function serializeUpdateManifest(
  manifest: UpdateManifest,
  options: {
    readonly platformLabel: string;
  },
): string {
  const lines = [`version: ${quoteYamlString(manifest.version)}`, "files:"];

  for (const file of manifest.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }

  for (const key of Object.keys(manifest.extras).toSorted()) {
    const value = manifest.extras[key];
    if (value === undefined) {
      throw new Error(
        `Cannot serialize ${options.platformLabel} update manifest: missing value for '${key}'.`,
      );
    }
    lines.push(`${key}: ${serializeScalarValue(value)}`);
  }

  lines.push(`releaseDate: ${quoteYamlString(manifest.releaseDate)}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Rewrites one file's digest in an electron-builder update manifest after the
 * file changed on disk, leaving every other line as electron-builder wrote it.
 * The legacy top-level `sha512` follows when the top-level `path` names the
 * same file. A manifest that does not list the file is returned unchanged.
 */
export function replaceUpdateManifestFileDigest(raw: string, file: UpdateManifestFile): string {
  const lines = raw.split("\n");
  const topLevelPath = lines
    .map((line) => line.match(/^path:\s*(.+?)\s*$/)?.[1])
    .find((value) => value !== undefined);
  const updatesTopLevelDigest =
    topLevelPath !== undefined && stripSingleQuotes(topLevelPath) === file.url;

  let inFileEntry = false;
  let replacedFields = 0;
  const next = lines.map((line) => {
    const urlMatch = line.match(/^  - url:\s*(.+?)\s*$/);
    if (urlMatch?.[1] !== undefined) {
      inFileEntry = stripSingleQuotes(urlMatch[1]) === file.url;
      return line;
    }
    if (!line.startsWith("    ")) inFileEntry = false;
    if (inFileEntry && line.startsWith("    sha512:")) {
      replacedFields += 1;
      return `    sha512: ${file.sha512}`;
    }
    if (inFileEntry && line.startsWith("    size:")) {
      replacedFields += 1;
      return `    size: ${file.size}`;
    }
    if (updatesTopLevelDigest && line.startsWith("sha512:")) return `sha512: ${file.sha512}`;
    return line;
  });
  return replacedFields === 0 ? raw : next.join("\n");
}

/**
 * Marks an electron-builder channel manifest as made for the mock feed
 * (`starkFeedKind: mock`), replacing any earlier mark and leaving every other
 * line as written. Only the mock server serves such a manifest, and only a
 * mock build follows one.
 */
export function withMockFeedKind(raw: string): string {
  const marker = new RegExp(`^${UPDATE_MANIFEST_FEED_KIND_KEY}:`, "u");
  const lines = raw.split("\n").filter((line) => !marker.test(line));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return `${[...lines, `${UPDATE_MANIFEST_FEED_KIND_KEY}: mock`].join("\n")}\n`;
}
