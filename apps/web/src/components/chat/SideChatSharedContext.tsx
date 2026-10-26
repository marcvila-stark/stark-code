import { useCallback, useState } from "react";
import { useFindRevealRef } from "./markdownFindContext";

/** Keep the original agent prompt inspectable without making it the human question. */
export function SideChatSharedContext({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const reveal = useCallback(() => setExpanded(true), []);
  const findRevealRef = useFindRevealRef(reveal);
  return (
    <details
      className="mt-3 text-xs text-muted-foreground"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      ref={findRevealRef}
      data-thread-find-fold={expanded ? undefined : ""}
    >
      <summary className="cursor-pointer">Shared context</summary>
      <p
        className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words"
        data-thread-find-text
      >
        {text}
      </p>
    </details>
  );
}
