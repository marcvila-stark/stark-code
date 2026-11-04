import type { BrowserCaptureDelivery } from "@starkfuture/contracts";

/** A receipt outlives the draft being sent or discarded, so lost IPC replies cannot duplicate it. */
export async function browserCaptureFingerprint(delivery: BrowserCaptureDelivery): Promise<string> {
  const { capture, target } = delivery;
  const value = JSON.stringify([
    capture.version,
    capture.id,
    capture.kind,
    capture.pageUrl,
    capture.pageTitle,
    capture.capturedAt,
    capture.text,
    capture.note,
    capture.imageDataUrl ?? null,
    capture.imageFallback ?? false,
    target.kind,
    target.environmentId,
    target.projectId,
    target.kind === "thread"
      ? target.threadId
      : target.kind === "draft"
        ? target.draftId
        : target.title,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
