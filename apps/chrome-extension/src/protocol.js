export const HOST = "com.starkcode.capture";
export const LIMITS = Object.freeze({
  text: 6000,
  note: 1000,
  imageBytes: 4 * 1024 * 1024,
  pending: 20,
  pendingBytes: 50 * 1024 * 1024,
});
const credential =
  /^(?:access_token|refresh_token|id_token|token|api_key|apikey|authorization|password|secret|session_token)$/i;

export function cleanSourceUrl(raw) {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Capture a regular web page. Chrome’s internal pages cannot be captured here.");
  url.username = "";
  url.password = "";
  for (const key of Array.from(url.searchParams.keys()))
    if (credential.test(key)) url.searchParams.delete(key);
  if (url.hash.includes("=")) {
    const hash = new URLSearchParams(url.hash.slice(1));
    let changed = false;
    for (const key of Array.from(hash.keys()))
      if (credential.test(key)) {
        hash.delete(key);
        changed = true;
      }
    if (changed) url.hash = hash.toString();
  }
  if (url.href.length > 2048)
    throw new Error("This source URL is too long to attach. Open a shorter page URL first.");
  return url.href;
}

export function imageDataBytes(url) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match || match[2].length % 4 !== 0)
    throw new Error("Use a PNG, JPEG or WebP image, or capture a visible region.");
  return (match[2].length / 4) * 3 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
}

export function assertCapture(capture) {
  if (!capture || capture.version !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(capture.id))
    throw new Error("Invalid capture identity.");
  if (!["text", "image", "region"].includes(capture.kind))
    throw new Error("Unsupported capture type.");
  if (capture.pageUrl !== cleanSourceUrl(capture.pageUrl))
    throw new Error("Review the source URL again before adding this capture.");
  if (
    typeof capture.pageTitle !== "string" ||
    capture.pageTitle.length > 200 ||
    typeof capture.capturedAt !== "string" ||
    capture.capturedAt.length > 40
  )
    throw new Error("Invalid capture source.");
  if (typeof capture.text !== "string" || capture.text.length > LIMITS.text)
    throw new Error(
      `Select up to ${LIMITS.text.toLocaleString()} characters. Nothing was shortened or sent.`,
    );
  if (typeof capture.note !== "string" || capture.note.length > LIMITS.note)
    throw new Error(`Keep the note under ${LIMITS.note.toLocaleString()} characters.`);
  if (capture.kind === "text") {
    if (!capture.text.trim() || capture.imageDataUrl !== undefined)
      throw new Error("Select some text first.");
  } else if (
    typeof capture.imageDataUrl !== "string" ||
    imageDataBytes(capture.imageDataUrl) > LIMITS.imageBytes
  )
    throw new Error("This image is over 4 MB. Capture a smaller region instead.");
  return capture;
}

export function cropPixels(rect, viewport, image) {
  for (const value of [
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    viewport.width,
    viewport.height,
    image.width,
    image.height,
  ])
    if (!Number.isFinite(value)) throw new Error("Invalid capture coordinates.");
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    throw new Error("Draw a screenshot region first.");
  const sx = image.width / viewport.width,
    sy = image.height / viewport.height;
  const left = Math.max(0, Math.min(image.width, Math.floor(rect.x * sx)));
  const top = Math.max(0, Math.min(image.height, Math.floor(rect.y * sy)));
  const right = Math.max(left, Math.min(image.width, Math.ceil((rect.x + rect.width) * sx)));
  const bottom = Math.max(top, Math.min(image.height, Math.ceil((rect.y + rect.height) * sy)));
  if (right === left || bottom === top || (right - left) * (bottom - top) > 32_000_000)
    throw new Error("Choose a smaller visible screenshot region.");
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function checkPendingBudget(records, next) {
  const remaining = records.filter((record) => record.capture.id !== next.capture.id);
  if (remaining.length >= LIMITS.pending)
    throw new Error("You have 20 pending captures. Review or delete one before capturing more.");
  const encoder = new TextEncoder();
  const bytes = [...remaining, next].reduce(
    (sum, record) => sum + encoder.encode(JSON.stringify(record)).byteLength,
    0,
  );
  if (bytes > LIMITS.pendingBytes)
    throw new Error("Pending captures have reached 50 MB. Review or delete one first.");
}
