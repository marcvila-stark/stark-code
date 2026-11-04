import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { isBrowserCaptureAnnotation } from "../../lib/browserCaptureIdentity";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export function BrowserCaptureCards({ target }: { target: ComposerThreadTarget }) {
  const annotations = useComposerDraftStore(
    (store) => store.getComposerDraft(target)?.previewAnnotations,
  );
  const images = useComposerDraftStore((store) => store.getComposerDraft(target)?.images);
  const captures = annotations?.filter(isBrowserCaptureAnnotation) ?? [];
  if (captures.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 p-3 pb-0" aria-label="Browser captures in this draft">
      {captures.map((capture) => {
        const image = images?.find((image) => image.id === capture.id);
        // Persisted attachments hydrate to data URLs; newly added images may use object URLs.
        const previewUrl =
          image?.previewUrl &&
          /^(?:blob:|data:image\/(?:png|jpeg|webp|gif|avif);base64,)/i.test(image.previewUrl)
            ? image.previewUrl
            : null;
        return (
          <article key={capture.id} className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium">
                {capture.pageTitle || "Browser capture"}
              </span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Remove browser capture"
                onClick={() => {
                  const store = useComposerDraftStore.getState();
                  store.removePreviewAnnotation(target, capture.id);
                  store.removeImage(target, capture.id);
                }}
              >
                <XIcon />
              </Button>
            </div>
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {capture.screenshot
                  ? "View captured image and note"
                  : "View captured content and note"}
              </summary>
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={`Captured image from ${capture.pageTitle || capture.pageUrl}`}
                  className="mt-2 max-h-64 max-w-full rounded-md object-contain"
                  loading="lazy"
                />
              ) : capture.screenshot ? (
                <p className="mt-2 text-muted-foreground">Image preview is unavailable.</p>
              ) : null}
              <p className="mt-2 whitespace-pre-wrap break-words text-foreground">
                {capture.comment}
              </p>
            </details>
            <a
              href={capture.pageUrl}
              className="mt-2 flex items-start gap-1 text-xs break-all text-primary underline-offset-4 hover:underline"
              onClick={(event) => {
                event.preventDefault();
                void ensureLocalApi().shell.openExternal(capture.pageUrl);
              }}
            >
              <ExternalLinkIcon className="mt-0.5 size-3 shrink-0" />
              {capture.pageUrl}
            </a>
          </article>
        );
      })}
    </div>
  );
}
