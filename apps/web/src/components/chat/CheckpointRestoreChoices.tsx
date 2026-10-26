import type { CheckpointRestorePreview } from "@starkfuture/contracts";
import { AlertDialogClose, AlertDialogFooter } from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function CheckpointRestoreChoices(props: {
  readonly shared: boolean;
  readonly preview: CheckpointRestorePreview | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly onCodeAndChat: () => void;
  readonly onChatOnly: () => void;
  readonly onCodeOnly: () => void;
}) {
  const noFileRestore =
    props.busy || !props.canOperate || props.pending || !props.preview?.restorable.length;
  return (
    <>
      {props.shared ? (
        <div className="space-y-2 text-sm">
          {props.pending ? (
            <p>Checking files…</p>
          ) : props.error ? (
            <p role="alert">{props.error}</p>
          ) : props.preview ? (
            <>
              <p>
                {props.preview.restorable.length
                  ? `Restore ${props.preview.restorable.length} files the agent edited (+${props.preview.insertions} / -${props.preview.deletions}).`
                  : props.preview.reason}
              </p>
              {props.preview.conflicts.length || props.preview.untracked.length ? (
                <details>
                  <summary>Files that will be kept</summary>
                  <ul className="max-h-48 overflow-auto">
                    {props.preview.conflicts.map((file) => (
                      <li key={file.path}>
                        {file.path}: {file.reason}
                      </li>
                    ))}
                    {props.preview.untracked.map((file) => (
                      <li key={file}>{file}: not tracked by edit tools</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <p className="text-muted-foreground">
                Shell-command edits and background-agent edits are not tracked. Links and files
                changed since are kept.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button
          variant="destructive"
          disabled={props.shared ? Boolean(noFileRestore) : props.busy || !props.canOperate}
          onClick={props.onCodeAndChat}
        >
          Restore code and chat
        </Button>
        <Button disabled={props.busy || !props.canOperate} onClick={props.onChatOnly}>
          Restore chat only
        </Button>
        <Button variant="outline" disabled={Boolean(noFileRestore)} onClick={props.onCodeOnly}>
          Restore code only
        </Button>
      </AlertDialogFooter>
    </>
  );
}
