import { useEffect, useState } from "react";
import type { BrowserCaptureDesktopResult } from "@starkfuture/contracts";
import {
  BROWSER_CAPTURE_CONNECTION_EVENT,
  getDesktopBrowserCaptureBridge,
} from "../../lib/browserCapture";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function BrowserCaptureSettings() {
  const bridge = getDesktopBrowserCaptureBridge();
  const [status, setStatus] = useState<BrowserCaptureDesktopResult | null>(null);
  const [extensionId, setExtensionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const refresh = () => {
      void bridge
        .browserCapture({ action: "status" })
        .then((value) => {
          if (cancelled) return;
          setStatus(value);
          if (value.extensionId) setExtensionId(value.extensionId);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = bridge.onBrowserCapturePending?.(refresh);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bridge]);
  const update = async () => {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.browserCapture(
        status?.connected
          ? { action: "disconnect" }
          : { action: "connect", extensionId: extensionId.trim() },
      );
      setStatus(next);
      window.dispatchEvent(new Event(BROWSER_CAPTURE_CONNECTION_EVENT));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Chrome could not be connected.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="browser-capture" title="Chrome capture">
      <SettingsRow
        title="Add browser captures to chat drafts"
        description="Send selected text, images and screenshot regions with their source URL to a chat you choose. You review and send from Stark."
        status={
          !bridge
            ? "Available in the macOS desktop app with the Chrome extension."
            : status?.connected
              ? "Chrome is connected to this desktop profile."
              : "Install the unpacked Stark capture extension in Chrome, then enter its extension ID below."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={
              !bridge || busy || (!status?.connected && !/^[a-p]{32}$/.test(extensionId.trim()))
            }
            onClick={() => void update()}
          >
            {busy ? "Updating…" : status?.connected ? "Disconnect Chrome" : "Connect Chrome"}
          </Button>
        }
      >
        {bridge ? (
          <div className="mt-3 max-w-sm">
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <span>Chrome extension ID</span>
              <Input
                size="sm"
                font="mono"
                value={extensionId}
                disabled={busy || status?.connected}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setExtensionId(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
