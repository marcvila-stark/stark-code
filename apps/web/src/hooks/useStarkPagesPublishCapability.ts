import { useEffect, useMemo, useState } from "react";

/** SDK chat stays disabled until its publishing guard has been verified live. */
export function useStarkPagesPublishCapability(input: {
  readonly localPagesAvailable: boolean;
  readonly pagesOpen: boolean;
  readonly nativeShellMode: boolean;
  readonly driver: string | undefined;
  readonly commandAvailable: boolean;
}) {
  const nativeClaude =
    input.localPagesAvailable && input.nativeShellMode && input.driver === "claudeAgent";
  const enabled = nativeClaude && input.pagesOpen;
  const check = window.desktopBridge?.getStarkWorkbenchAvailable;
  const request = useMemo(() => ({ check: enabled ? check : undefined }), [enabled, check]);
  const [result, setResult] = useState<{ request: typeof request; available: boolean } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    if (request.check) {
      void request
        .check()
        .then((available) => {
          if (!cancelled) setResult({ request, available: available === true });
        })
        .catch(() => {
          if (!cancelled) setResult({ request, available: false });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [request]);
  return (
    nativeClaude &&
    (input.commandAvailable || (enabled && result?.request === request && result.available))
  );
}
