import type { EnvironmentId, ProjectEntryKind } from "@starkfuture/contracts";
import { FileIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { useProjectPathSearch } from "~/state/queries";
import { composerFloatingLayerProps } from "./composerEventScope";
import { CommandPaletteContent } from "../CommandPaletteContent";
import {
  CommandDialog,
  CommandDialogPopup,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
} from "../ui/command";

interface ComposerContextPickerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly kind: ProjectEntryKind;
  /** Adds a reference to the draft. A busy composer may reject the insertion. */
  readonly onSelect: (path: string) => boolean | void;
}

function ContextPickerContent(props: ComposerContextPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const result = useProjectPathSearch(
    { environmentId: props.environmentId, cwd: props.cwd, kind: props.kind, query },
    100,
    { allowEmptyQuery: true },
  );
  const pending = result.isPending || result.searchedQuery !== query.trim();
  // A debounced search may retain the previous result. Never offer that result for a new query,
  // or expose cached paths after a connection loses filesystem access.
  const entries =
    pending || result.error ? [] : result.entries.filter((entry) => entry.kind === props.kind);
  const canChooseRoot = props.kind === "directory" && !query.trim() && !pending && !result.error;
  const noun = props.kind === "directory" ? "folders" : "files";
  const title = props.kind === "directory" ? "Add a folder reference" : "Add a file reference";
  const choose = (path: string) => {
    if (props.onSelect(path) === false) {
      setSelectionError("The composer is busy. Try again when it is ready.");
      return;
    }
    props.onOpenChange(false);
  };

  return (
    <CommandDialogPopup
      {...composerFloatingLayerProps}
      aria-label={title}
      className="overflow-hidden"
      onBackdropPointerDown={() => props.onOpenChange(false)}
      onKeyDown={(event) => {
        // Let the command list select first, then stop the portal event reaching the composer.
        if (event.key === "Enter") event.stopPropagation();
      }}
    >
      <CommandPaletteContent
        aria-label={title}
        escapeLabel="Close"
        footerActionLabel="Add to draft"
        inputProps={{ placeholder: `Search workspace ${noun}…`, maxLength: 256 }}
        mode="none"
        onValueChange={(value) => {
          setSelectionError(null);
          setQuery(value);
        }}
        panelSize="tall-list"
        testId="composer-context-picker"
        value={query}
      >
        <div className="px-4 pb-2 text-xs text-muted-foreground">
          {props.kind === "directory"
            ? "Adds a folder reference. Its contents are not uploaded."
            : "Adds a reference to a file in this workspace."}
        </div>
        {selectionError ? (
          <p role="alert" className="px-4 pb-2 text-sm text-destructive">
            {selectionError}
          </p>
        ) : null}
        {canChooseRoot || entries.length > 0 ? (
          <CommandList>
            <CommandGroup>
              <CommandGroupLabel>{props.cwd}</CommandGroupLabel>
              {canChooseRoot ? (
                <CommandItem value="workspace-root" onClick={() => choose(props.cwd)}>
                  <FolderIcon />
                  <span>Current workspace folder</span>
                </CommandItem>
              ) : null}
              {entries.map((entry) => (
                <CommandItem key={entry.path} value={entry.path} onClick={() => choose(entry.path)}>
                  {entry.kind === "directory" ? <FolderIcon /> : <FileIcon />}
                  <span className="min-w-0 truncate">{entry.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground" role="status">
            {result.error ??
              (pending
                ? `Searching workspace ${noun}…`
                : query.trim()
                  ? `No matching ${noun}.`
                  : `No ${noun} found.`)}
          </div>
        )}
        {!pending && !result.error && result.truncated ? (
          <p className="px-4 pb-2 text-xs text-muted-foreground">
            Showing the first 100 matches. Search to narrow the results.
          </p>
        ) : null}
      </CommandPaletteContent>
    </CommandDialogPopup>
  );
}

/** Uses the selected environment's filesystem, including remote workspaces. */
export function ComposerContextPickerDialog(props: ComposerContextPickerDialogProps) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <ContextPickerContent
          key={`${props.environmentId}:${props.cwd}:${props.kind}`}
          {...props}
        />
      ) : null}
    </CommandDialog>
  );
}
