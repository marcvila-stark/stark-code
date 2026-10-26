import {
  CheckIcon,
  ChevronDownIcon,
  FileTextIcon,
  LayoutGridIcon,
  MessageCircleIcon,
  TerminalIcon,
} from "lucide-react";
import { Fragment } from "react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

export interface WorkspaceToolsMenuAction {
  id: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean;
  active?: boolean;
  onSelect: () => void;
}

export interface WorkspaceToolsMenuProps {
  actions: readonly WorkspaceToolsMenuAction[];
  moreGroups: readonly {
    label: string;
    actions: readonly WorkspaceToolsMenuAction[];
  }[];
}

function ToolItem({
  action,
  compact = false,
}: {
  action: WorkspaceToolsMenuAction;
  compact?: boolean;
}) {
  const Icon =
    action.id === "pages"
      ? FileTextIcon
      : action.id === "conversation"
        ? MessageCircleIcon
        : action.id === "terminal"
          ? TerminalIcon
          : null;
  return (
    <MenuItem
      aria-label={action.label}
      aria-current={action.active ? "true" : undefined}
      disabled={action.disabled}
      closeOnClick
      onClick={action.onSelect}
    >
      {Icon ? <Icon aria-hidden /> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <span>{action.label}</span>
        {action.description && (!compact || action.disabled) ? (
          <span className="text-xs leading-snug text-muted-foreground">{action.description}</span>
        ) : null}
      </span>
      {action.active ? <CheckIcon aria-hidden /> : null}
    </MenuItem>
  );
}

/** Everyday tools stay one click away; less common tools are revealed on request. */
export function WorkspaceToolsMenu({ actions, moreGroups }: WorkspaceToolsMenuProps) {
  const visibleGroups = moreGroups.filter((group) => group.actions.length > 0);

  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="sm" aria-label="Tools" />}>
        Tools
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" positionMethod="fixed">
        <div className="w-56 max-w-[calc(100vw-3rem)]">
          {actions.map((action) => (
            <ToolItem key={action.id} action={action} compact />
          ))}
          {visibleGroups.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger aria-label="More tools">
                  <LayoutGridIcon aria-hidden />
                  More tools
                </MenuSubTrigger>
                <MenuSubPopup>
                  <div className="w-64 max-w-[calc(100vw-3rem)]">
                    {visibleGroups.map((group, index) => (
                      <Fragment key={group.label}>
                        {index > 0 ? <MenuSeparator /> : null}
                        <MenuGroup>
                          <MenuGroupLabel>{group.label}</MenuGroupLabel>
                          {group.actions.map((action) => (
                            <ToolItem key={action.id} action={action} />
                          ))}
                        </MenuGroup>
                      </Fragment>
                    ))}
                  </div>
                </MenuSubPopup>
              </MenuSub>
            </>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
