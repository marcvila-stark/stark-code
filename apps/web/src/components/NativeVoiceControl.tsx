import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@starkfuture/contracts";
import { MicIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAtomCommand } from "../state/use-atom-command";
import { terminalEnvironment } from "../state/terminal";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

function nativeVoiceCommand(driver: string): string | null {
  return driver === "claudeAgent" ? "/voice hold" : driver === "codex" ? "/voice" : null;
}

export function NativeVoiceControl({
  driver,
  apiBackend,
  threadRef,
  terminalId,
  requestId = 0,
  onRequestConsumed,
  ended,
  onShowTerminal,
}: {
  driver: string;
  apiBackend?: "openrouter" | undefined;
  threadRef: ScopedThreadRef;
  terminalId: string;
  requestId?: number | undefined;
  onRequestConsumed?: ((requestId: number) => void) | undefined;
  ended: boolean;
  onShowTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const canWrite = useAtomValue(terminalEnvironment.write.permissionAtom(threadRef.environmentId));
  useEffect(() => {
    if (requestId <= 0) return;
    setOpen(true);
    onRequestConsumed?.(requestId);
  }, [requestId, onRequestConsumed]);
  const command = nativeVoiceCommand(driver);
  if (!command || apiBackend === "openrouter") return null;
  const claude = driver === "claudeAgent";
  const label = claude ? "Claude" : "Codex";
  const prepare = async () => {
    if (!canWrite || busy || ended) return;
    setBusy(true);
    setError(null);
    try {
      // A PTY has no authoritative "empty prompt" API. Stage one fixed slash
      // command as a paste; only the person at the terminal can submit it.
      const result = await write({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId, data: `\x1b[200~${command}\x1b[201~` },
      });
      if (result._tag !== "Success") {
        setError("Could not prepare voice. You can type the command in the terminal.");
        return;
      }
      setOpen(false);
      onShowTerminal();
    } catch {
      setError("Could not prepare voice. You can type the command in the terminal.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={`${label} voice`} />}>
        <MicIcon aria-hidden />
        Voice
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        width="lg"
        aria-label={`${label} voice controls`}
        finalFocus={false}
      >
        <div className="space-y-3 text-sm">
          <h3 className="font-medium">Voice with {label}</h3>
          <p className="text-xs text-muted-foreground">
            {claude
              ? "Claude transcribes through your Claude account. Enable voice, then hold Space in the terminal to speak. Release to review your words before pressing Enter."
              : "Codex starts its own voice conversation through your ChatGPT account. This can send spoken instructions to the agent; it is different from dictating a draft."}
          </p>
          <p className="text-xs text-muted-foreground">
            At an empty, idle terminal prompt, prepare <code>{command}</code>, then press Enter
            there. Your chat draft stays saved. Voice uses the microphone on the computer running
            the CLI.
          </p>
          <p className="text-xs text-muted-foreground">
            {claude
              ? "Claude shows microphone activity and transcription in the terminal. Esc cancels dictation; /voice off disables it."
              : "Use /voice settings for devices and /voice again to stop. If unavailable, update Codex and check its /experimental settings."}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite || busy || ended}
            onClick={() => void prepare()}
          >
            {busy ? "Preparing…" : `Prepare ${command}`}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
