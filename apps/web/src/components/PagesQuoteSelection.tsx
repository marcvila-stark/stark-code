import { QuoteIcon } from "lucide-react";
import { MAX_PAGE_QUOTE_LENGTH } from "../starkPageQuote";
import { Button } from "./ui/button";

/** Selecting text only reveals this action; the click is what stages a chat quote. */
export function PagesQuoteSelection({
  text,
  tooLong = false,
  onQuote,
}: {
  text: string;
  tooLong?: boolean;
  onQuote(): void;
}) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-3 border-b border-border px-3 py-2">
      <p
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        role={tooLong ? "status" : undefined}
      >
        {tooLong
          ? `Shorten selection to ${MAX_PAGE_QUOTE_LENGTH.toLocaleString()} characters or fewer.`
          : text}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={tooLong}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onQuote}
      >
        <QuoteIcon aria-hidden />
        Quote in chat
      </Button>
    </div>
  );
}
