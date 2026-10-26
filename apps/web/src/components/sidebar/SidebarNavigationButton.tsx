import type { ComponentProps } from "react";
import { cn } from "~/lib/utils";

/** Feature-owned navigation row; also accepts trigger props from the folder picker. */
export function SidebarNavigationButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button type="button" className={cn("stark-sidebar-navigation-button", className)} {...props} />
  );
}
