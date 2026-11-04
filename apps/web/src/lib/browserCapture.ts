import {
  browserCaptureComment,
  COMPOSER_CONTEXT_MAX_RECORDS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type BrowserCapture,
  type BrowserCaptureDelivery,
  type BrowserCaptureTarget,
  type DesktopBridge,
  type PreviewAnnotationPayload,
} from "@starkfuture/contracts";
import { scopeProjectRef, scopeThreadRef } from "@starkfuture/client-runtime/environment";
import {
  resolveNewThreadEnvMode,
  resolveProjectSettings,
} from "@starkfuture/shared/projectSettings";
import {
  DraftId,
  useComposerDraftStore,
  verifyBrowserCaptureDraftPersisted,
  setBrowserCaptureReceipt,
  readPersistedBrowserCaptureReceipt,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { readProject, readThreadShell, readThreadShells } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { readStarkProjectFile } from "./starkProjectFileDefaults";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { compressImageToByteLimit, dataUrlToFile } from "./imageCompression";
import { readFileAsDataUrl } from "../components/ChatView.logic";
import { browserCaptureFingerprint } from "./browserCaptureReceipt";
import { browserCaptureAnnotationId } from "./browserCaptureIdentity";

export { browserCaptureAnnotationId } from "./browserCaptureIdentity";

export const BROWSER_CAPTURE_CONNECTION_EVENT = "starkcode:browser-capture-connection";
export function getDesktopBrowserCaptureBridge() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  return typeof bridge?.browserCapture === "function"
    ? (bridge as DesktopBridge & Required<Pick<DesktopBridge, "browserCapture">>)
    : undefined;
}

function projectRef(target: BrowserCaptureTarget) {
  return scopeProjectRef(
    EnvironmentId.make(target.environmentId),
    ProjectId.make(target.projectId),
  );
}

function requireDestinationProject(target: BrowserCaptureTarget) {
  const ref = projectRef(target);
  const project = readProject(ref);
  if (!project || !readEnvironmentScope(ref.environmentId, "orchestration:operate")) {
    throw new Error("The selected project is no longer available. Choose a destination again.");
  }
  return project;
}

/** A capture-specific mapping cannot evict another draft in the same project. */
async function createBrowserCaptureDraft(
  delivery: BrowserCaptureDelivery,
): Promise<ComposerThreadTarget> {
  const { target, capture } = delivery;
  if (target.kind !== "new") throw new Error("A new-chat destination is required.");
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make(`browser-capture-${capture.id}`);
  const logicalProjectKey = `browser-capture:${capture.id}`;
  const existing = store.getDraftSession(draftId);
  if (existing) {
    if (
      existing.logicalProjectKey !== logicalProjectKey ||
      existing.environmentId !== target.environmentId ||
      existing.projectId !== target.projectId
    )
      throw new Error("This capture has a conflicting draft destination.");
    if (existing.promotedTo) return existing.promotedTo;
    return draftId;
  }
  const project = requireDestinationProject(target);
  const ref = projectRef(target);
  const server = appAtomRegistry.get(environmentServerConfigsAtom).get(ref.environmentId);
  const settings = server?.settings ?? DEFAULT_SERVER_SETTINGS;
  const initialSettings = resolveProjectSettings(settings, project.id, project);
  const projectFile =
    initialSettings.settings.defaultThreadEnvMode === null
      ? await readStarkProjectFile(ref.environmentId, project.workspaceRoot)
      : null;
  requireDestinationProject(target);
  // Another drain can complete while project settings load. Reuse its reserved identity.
  if (useComposerDraftStore.getState().getDraftSession(draftId))
    return createBrowserCaptureDraft(delivery);
  const resolved = resolveProjectSettings(settings, project.id, project, projectFile);
  const envMode = resolveNewThreadEnvMode({
    projectSettings: resolved,
    workspaceRoot: project.workspaceRoot,
    newProjectsRoot: server?.newProjectsRoot,
    projectHasThreads: readThreadShells().some(
      (thread) => thread.environmentId === ref.environmentId && thread.projectId === ref.projectId,
    ),
  });
  const threadId = ThreadId.make(capture.id);
  if (readThreadShell(scopeThreadRef(ref.environmentId, threadId)))
    throw new Error("This capture conflicts with an existing chat. Capture again.");
  store.setLogicalProjectDraftThreadId(logicalProjectKey, ref, draftId, {
    threadId,
    title: target.title.trim(),
    createdAt: capture.capturedAt,
    envMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode,
      newWorktreesStartFromOrigin: resolved.settings.newWorktreesStartFromOrigin,
    }),
    runtimeMode: resolved.settings.defaultRuntimeMode,
  });
  if (resolved.settings.defaultModelSelection) {
    store.setModelSelection(draftId, resolved.settings.defaultModelSelection, {
      replaceOptions: true,
    });
  }
  return draftId;
}

/** Resolve only the immutable chosen destination, never the current route. */
async function resolveBrowserCaptureTarget(
  delivery: BrowserCaptureDelivery,
): Promise<ComposerThreadTarget> {
  const { target } = delivery;
  requireDestinationProject(target);
  if (target.kind === "new") return createBrowserCaptureDraft(delivery);
  if (target.kind === "draft") {
    const draftId = DraftId.make(target.draftId);
    const session = useComposerDraftStore.getState().getDraftSession(draftId);
    if (
      !session ||
      session.environmentId !== target.environmentId ||
      session.projectId !== target.projectId
    )
      throw new Error("The selected draft is no longer available.");
    if (session.promotedTo) {
      const thread = readThreadShell(session.promotedTo);
      if (!thread || thread.projectId !== target.projectId)
        throw new Error("The selected chat is not ready. Retry shortly.");
      return session.promotedTo;
    }
    return draftId;
  }
  const ref = scopeThreadRef(
    EnvironmentId.make(target.environmentId),
    ThreadId.make(target.threadId),
  );
  const thread = readThreadShell(ref);
  if (!thread || thread.projectId !== target.projectId || thread.archivedAt !== null)
    throw new Error("The selected chat is no longer available.");
  return ref;
}

export function browserCaptureAnnotation(
  capture: BrowserCapture,
  imageSize?: { width: number; height: number },
): PreviewAnnotationPayload {
  return {
    id: browserCaptureAnnotationId(capture.id),
    pageUrl: capture.pageUrl,
    pageTitle: capture.pageTitle || null,
    comment: browserCaptureComment(capture),
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: imageSize
      ? { dataUrl: "", ...imageSize, cropRect: { x: 0, y: 0, ...imageSize } }
      : null,
    createdAt: capture.capturedAt,
  };
}

export class BrowserCaptureDeliveryError extends Error {
  constructor(
    message: string,
    readonly receiptState: "pending" | "error",
  ) {
    super(message);
  }
}

/** Add external context without modifying the prompt, navigating, or dispatching a turn. */
export async function deliverBrowserCapture(delivery: BrowserCaptureDelivery): Promise<void> {
  const fingerprint = await browserCaptureFingerprint(delivery);
  const { capture } = delivery;
  let uncertain = true;
  try {
    const savedReceipt = readPersistedBrowserCaptureReceipt(capture.id);
    uncertain = false;
    if (savedReceipt !== null) {
      if (savedReceipt !== fingerprint)
        throw new Error("This capture id was already used for a different destination or payload.");
      return;
    }
    let target = await resolveBrowserCaptureTarget(delivery);
    const id = browserCaptureAnnotationId(capture.id);
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(target);
    const existing = draft?.previewAnnotations.find((item) => item.id === id);
    if (existing) {
      uncertain = true;
      if (
        existing.pageUrl !== capture.pageUrl ||
        existing.comment !== browserCaptureComment(capture)
      )
        throw new Error("The saved capture does not match this delivery.");
      setBrowserCaptureReceipt(capture.id, fingerprint);
      if (
        verifyBrowserCaptureDraftPersisted(
          target,
          existing,
          capture.imageDataUrl ? id : undefined,
          { id: capture.id, fingerprint },
        )
      )
        return;
    }
    const recordCount = draft
      ? draft.terminalContexts.length +
        draft.reviewComments.length +
        draft.threadContexts.length +
        draft.previewAnnotations.length +
        draft.images.length +
        draft.files.length
      : 0;
    if (!existing && recordCount + (capture.imageDataUrl ? 2 : 1) > COMPOSER_CONTEXT_MAX_RECORDS)
      throw new Error("Remove some context from this draft, then retry the capture.");
    let imageSize: { width: number; height: number } | undefined;
    if (capture.imageDataUrl) {
      const mimeType = /^data:([^;]+);/.exec(capture.imageDataUrl)?.[1] ?? "image/png";
      const name = `${(capture.pageTitle || "Browser capture").slice(0, 80).replace(/[\\/:\0]/g, "-")}.${mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png"}`;
      const original = dataUrlToFile(capture.imageDataUrl, name, mimeType);
      const compressed = await compressImageToByteLimit(
        original,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      );
      if (!compressed.ok) throw new Error("This capture is too large to attach.");
      // The destination can be deleted or revoked while the image is decoded.
      target = await resolveBrowserCaptureTarget(delivery);
      const dataUrl = compressed.recompressed
        ? await readFileAsDataUrl(compressed.file)
        : capture.imageDataUrl;
      if (compressed.imageSize) {
        imageSize = compressed.imageSize;
      } else {
        const bitmap = await createImageBitmap(compressed.file);
        try {
          if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width > 48_000_000 / bitmap.height)
            throw new Error("This image is too large to decode safely. Capture a smaller region.");
          imageSize = { width: bitmap.width, height: bitmap.height };
        } finally {
          bitmap.close();
        }
      }
      target = await resolveBrowserCaptureTarget(delivery);
      if (!store.getComposerDraft(target)?.images.some((item) => item.id === id)) {
        const previouslyUncertain = uncertain;
        uncertain = true;
        const added = store.addImage(target, {
          type: "image",
          id,
          name,
          mimeType: compressed.file.type,
          sizeBytes: compressed.file.size,
          previewUrl: dataUrl,
          file: compressed.file,
        });
        if (!added) {
          uncertain = previouslyUncertain;
          throw new Error("Remove an attachment, then retry this capture.");
        }
      }
      uncertain = true;
      const attachments =
        store.getComposerDraft(target)?.persistedAttachments.filter((item) => item.id !== id) ?? [];
      await store.syncPersistedAttachments(target, [
        ...attachments,
        { id, name, mimeType: compressed.file.type, sizeBytes: compressed.file.size, dataUrl },
      ]);
    }
    const annotation = browserCaptureAnnotation(capture, imageSize);
    uncertain = true;
    store.addPreviewAnnotation(target, annotation, { appendReference: false });
    setBrowserCaptureReceipt(capture.id, fingerprint);
    if (
      !verifyBrowserCaptureDraftPersisted(target, annotation, imageSize ? id : undefined, {
        id: capture.id,
        fingerprint,
      })
    )
      throw new Error("The capture could not be saved. It is still pending in Chrome.");
  } catch (error) {
    throw new BrowserCaptureDeliveryError(
      error instanceof Error ? error.message : "The capture could not be saved.",
      uncertain ? "pending" : "error",
    );
  }
}
