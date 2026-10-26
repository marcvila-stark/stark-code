import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const RESPONSE_VISUALS_MODEL = "claude-sonnet-5-5";
export const RESPONSE_VISUALS_VERSION = "3";
export const ResponseVisualsInput = Schema.Struct({
  threadId: ThreadId,
  answer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24_000)),
  language: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
  visualRequest: Schema.optionalKey(Schema.Literals(["auto", "table", "flowchart", "summary"])),
});
export type ResponseVisualsInput = typeof ResponseVisualsInput.Type;

export const ResponseVisualsTable = Schema.Struct({
  columns: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(5),
  ),
  rows: Schema.Array(
    Schema.Array(Schema.String.check(Schema.isMaxLength(240))).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(5),
    ),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
const TokenCount = Schema.NullOr(
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
export const ResponseVisualsUsage = Schema.Struct({
  freshInputTokens: TokenCount,
  cacheReadInputTokens: TokenCount,
  cacheWriteInputTokens: TokenCount,
  outputTokens: TokenCount,
  costUsd: Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
});
export const ResponseVisualsResult = Schema.Struct({
  summary: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(280))),
  /** Present only for an explicit Summarize request; the original answer is never replaced. */
  summaryBullets: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(5),
    ),
  ),
  table: Schema.NullOr(ResponseVisualsTable),
  mermaid: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000))),
  reason: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
  model: Schema.Literal(RESPONSE_VISUALS_MODEL),
  formatterVersion: Schema.Literal(RESPONSE_VISUALS_VERSION),
  cacheHit: Schema.Boolean,
  /** The original generation's CLI-reported usage. A cache hit makes no new model request. */
  generationUsage: Schema.NullOr(ResponseVisualsUsage),
});
export type ResponseVisualsResult = typeof ResponseVisualsResult.Type;

export class ResponseVisualsError extends Schema.TaggedError<ResponseVisualsError>()(
  "ResponseVisualsError",
  {
    reason: Schema.Literals([
      "invalid",
      "busy",
      "disabled",
      "unavailable",
      "timeout",
      "output",
      "storage",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return {
      invalid: "Choose a nonempty answer of at most 24,000 characters and 48 KiB.",
      busy: "A summary or visual is already being prepared. Try again when it finishes.",
      disabled: "Enable a Claude connection for this project to summarize or make a visual.",
      unavailable:
        "Sonnet formatting is unavailable. Check the enabled Claude connection and try again.",
      timeout: "Formatting took too long. Your original answer is unchanged.",
      output: "The formatter did not return a usable result. Your original answer is unchanged.",
      storage: "The formatter could not create its isolated working directory.",
    }[this.reason];
  }
}
