/**
 * The headless browser Stark keeps for HTML previews (`html_preview`) and
 * server browser tabs. It is installed when the user asks for it, never by an
 * agent's tool call, so clients and agents read this status before relying on it.
 *
 * @module PreviewBrowser
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const PreviewBrowserState = Schema.Literals([
  "ready",
  "not-installed",
  "installing",
  "failed",
  "unsupported",
]);
export type PreviewBrowserState = typeof PreviewBrowserState.Type;

export const PreviewBrowserStatus = Schema.Struct({
  state: PreviewBrowserState,
  /** Download size of the build Stark pins for this host; null where it has none. */
  totalBytes: Schema.NullOr(NonNegativeInt),
  /** While installing: bytes downloaded so far. */
  downloadedBytes: Schema.optionalKey(NonNegativeInt),
  /** While installing: the download finished and the archive is being unpacked. */
  unpacking: Schema.optionalKey(Schema.Boolean),
  /** After a failed install: what went wrong, written for the user. */
  failure: Schema.optionalKey(Schema.String),
});
export type PreviewBrowserStatus = typeof PreviewBrowserStatus.Type;

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

/** "about 99 MB", the size a user agrees to download; null where Stark has no build. */
export function previewBrowserDownloadSize(status: PreviewBrowserStatus): string | null {
  return status.totalBytes === null ? null : `about ${megabytes(status.totalBytes)} MB`;
}

/** "37 of 99 MB downloaded" or "unpacking" while an install runs; null otherwise. */
export function previewBrowserInstallProgress(status: PreviewBrowserStatus): string | null {
  if (status.state !== "installing") return null;
  if (status.unpacking === true) return "unpacking";
  const total = status.totalBytes === null ? "" : ` of ${megabytes(status.totalBytes)}`;
  return `${megabytes(status.downloadedBytes ?? 0)}${total} MB downloaded`;
}
