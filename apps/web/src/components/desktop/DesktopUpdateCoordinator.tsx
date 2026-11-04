import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { prepareWindowForDesktopRestart } from "../../desktopRestartBarrier";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { getDesktopUpdateReadyPromptVersion } from "../desktopUpdate.logic";
import { showDesktopUpdateReadyToast } from "../desktopUpdate.toast";

function setAppInert(inert: boolean): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.toggleAttribute("inert", inert);
  if (inert && document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * Desktop update duties every app window shares: prompt once per ready
 * version, and when Stark Code is about to restart to update, stop editing
 * and sending, save drafts and the prompt stash, and confirm to desktop main.
 * If the restart does not happen, the barrier lifts again.
 */
export function DesktopUpdateCoordinator() {
  const state = useDesktopUpdateState();
  const promptedVersions = useRef(new Set<string>());
  const [barrierRequestId, setBarrierRequestId] = useState<string | null>(null);
  const barrierRef = useRef<string | null>(null);

  useEffect(() => {
    const version = getDesktopUpdateReadyPromptVersion(state, Date.now());
    if (!state || version === null || promptedVersions.current.has(version)) return;
    promptedVersions.current.add(version);
    showDesktopUpdateReadyToast(state);
  }, [state]);

  useEffect(() => {
    const restart = window.desktopBridge?.updateRestart;
    if (!restart) return;
    const stopPrepare = restart.onPrepare((request) => {
      barrierRef.current = request.requestId;
      setBarrierRequestId(request.requestId);
      setAppInert(true);
      void prepareWindowForDesktopRestart(request).then((ack) => restart.acknowledge(ack));
    });
    const stopRelease = restart.onRelease((requestId) => {
      if (barrierRef.current !== requestId) return;
      barrierRef.current = null;
      setBarrierRequestId(null);
      setAppInert(false);
    });
    return () => {
      stopPrepare();
      stopRelease();
      setAppInert(false);
    };
  }, []);

  if (barrierRequestId === null) return null;
  return createPortal(
    <div
      aria-live="polite"
      className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-background/80 backdrop-blur-sm"
      role="status"
    >
      <div className="max-w-sm px-6 text-center">
        <p className="text-sm font-medium text-foreground">Saving your work before restarting…</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Stark Code restarts to update once every window has saved its drafts.
        </p>
      </div>
    </div>,
    document.body,
  );
}
