import { canCreateProjectInEnvironment } from "@starkfuture/client-runtime/operations/projects";
import { useState } from "react";

import { useOpenFolder } from "../../hooks/useOpenFolder";
import { useEnvironments } from "../../state/environments";
import { FolderStep } from "../onboarding/FolderStep";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** The same single-folder opener as setup, available after onboarding. */
export function OpenFolderDialog({ onClose }: { readonly onClose: () => void }) {
  const { environments } = useEnvironments();
  const openFolder = useOpenFolder();
  const [isOpening, setIsOpening] = useState(false);
  const environmentIds = environments
    .filter((environment) => canCreateProjectInEnvironment(environment.connection.phase))
    .map((environment) => environment.environmentId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isOpening) onClose();
      }}
    >
      <DialogPopup variant="brand" className="w-full sm:w-[30rem]">
        <DialogHeader>
          <DialogTitle>Open folder</DialogTitle>
          <DialogDescription>
            Choose the folder you work from. It opens as one workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {environmentIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect a computer in Settings to open a folder.
            </p>
          ) : null}
          <FolderStep
            environmentIds={environmentIds}
            isOpening={isOpening}
            setIsOpening={setIsOpening}
            showIntroduction={false}
            onCancel={onClose}
            onDone={async (projectRef, isCurrent) => {
              if (
                !projectRef ||
                !(await openFolder(projectRef, isCurrent ? { isCurrent } : undefined))
              )
                return false;
              onClose();
              return true;
            }}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
