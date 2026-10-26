import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ChangesetCheckInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
export type ChangesetCheckInput = typeof ChangesetCheckInput.Type;
export const ChangesetCheckResult = Schema.Struct({
  checkedAt: Schema.String,
  base: Schema.String,
  packages: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      directory: Schema.String,
      changesets: Schema.Array(Schema.String),
      staged: Schema.Boolean,
      stagedCovered: Schema.Boolean,
    }),
  ),
  warnings: Schema.Array(Schema.String),
});
export type ChangesetCheckResult = typeof ChangesetCheckResult.Type;
export class ChangesetCheckError extends Schema.TaggedError<ChangesetCheckError>()(
  "ChangesetCheckError",
  { reason: Schema.Literals(["git", "files", "limit"]), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return {
      git: "Cannot check this folder or comparison ref. Choose a Git repository and an existing local ref.",
      files: "Some package or changeset files could not be read safely. The check is incomplete.",
      limit: "This change is too large for the bounded changeset check. Narrow its scope.",
    }[this.reason];
  }
}
