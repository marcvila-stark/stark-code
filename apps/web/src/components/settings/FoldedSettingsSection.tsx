import { SettingsGroup } from "./SettingsGroup";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { useSettingsSearchTarget, useSettingsSearchTargetId } from "./settingsLayout";

/**
 * A grouped settings section that starts closed. The header carries the title,
 * a one line summary of what is set inside, and an optional control such as
 * the section's own switch. A settings search that targets the section opens it.
 */
export function FoldedSettingsSection({
  id,
  title,
  summary,
  control,
  headerPlacement = "inside",
  revealForTargets,
  openRequest = 0,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly control?: ReactNode;
  readonly headerPlacement?: "inside" | "outside" | "footer";
  /** Search aliases reveal the fold while the actual target owns scrolling. */
  readonly revealForTargets?: ReadonlyArray<string>;
  /** Incremented by an action elsewhere on this page to reveal the section. */
  readonly openRequest?: number;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  // A search jump lands inside the fold, so open it before the scroll runs.
  const [openedForTarget, setOpenedForTarget] = useState<string | null>(null);
  const [handledOpenRequest, setHandledOpenRequest] = useState(openRequest);
  if (openRequest !== handledOpenRequest) {
    setHandledOpenRequest(openRequest);
    if (!open) setOpen(true);
  }
  // Handling a target clears the URL hash. A later search for the same setting
  // is a new request, even if the user closed this fold in between.
  if (searchTargetId === null && openedForTarget !== null) {
    setOpenedForTarget(null);
  }
  if (
    searchTargetId !== null &&
    (searchTargetId === id || revealForTargets?.includes(searchTargetId)) &&
    openedForTarget !== searchTargetId
  ) {
    setOpenedForTarget(searchTargetId);
    if (!open) setOpen(true);
  }

  if (headerPlacement === "outside" || headerPlacement === "footer") {
    return (
      <section
        id={id}
        ref={targetRef}
        tabIndex={-1}
        className={cn("outline-none", headerPlacement === "footer" && "stark-runtime-fold")}
      >
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="space-y-2.5">
            <div
              data-settings-scroll-target
              className={
                headerPlacement === "footer"
                  ? "stark-runtime-fold-heading"
                  : "flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4"
              }
            >
              <h2>
                <CollapsibleTrigger className="flex min-h-7 items-center gap-2 rounded-md text-sm font-normal text-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                  {title}
                </CollapsibleTrigger>
              </h2>
              {summary ? <span className="stark-runtime-summary">{summary}</span> : null}
              {control}
            </div>
            <CollapsiblePanel>
              <SettingsGroup>{children}</SettingsGroup>
            </CollapsiblePanel>
          </div>
        </Collapsible>
      </section>
    );
  }

  return (
    <section id={id} ref={targetRef} tabIndex={-1} className="outline-none">
      <Collapsible open={open} onOpenChange={setOpen} render={<SettingsGroup divided={false} />}>
        <div className="flex items-center gap-4 px-3 sm:px-4">
          <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-md">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium">{title}</span>
            {summary ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
            ) : null}
          </CollapsibleTrigger>
          {control ? <div className="flex shrink-0 items-center">{control}</div> : null}
        </div>
        <CollapsiblePanel>
          <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
            {children}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
