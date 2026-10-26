import {
  selectedTextQuoteLabel,
  serializeSelectedTextQuote,
  type SelectedTextQuote,
} from "@starkfuture/shared/selectedTextQuotes";
import { QuoteIcon } from "lucide-react";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";

export function SelectedTextQuoteChip({
  quote,
  onRemove,
}: {
  quote: SelectedTextQuote;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <ContextChipPopover
      kind="citation"
      icon={<QuoteIcon />}
      label={selectedTextQuoteLabel(quote)}
      accessibleLabel={`Quote from ${quote.source}`}
      copyMarkdown={serializeSelectedTextQuote(quote)}
    >
      <div className="flex max-h-[min(28rem,var(--available-height))] flex-col gap-3 p-1 text-sm">
        <p className="shrink-0 break-words font-medium">Quoted from {quote.source}</p>
        <div className="min-h-0 overflow-auto whitespace-pre-wrap break-words">{quote.text}</div>
        {onRemove ? (
          <div className="shrink-0">
            <Button variant="outline" size="sm" onClick={onRemove}>
              Remove quote
            </Button>
          </div>
        ) : null}
      </div>
    </ContextChipPopover>
  );
}
