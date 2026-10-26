import type { ServerProviderSlashCommand } from "@starkfuture/contracts";
import { useMemo, useState } from "react";
import { permissionWarningForCatalogEntry } from "../../composerPermissionWarnings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { plainCatalogText, resolveComposerSessionCatalog } from "./composerSessionCatalog";
import { composerFloatingLayerProps } from "./composerEventScope";

type ComposerSlashCommandsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerLabel: string;
  commands: ReadonlyArray<ServerProviderSlashCommand>;
  isPending: boolean;
  onSelect: (command: ServerProviderSlashCommand) => boolean | void;
};

const SOURCE_LABELS = {
  app: "Stark Code",
  builtin: "Built-in",
  personal: "Personal",
  project: "Project",
  plugin: "Plugin",
  mcp: "MCP",
};

const NATIVE_ONLY_COMMANDS = new Set([
  "plugin",
  "plugins",
  "apps",
  "mcp",
  "reload-plugins",
  "login",
  "logout",
  "exit",
  "quit",
  "resume",
  "clear",
  "rewind",
]);

/** These open native CLI interfaces and must never be sent as a chat prompt. */
export function isComposerChatCommand(command: Pick<ServerProviderSlashCommand, "name">): boolean {
  return !NATIVE_ONLY_COMMANDS.has(command.name.trim().replace(/^\/+/, "").toLowerCase());
}

export function ComposerSlashCommandsDialog(props: ComposerSlashCommandsDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        {...composerFloatingLayerProps}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Slash commands</DialogTitle>
          <DialogDescription>
            Change this chat's settings, or add a {props.providerLabel} command to your draft.
            Provider commands are sent only when you send the message.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <CommandsContent key={props.providerLabel} {...props} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function CommandsContent(props: ComposerSlashCommandsDialogProps) {
  const [query, setQuery] = useState("");
  const commands = useMemo(() => {
    const sanitized = resolveComposerSessionCatalog({
      catalog: null,
      probeCommands: props.commands,
      probeSkills: [],
    }).commands;
    const search = query.trim().replace(/^\/+/, "").toLowerCase();
    const seen = new Set<string>();
    return sanitized.filter((command) => {
      const name = command.name.toLowerCase();
      if (seen.has(name) || !isComposerChatCommand(command)) return false;
      seen.add(name);
      return [name, command.description, command.sourceName, ...(command.aliases ?? [])].some(
        (value) => value?.toLowerCase().includes(search),
      );
    });
  }, [props.commands, query]);
  return (
    <div className="space-y-4">
      <Input
        type="search"
        aria-label="Search slash commands"
        placeholder="Search commands"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      {props.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing {props.providerLabel} commands…
        </p>
      ) : null}
      {!props.isPending && commands.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {query.trim()
            ? "No matching commands. Try a different name."
            : `${props.providerLabel} has not reported any chat commands for this folder. More may appear after the session starts.`}
        </p>
      ) : null}
      <ul className="space-y-3" aria-label={`${props.providerLabel} commands`}>
        {commands.slice(0, 100).map((command) => {
          const appControl =
            command.source === "app" && ["model", "plan", "default"].includes(command.name);
          const warning = permissionWarningForCatalogEntry({
            type: "provider-slash-command",
            command,
          });
          return (
            <li key={command.name} className="rounded-xl border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-medium">/{command.name}</p>
                  <p className="break-words text-xs text-muted-foreground">
                    {command.source ? SOURCE_LABELS[command.source] : props.providerLabel}
                    {command.sourceName ? ` · ${command.sourceName}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label={appControl ? `Use /${command.name}` : `Add /${command.name} to draft`}
                  disabled={props.isPending}
                  onClick={() => {
                    if (props.isPending) return;
                    if (props.onSelect(command) !== false) props.onOpenChange(false);
                  }}
                >
                  {appControl ? "Use" : "Add to draft"}
                </Button>
              </div>
              {command.description ? (
                <p className="mt-2 break-words text-sm">{command.description}</p>
              ) : null}
              {command.input?.hint ? (
                <p className="mt-2 break-words text-xs text-muted-foreground">
                  Arguments: {command.input.hint}
                </p>
              ) : null}
              {warning ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {plainCatalogText(warning, 1000)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {commands.length > 100 ? (
        <p className="text-xs text-muted-foreground">
          Showing 100 commands. Search to narrow the list.
        </p>
      ) : null}
    </div>
  );
}
