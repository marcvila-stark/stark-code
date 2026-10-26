import { useRef, useState } from "react";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

/** A native terminal has no control RPC. Never inject Enter into an unknown CLI prompt. */
export function NativeMcpReloadControl({
  driver,
  onShowTerminal,
}: {
  readonly driver: string;
  readonly onShowTerminal: () => void;
}) {
  const codex = driver === "codex";
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const copying = useRef(false);
  const copy = async (command: string) => {
    if (copying.current) return;
    copying.current = true;
    setError(false);
    setCopied(null);
    try {
      await writeTextToClipboard(command, "native MCP command");
      setCopied(command);
    } catch {
      setError(true);
    } finally {
      copying.current = false;
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
        {codex ? "Connections" : "Reload plugins"}
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg" aria-label="Native MCP controls" finalFocus={false}>
        <div className="space-y-4 text-sm">
          <h3 className="font-medium">{codex ? "Codex connections" : "Reload Claude plugins"}</h3>
          {!codex ? (
            <>
              <p className="text-xs text-muted-foreground">
                Apply installed plugin changes, including skills, commands, hooks, and plugin
                MCPs, in this terminal session. This does not download plugin updates.
              </p>
              <Button size="sm" variant="secondary" onClick={() => void copy("/reload-plugins")}>
                Copy /reload-plugins
              </Button>
              <p className="text-xs text-muted-foreground">
                Claude will warn if applying the changes would increase token usage on the next
                message. Review that warning before choosing to force a reload.
              </p>
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            The terminal manages its own connections. Open /mcp there to inspect the affected server
            and its sign-in or recovery options. Healthy connections do not need reloading.
          </p>
          {codex ? (
            <p className="text-xs text-muted-foreground">
              Codex has no live MCP reload command in this terminal. Inspect connections with
              /mcp; restart and resume the CLI session when a configuration change needs it.
            </p>
          ) : null}
          <Button size="xs" variant="outline" onClick={() => void copy("/mcp")}>
            Copy /mcp
          </Button>
          <p className="text-xs text-muted-foreground">
            When the agent is idle, paste at an empty CLI prompt and press Enter. Stark Code does
            not type commands or restart the session for you.
          </p>
          {copied ? (
            <p role="status" className="text-xs">
              Copied {copied}. It has not been run.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              Could not copy the command. Select and copy it manually.
            </p>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOpen(false);
              onShowTerminal();
            }}
          >
            Show terminal
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
