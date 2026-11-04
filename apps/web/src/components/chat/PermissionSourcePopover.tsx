import type { EffectivePermissions, PermissionSource } from "@starkfuture/contracts";
import { ShieldCheckIcon, ShieldUserIcon } from "lucide-react";
import { memo } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import {
  permissionApplyNotice,
  permissionPopoverRows,
  permissionSourceAction,
  permissionSourceChip,
  starkPermissionPolicies,
  type PermissionPopoverRow,
  type ThreadPermissionValues,
} from "./permissionsPresentation.logic";
import type { RuntimeModeDisplay } from "./runtimeModeConfig";
import { useComposerMenuState } from "./useComposerMenuState";

const ORIGIN_BADGE = {
  requested: "outline",
  active: "info",
  configured: "secondary",
  unknown: "warning",
} as const satisfies Record<PermissionPopoverRow["origin"], string>;

/**
 * The chip beside the mode control and its popover: whether this chat inherits the provider's
 * permission settings or overrides them, what the provider reported for the live session, the
 * boundaries Stark keeps, and the way between inherit and override.
 */
export const PermissionSourcePopover = memo(function PermissionSourcePopover(props: {
  permissions: EffectivePermissions;
  providerDisplayName?: string | undefined;
  /** A turn is running, so a narrowing change waits for it to stop. */
  runActive: boolean;
  /** The thread's `permissionChangePending`: a change chosen during the run waits for it. */
  changePending?: boolean | undefined;
  /** A change sent from here whose event hasn't reached the chat yet. */
  changeSaving?: boolean | undefined;
  /** `permissionChangePending.running`: what the session runs until the waiting change applies. */
  pendingRunning?: ThreadPermissionValues | undefined;
  /** The provider snapshot's `nativePermissionInherit`. */
  canInherit: boolean;
  canWriteSettings: boolean;
  /**
   * The saved mode the provider no longer offers, from `resolveRuntimeModeDisplay`. Only older
   * servers leave one; current ones narrow the chat to Manual themselves.
   */
  savedMode?: RuntimeModeDisplay["saved"] | undefined;
  runsAsLabel?: string | undefined;
  size?: "sm" | "xs";
  hidden?: boolean;
  /** Sends `thread.permission.set`, or sets a new chat's draft; absent when the host can't. */
  onChangeSource?: ((target: PermissionSource) => void) | undefined;
  /** Asks the server to stop the run and apply the change waiting on it now. */
  onStopAndApply?: (() => void) | undefined;
  /** Saves the mode the chat already runs as, replacing the unavailable saved one. */
  onKeepRunningMode?: (() => void) | undefined;
}) {
  const size = props.size ?? "sm";
  const floatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const { permissions } = props;
  const chip = permissionSourceChip({
    source: permissions.requested.permissionSource,
    driver: permissions.driver,
    preset: permissions.requested.preset,
    ...(props.providerDisplayName ? { providerDisplayName: props.providerDisplayName } : {}),
  });
  const rows = permissionPopoverRows(permissions, props.providerDisplayName);
  const notice = permissionApplyNotice({
    permissions,
    runActive: props.runActive,
    changePending: props.changePending === true,
    saving: props.changeSaving === true,
    running: props.pendingRunning,
    providerDisplayName: props.providerDisplayName,
  });
  const policies = starkPermissionPolicies(permissions.driver, permissions.rows);
  const action = permissionSourceAction({
    source: permissions.requested.permissionSource,
    driver: permissions.driver,
    canInherit: props.canInherit,
    canWriteSettings: props.canWriteSettings,
    canChangeSource: props.onChangeSource !== undefined,
    runActive: props.runActive,
    ...(props.providerDisplayName ? { providerDisplayName: props.providerDisplayName } : {}),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* At phone width the label is hidden: the icon tells the sources apart, the tooltip and
          the accessible name say which it is. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size={size}
                  className="shrink-0"
                  aria-label={`Permissions: ${chip.label}. ${chip.description}`}
                  data-permission-source={permissions.requested.permissionSource}
                />
              }
            />
          }
        >
          <ComposerControlIcon
            icon={
              permissions.requested.permissionSource === "inherit"
                ? ShieldCheckIcon
                : ShieldUserIcon
            }
            size={size}
          />
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            {chip.label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {chip.label}: {chip.description}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...floatingLayerProps}
        side="top"
        align="start"
        width="md"
        padding="compact"
        aria-label="Permissions for this chat"
      >
        <div className="flex min-w-0 flex-col gap-3 text-xs leading-relaxed">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-medium text-foreground text-sm">Permissions</span>
              <Badge variant="outline" size="sm">
                {chip.label}
              </Badge>
            </div>
            <p className="text-muted-foreground wrap-anywhere">{chip.description}</p>
          </div>

          {props.savedMode ? (
            <div role="note" className="flex min-w-0 flex-col items-start gap-1.5 text-warning">
              <p className="wrap-anywhere">{props.savedMode.note}</p>
              {props.onKeepRunningMode && props.runsAsLabel ? (
                <Button size="xs" variant="outline" onClick={props.onKeepRunningMode}>
                  Save as {props.runsAsLabel}
                </Button>
              ) : null}
            </div>
          ) : null}

          {notice ? (
            <div role="status" className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="flex min-w-0 flex-col">
                <span className="text-foreground wrap-anywhere">{notice.text}</span>
                {notice.detail ? (
                  <span className="text-muted-foreground wrap-anywhere">{notice.detail}</span>
                ) : null}
              </span>
              {notice.canStopAndApply && props.onStopAndApply ? (
                <Button size="xs" variant="outline" onClick={props.onStopAndApply}>
                  Stop and apply now
                </Button>
              ) : null}
            </div>
          ) : null}

          <dl aria-label="Permission settings" className="flex min-w-0 flex-col gap-2">
            {rows.map((row) => (
              <div key={row.key} className="flex min-w-0 flex-col gap-0.5">
                <dt className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                  <span className="min-w-0 wrap-anywhere">{row.label}</span>
                  <Badge variant={ORIGIN_BADGE[row.origin]} size="sm">
                    {row.originLabel}
                  </Badge>
                </dt>
                <dd className="flex min-w-0 flex-col">
                  <span className="text-foreground wrap-anywhere">
                    {row.valueHint ? (
                      // Codex's own word for the running policy stays; the tooltip says what
                      // it means, and keyboard users reach it by focus.
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              tabIndex={0}
                              aria-description={row.valueHint}
                              className="cursor-help rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            />
                          }
                        >
                          {row.value}
                        </TooltipTrigger>
                        <TooltipPopup side="top">{row.valueHint}</TooltipPopup>
                      </Tooltip>
                    ) : (
                      row.value
                    )}
                    {row.nativeValue ? (
                      <span className="ms-1.5 font-mono text-muted-foreground">
                        {row.nativeValue}
                      </span>
                    ) : null}
                  </span>
                  {row.detail ? (
                    <span className="text-muted-foreground wrap-anywhere">{row.detail}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>

          <section aria-label="Stark policies" className="flex min-w-0 flex-col gap-1.5">
            <ul className="flex min-w-0 flex-col gap-1.5">
              {policies.map((policy) => (
                <li
                  key={policy.id}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
                >
                  <span className="min-w-0 text-foreground wrap-anywhere">{policy.text}</span>
                  <Badge variant="secondary" size="sm">
                    Stark policy
                  </Badge>
                </li>
              ))}
            </ul>
          </section>

          <div className="flex min-w-0 flex-col items-start gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={action.disabledReason !== undefined}
              onClick={() => {
                if (action.disabledReason === undefined) props.onChangeSource?.(action.target);
              }}
            >
              {action.label}
            </Button>
            {action.disabledReason ? (
              <span className="text-muted-foreground wrap-anywhere">{action.disabledReason}</span>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
