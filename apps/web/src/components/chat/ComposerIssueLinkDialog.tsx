import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { composerFloatingLayerProps } from "./composerEventScope";
import { parseComposerIssueLink, type ComposerIssueLink } from "./composerIssueLink";

export type { ComposerIssueLink } from "./composerIssueLink";

interface ComposerIssueLinkDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (link: ComposerIssueLink) => boolean | void;
  /** Known GitHub Enterprise hosts may be supplied by the workspace configuration. */
  readonly allowedHosts?: readonly string[];
}

function IssueLinkContent(props: ComposerIssueLinkDialogProps) {
  const [input, setInput] = useState("");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const inputId = useId();
  const helpId = useId();
  const link = parseComposerIssueLink(input, props.allowedHosts);
  const invalid = input.trim().length > 0 && link === null;
  const addLink = () => {
    if (!link) return;
    if (props.onSelect(link) === false) {
      setSelectionError("The composer is busy. Try again when it is ready.");
      return;
    }
    props.onOpenChange(false);
  };

  return (
    <DialogPopup {...composerFloatingLayerProps}>
      <DialogHeader>
        <DialogTitle>Add GitHub issue link</DialogTitle>
        <DialogDescription>Adds a link to your draft without sending it.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-2">
          <label htmlFor={inputId} className="text-sm font-medium">
            Issue URL
          </label>
          <Input
            id={inputId}
            autoFocus
            type="url"
            placeholder="https://github.com/owner/repo/issues/123"
            value={input}
            aria-invalid={invalid || undefined}
            aria-describedby={helpId}
            onValueChange={(value) => {
              setSelectionError(null);
              setInput(value);
            }}
            onKeyDown={(event) => {
              // The dialog is a portal from the composer: Enter must never bubble into Send.
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              addLink();
            }}
          />
          <p id={helpId} className="text-xs text-muted-foreground">
            {invalid
              ? "Use an HTTPS GitHub issue URL, such as github.com/owner/repo/issues/123."
              : "The issue contents are not fetched or attached."}
          </p>
        </div>
        {link ? (
          <div className="space-y-1 rounded-lg border p-3" aria-label="Issue link preview">
            <p className="text-sm font-medium">{link.label}</p>
            <p className="break-all text-xs text-muted-foreground">{link.url}</p>
          </div>
        ) : null}
        {selectionError ? (
          <p role="alert" className="text-sm text-destructive">
            {selectionError}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" disabled={!link} onClick={addLink}>
          Add to draft
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

export function ComposerIssueLinkDialog(props: ComposerIssueLinkDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <IssueLinkContent {...props} /> : null}
    </Dialog>
  );
}
