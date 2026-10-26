import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

export interface AccountUsageItem {
  readonly id: string;
  readonly label: string;
  readonly percent: number | null;
  readonly detail?: string;
}

/** Common provider window names remain compact without renaming model-specific limits. */
export function accountUsageLabel(label: string): string {
  if (/^(5 hours?|5h|session)( · all models)?$/i.test(label)) return "Session";
  if (/^(7 days?|7d|weekly)( · all models)?$/i.test(label)) return "Weekly";
  return label;
}

export function AccountUsageSummary({ items }: { readonly items: readonly AccountUsageItem[] }) {
  const normalized = items.map((item) => ({ ...item, label: accountUsageLabel(item.label) }));
  const primary = normalized.filter((item) => ["Session", "Weekly"].includes(item.label));
  const extra = normalized.filter((item) => !primary.includes(item));
  const line = (windows: readonly AccountUsageItem[]) => (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {windows.map((item, index) => (
        <span key={item.id} className="inline-flex items-baseline gap-1">
          {index > 0 ? (
            <span aria-hidden className="mr-1 opacity-50">
              ·
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <span>{item.label}</span>{" "}
              <span
                className={cn(
                  "tabular-nums",
                  item.percent === null ? "text-(--sr-muted)" : "text-(--sr-text)",
                  item.percent !== null && item.percent >= 80 && "text-(--sr-gold)",
                )}
              >
                {item.percent === null ? "Not reported" : `${Math.round(item.percent)}% used`}
              </span>
            </TooltipTrigger>
            <TooltipPopup>
              {item.detail ??
                `${item.label}: ${item.percent === null ? "not reported" : `${Math.round(item.percent)}% used`}`}
            </TooltipPopup>
          </Tooltip>
        </span>
      ))}
    </span>
  );
  return (
    <span className="stark-account-usage-summary">
      {primary.length > 0 ? line(primary) : null}
      {extra.length > 0 ? line(extra) : null}
    </span>
  );
}
