import type {
  DesktopUpdateInstallBlocker,
  DesktopUpdateRestartAck,
  DesktopUpdateRestartPrepareRequest,
} from "@starkfuture/contracts";

import { prepareComposerDraftsForRestart } from "./composerDraftStore";
import { preparePromptStashForRestart } from "./promptStashStore";

interface RestartPreparationPart {
  readonly blockers: ReadonlyArray<DesktopUpdateInstallBlocker>;
  readonly referencedAttachmentIds: ReadonlyArray<string>;
  /** The part's store as written, which the update's backup keeps. */
  readonly storedJson?: string | null;
}

/** One window's answer: saved only when nothing could be lost. */
export function buildDesktopRestartAck(
  requestId: string,
  parts: ReadonlyArray<RestartPreparationPart>,
  stored: { readonly drafts?: string | null; readonly stash?: string | null } = {},
): DesktopUpdateRestartAck {
  const blockers = parts.flatMap((part) => part.blockers);
  return {
    requestId,
    outcome: blockers.length === 0 ? "saved" : "failed",
    blockers,
    referencedAttachmentIds: [...new Set(parts.flatMap((part) => part.referencedAttachmentIds))],
    ...(typeof stored.drafts === "string" ? { draftsJson: stored.drafts } : {}),
    ...(typeof stored.stash === "string" ? { stashJson: stored.stash } : {}),
  };
}

export interface DesktopRestartPreparers {
  readonly prepareDrafts: () => RestartPreparationPart;
  readonly prepareStash: () => RestartPreparationPart;
  /** Lets input events and React updates already queued land in the stores. */
  readonly settle: () => Promise<void>;
}

const defaultPreparers: DesktopRestartPreparers = {
  prepareDrafts: prepareComposerDraftsForRestart,
  prepareStash: preparePromptStashForRestart,
  settle: () =>
    new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    }),
};

/**
 * Saves this window's drafts and prompt stash for an update restart and
 * returns the answer for desktop main. Any failure, including an exception,
 * answers `failed`, which aborts the restart.
 */
export async function prepareWindowForDesktopRestart(
  request: DesktopUpdateRestartPrepareRequest,
  preparers: DesktopRestartPreparers = defaultPreparers,
): Promise<DesktopUpdateRestartAck> {
  try {
    await preparers.settle();
    const drafts = preparers.prepareDrafts();
    const stash = preparers.prepareStash();
    return buildDesktopRestartAck(request.requestId, [drafts, stash], {
      drafts: drafts.storedJson ?? null,
      stash: stash.storedJson ?? null,
    });
  } catch {
    return buildDesktopRestartAck(request.requestId, [
      {
        blockers: [{ kind: "storage-failed", message: "Drafts couldn't be saved." }],
        referencedAttachmentIds: [],
      },
    ]);
  }
}
