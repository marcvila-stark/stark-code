import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BROWSER_CAPTURE_HOST = "com.starkcode.capture";
export const BROWSER_CAPTURE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const BROWSER_CAPTURE_MAX_TEXT_CHARS = 6_000;
export const BROWSER_CAPTURE_MAX_PENDING = 20;
export const BROWSER_CAPTURE_MAX_PENDING_BYTES = 50 * 1024 * 1024;
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
// Destination identifiers are opaque environment-owned IDs, not file names.
const entityId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const BrowserCaptureExtensionId = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/));
export const BrowserCapture = Schema.Struct({
  version: Schema.Literal(1),
  id,
  kind: Schema.Literals(["text", "image", "region"]),
  pageUrl: bounded(2_048).check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
  ),
  pageTitle: bounded(200),
  capturedAt: bounded(40),
  text: bounded(BROWSER_CAPTURE_MAX_TEXT_CHARS),
  note: bounded(1_000),
  imageDataUrl: Schema.optionalKey(
    bounded(Math.ceil((BROWSER_CAPTURE_MAX_IMAGE_BYTES * 4) / 3) + 100).check(
      Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
    ),
  ),
  imageFallback: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter((capture) =>
    capture.kind === "text"
      ? capture.text.length > 0 && capture.imageDataUrl === undefined
      : capture.imageDataUrl !== undefined,
  ),
);
export type BrowserCapture = typeof BrowserCapture.Type;

export const BrowserCaptureTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    environmentId: entityId,
    projectId: entityId,
    threadId: entityId,
  }),
  Schema.Struct({
    kind: Schema.Literal("draft"),
    environmentId: entityId,
    projectId: entityId,
    draftId: entityId,
  }),
  Schema.Struct({
    kind: Schema.Literal("new"),
    environmentId: entityId,
    projectId: entityId,
    title: bounded(120),
  }),
]);
export type BrowserCaptureTarget = typeof BrowserCaptureTarget.Type;
export const BrowserCaptureDestination = Schema.Struct({
  target: BrowserCaptureTarget,
  label: bounded(200),
  projectLabel: bounded(200),
  environmentLabel: bounded(200),
  current: Schema.Boolean,
});
export type BrowserCaptureDestination = typeof BrowserCaptureDestination.Type;
export const BrowserCaptureCatalog = Schema.Struct({
  destinations: Schema.Array(BrowserCaptureDestination).check(Schema.isMaxLength(500)),
  projects: Schema.Array(
    Schema.Struct({
      environmentId: entityId,
      projectId: entityId,
      label: bounded(200),
      environmentLabel: bounded(200),
    }),
  ).check(Schema.isMaxLength(200)),
});
export type BrowserCaptureCatalog = typeof BrowserCaptureCatalog.Type;
export const BrowserCaptureDelivery = Schema.Struct({
  capture: BrowserCapture,
  target: BrowserCaptureTarget,
});
export type BrowserCaptureDelivery = typeof BrowserCaptureDelivery.Type;
export const BrowserCaptureReceipt = Schema.Struct({
  id,
  state: Schema.Literals(["pending", "saved", "error"]),
  message: bounded(1_000),
});
export type BrowserCaptureReceipt = typeof BrowserCaptureReceipt.Type;
export const BrowserCaptureDesktopCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("connect"), extensionId: BrowserCaptureExtensionId }),
  Schema.Struct({ action: Schema.Literal("disconnect") }),
  Schema.Struct({ action: Schema.Literal("publish"), catalog: BrowserCaptureCatalog }),
  Schema.Struct({
    action: Schema.Literal("pending"),
    environmentIds: Schema.optionalKey(Schema.Array(entityId).check(Schema.isMaxLength(200))),
  }),
  Schema.Struct({ action: Schema.Literal("complete"), receipt: BrowserCaptureReceipt }),
]);
export type BrowserCaptureDesktopCommand = typeof BrowserCaptureDesktopCommand.Type;
export const BrowserCaptureDesktopResult = Schema.Struct({
  connected: Schema.Boolean,
  extensionId: Schema.optionalKey(BrowserCaptureExtensionId),
  pending: Schema.optionalKey(Schema.Array(BrowserCaptureDelivery)),
});
export type BrowserCaptureDesktopResult = typeof BrowserCaptureDesktopResult.Type;

/** Browser-origin text is quoted user context, never a system or permission instruction. */
export function browserCaptureComment(capture: BrowserCapture): string {
  return [
    `Browser ${capture.kind} capture · ${capture.capturedAt}`,
    ...(capture.text
      ? ["Selected text (external page content):", capture.text, "End of selected text."]
      : []),
    ...(capture.note ? [`Your note: ${capture.note}`] : []),
    ...(capture.imageFallback ? ["Image captured from the visible page."] : []),
  ].join("\n\n");
}
