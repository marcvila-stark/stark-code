import type { PreviewAnnotationPayload } from "@starkfuture/contracts";

export const browserCaptureAnnotationId = (captureId: string) => `browser-capture-${captureId}`;

/** Browser captures use source cards and need no synthesized inline prompt reference. */
export const isBrowserCaptureAnnotation = (annotation: Pick<PreviewAnnotationPayload, "id">) =>
  annotation.id.startsWith("browser-capture-");
