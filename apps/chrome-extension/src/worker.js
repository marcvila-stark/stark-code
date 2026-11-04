import { HOST, LIMITS, assertCapture, cleanSourceUrl, cropPixels } from "./protocol.js";
import { listPending, readPending, savePending, deletePending } from "./pending.js";
import { beginRegionSelection } from "./region.js";

const MENU_TEXT = "stark-selection",
  MENU_IMAGE = "stark-image";
const ownPage = (sender) =>
  sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(""));
async function native(message) {
  const response = await chrome.runtime.sendNativeMessage(HOST, message);
  if (!response?.ok)
    throw new Error(
      response?.error || "Connect this extension in Stark Code settings, then retry.",
    );
  return response.result;
}
async function popup() {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.action.setBadgeText({ text: "•" });
  }
}
async function failure(error) {
  await chrome.storage.session.set({
    captureError: error instanceof Error ? error.message : String(error),
  });
  await chrome.action.setBadgeText({ text: "!" });
  await popup();
}
function source(tab) {
  return {
    pageUrl: cleanSourceUrl(tab.url),
    pageTitle: (tab.title || new URL(tab.url).hostname).slice(0, 200),
  };
}
function createCapture(tab, kind, extras = {}) {
  return assertCapture({
    version: 1,
    id: crypto.randomUUID(),
    kind,
    ...source(tab),
    capturedAt: new Date().toISOString(),
    text: "",
    note: "",
    ...extras,
  });
}
async function store(capture, replacement = null) {
  await savePending(
    {
      capture,
      target: replacement?.target || null,
      targetLabel: replacement?.targetLabel || "",
      projectLabel: replacement?.projectLabel || "",
      stage: "review",
      updatedAt: Date.now(),
    },
    replacement?.capture.id,
    replacement,
  );
  await chrome.storage.session.set({
    activeCaptureId: capture.id,
    captureError: null,
    lastReceipt: null,
  });
  await chrome.action.setBadgeText({ text: "" });
  await popup();
  return capture.id;
}
async function blobDataUrl(blob) {
  if (blob.size > LIMITS.imageBytes)
    throw new Error("This image is over 4 MB. Capture a smaller region instead.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
async function activeMatches(tab) {
  const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (active[0]?.id !== tab.id || active[0]?.url !== tab.url)
    throw new Error("The source tab changed. Capture the content again.");
}
async function croppedVisible(tab, rect, viewport) {
  await activeMatches(tab);
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  await activeMatches(tab);
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    const crop = cropPixels(rect, viewport, bitmap);
    const canvas = new OffscreenCanvas(crop.width, crop.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Chrome could not prepare this capture.");
    ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return await blobDataUrl(await canvas.convertToBlob({ type: "image/png" }));
  } finally {
    bitmap.close();
  }
}
async function captureImage(info, tab) {
  if (info.frameId && info.frameId !== 0)
    throw new Error("For an image inside an embedded frame, use Capture region instead.");
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: (url) => {
      const images = [...document.images].filter(
        (item) => item.currentSrc === url || item.src === url,
      );
      if (images.length > 1)
        throw new Error(
          "This image appears more than once. Use Capture region to choose the exact image.",
        );
      const image = images[0];
      if (!image) throw new Error("Image is no longer on this page.");
      const r = image.getBoundingClientRect();
      let imageDataUrl;
      if (image.complete && image.naturalWidth * image.naturalHeight <= 32000000) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d").drawImage(image, 0, 0);
          imageDataUrl = canvas.toDataURL("image/png");
        } catch {}
      }
      return {
        imageDataUrl,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        viewport: { width: innerWidth, height: innerHeight },
      };
    },
    args: [info.srcUrl],
  });
  if (!result) throw new Error("The image could not be read. Use Capture region instead.");
  if (result.imageDataUrl) {
    let capture;
    try {
      capture = createCapture(tab, "image", { imageDataUrl: result.imageDataUrl });
    } catch {
      /* A large original can still have a supported visible-page crop. */
    }
    if (capture) return store(capture);
  }
  const { rect, viewport } = result;
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > viewport.width ||
    rect.y + rect.height > viewport.height
  )
    throw new Error(
      "This image is partly outside the screen. Use Capture region to choose the visible part.",
    );
  const imageDataUrl = await croppedVisible(tab, rect, viewport);
  return store(createCapture(tab, "image", { imageDataUrl, imageFallback: true }));
}
async function startRegion(tab, replaceId) {
  source(tab);
  const replacement = replaceId ? await readPending(replaceId) : null;
  if (replaceId && (!replacement || replacement.stage !== "review"))
    throw new Error("This capture cannot be retaken while delivery is pending.");
  const nonce = crypto.randomUUID();
  await chrome.storage.session.set({
    regionIntent: {
      nonce,
      tabId: tab.id,
      windowId: tab.windowId,
      ...source(tab),
      replaceId: replaceId || null,
      createdAt: Date.now(),
    },
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: beginRegionSelection,
    args: [nonce],
  });
}
async function regionResult(message, sender) {
  const { regionIntent: intent } = await chrome.storage.session.get("regionIntent");
  if (
    !intent ||
    intent.nonce !== message.nonce ||
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id !== intent.tabId ||
    Date.now() - intent.createdAt > 300000
  )
    throw new Error("That region selection expired. Capture a region again.");
  await chrome.storage.session.remove("regionIntent");
  if (message.type === "region-cancel") return;
  const tab = await chrome.tabs.get(intent.tabId);
  if (cleanSourceUrl(tab.url) !== intent.pageUrl)
    throw new Error("The source page changed. Select a region again.");
  const check = async () => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: (nonce) => globalThis.__starkCaptureRegionNonce === nonce,
      args: [intent.nonce],
    });
    if (!result) throw new Error("The page reloaded. Select a region again.");
  };
  await check();
  const imageDataUrl = await croppedVisible(tab, message.rect, message.viewport);
  await check();
  const replacement = intent.replaceId ? await readPending(intent.replaceId) : null;
  if (intent.replaceId && (!replacement || replacement.stage !== "review"))
    throw new Error("The earlier capture changed. Nothing was replaced.");
  return store(
    createCapture(tab, "region", {
      pageUrl: intent.pageUrl,
      pageTitle: intent.pageTitle,
      imageDataUrl,
      note: replacement?.capture.note || "",
    }),
    replacement,
  );
}
async function deliver(id) {
  const record = await readPending(id);
  if (!record || !record.target) throw new Error("Choose a chat before adding this capture.");
  const pinned = { ...record, stage: "pending", updatedAt: Date.now() };
  await savePending(pinned);
  const receipt = await native({
    method: "deliver",
    delivery: { capture: pinned.capture, target: pinned.target },
  });
  return receiptFor(record, receipt);
}
async function receiptFor(record, receipt) {
  if (receipt.state === "saved") {
    const lastReceipt = {
      ...receipt,
      label: record.targetLabel || "Selected chat",
      projectLabel: record.projectLabel || "",
    };
    await chrome.storage.session.set({ lastReceipt });
    await deletePending(record.capture.id);
    return lastReceipt;
  }
  if (receipt.state === "error") return receipt;
  return {
    id: record.capture.id,
    state: "pending",
    message: receipt.message || "Waiting for the selected chat draft.",
  };
}
async function ui(message) {
  switch (message.type) {
    case "state": {
      const records = await listPending();
      const session = await chrome.storage.session.get([
        "activeCaptureId",
        "captureError",
        "lastReceipt",
      ]);
      const record =
        records.find((item) => item.capture.id === session.activeCaptureId) || records[0] || null;
      await chrome.action.setBadgeText({ text: "" });
      return {
        record,
        records: records.map((item) => ({
          id: item.capture.id,
          kind: item.capture.kind,
          pageTitle: item.capture.pageTitle,
          stage: item.stage,
        })),
        ...session,
        extensionId: chrome.runtime.id,
      };
    }
    case "catalog":
      return native({ method: "catalog" });
    case "select-capture":
      await chrome.storage.session.set({ activeCaptureId: message.id, lastReceipt: null });
      return;
    case "capture-region": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("Open the page you want to capture.");
      await startRegion(tab, message.replaceId);
      return;
    }
    case "save": {
      const record = await readPending(message.id);
      if (!record || record.stage !== "review")
        throw new Error(
          "This capture is already assigned. Retry it or cancel its delivery before changing it.",
        );
      record.capture.note = message.note;
      record.target = message.target;
      record.targetLabel = message.targetLabel;
      record.projectLabel = message.projectLabel;
      record.updatedAt = Date.now();
      await savePending(record);
      return;
    }
    case "deliver":
      return deliver(message.id);
    case "receipt": {
      const record = await readPending(message.id);
      if (!record) return (await chrome.storage.session.get("lastReceipt")).lastReceipt;
      return receiptFor(record, await native({ method: "receipt", id: message.id }));
    }
    case "cancel-delivery": {
      const record = await readPending(message.id);
      if (!record) return;
      if (record.stage === "pending") {
        const result = await native({ method: "discard", id: message.id });
        if (result.state === "saved") return receiptFor(record, result);
        if (result.state !== "discarded")
          throw new Error(
            result.message ||
              "Stark is saving this capture. Wait for its receipt before changing it.",
          );
      }
      const capture = { ...record.capture, id: crypto.randomUUID() };
      await savePending(
        { ...record, capture, target: null, stage: "review", updatedAt: Date.now() },
        record.capture.id,
        record,
      );
      await chrome.storage.session.set({ activeCaptureId: capture.id });
      return;
    }
    case "delete": {
      const record = await readPending(message.id);
      if (record?.stage === "pending") {
        const result = await native({ method: "discard", id: message.id });
        if (result.state === "saved") return receiptFor(record, result);
        if (result.state !== "discarded")
          throw new Error(
            result.message ||
              "Wait for Stark to finish saving before deleting this pending capture.",
          );
      }
      await deletePending(message.id);
      await chrome.storage.session.remove("lastReceipt");
      return;
    }
    case "open":
      await chrome.runtime.sendNativeMessage(HOST, { method: "open" });
      return;
    case "clear-error":
      await chrome.storage.session.remove("captureError");
      return;
    default:
      throw new Error("Unknown extension action.");
  }
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TEXT,
      title: "Send selection to Stark Code",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_IMAGE,
      title: "Send image to Stark Code",
      contexts: ["image"],
    });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    if (!tab?.id) throw new Error("Open a web page first.");
    if (info.menuItemId === MENU_TEXT)
      return store(createCapture(tab, "text", { text: info.selectionText || "" }));
    if (info.menuItemId === MENU_IMAGE) return captureImage(info, tab);
  })().catch(failure);
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-region")
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => startRegion(tab))
      .catch(failure);
});
let mutation = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  let operation;
  if (["region-result", "region-cancel"].includes(message?.type)) {
    operation = mutation.catch(() => {}).then(() => regionResult(message, sender));
    mutation = operation.catch(() => {});
  } else if (ownPage(sender)) {
    if (["save", "deliver", "receipt", "cancel-delivery", "delete"].includes(message.type)) {
      operation = mutation.catch(() => {}).then(() => ui(message));
      mutation = operation.catch(() => {});
    } else operation = ui(message);
  } else return false;
  void operation.then(
    (result) => respond({ ok: true, result }),
    async (error) => {
      if (sender.tab && message?.type !== "region-cancel") await failure(error);
      respond({ ok: false, error: error instanceof Error ? error.message : "Capture failed." });
    },
  );
  return true;
});
