import * as Schema from "effect/Schema";

const AccountNumber = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Threshold = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(50),
  Schema.isLessThanOrEqualTo(99),
);

/** Only display metadata crosses the wire; cswap retains all credentials. */
export const ClaudeAccount = Schema.Struct({
  number: AccountNumber,
  email: Schema.String,
  organizationName: Schema.NullOr(Schema.String),
  organizationUuid: Schema.NullOr(Schema.String),
  alias: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
  disabled: Schema.Boolean,
  usageStatus: Schema.String,
  usageAgeSeconds: Schema.NullOr(Schema.Number),
  windows: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      percent: Schema.Number,
      resetsAt: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ClaudeAccount = typeof ClaudeAccount.Type;

export const ClaudeAccountsSnapshot = Schema.Struct({
  available: Schema.Boolean,
  accounts: Schema.Array(ClaudeAccount),
  activeAccountNumber: Schema.NullOr(AccountNumber),
  automatic: Schema.Struct({
    enabled: Schema.Boolean,
    threshold: Threshold,
    lastOutcome: Schema.NullOr(Schema.String),
  }),
  notice: Schema.NullOr(Schema.String),
});
export type ClaudeAccountsSnapshot = typeof ClaudeAccountsSnapshot.Type;

export const ClaudeAccountsCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("switch"),
    accountNumber: AccountNumber,
    expectedEmail: Schema.String,
    expectedOrganizationUuid: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("capture") }),
  Schema.Struct({
    action: Schema.Literal("setEligible"),
    accountNumber: AccountNumber,
    eligible: Schema.Boolean,
    expectedEmail: Schema.String,
    expectedOrganizationUuid: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("automatic"),
    enabled: Schema.Boolean,
    threshold: Threshold,
  }),
]);
export type ClaudeAccountsCommand = typeof ClaudeAccountsCommand.Type;

export class ClaudeAccountsError extends Schema.TaggedError<ClaudeAccountsError>()(
  "ClaudeAccountsError",
  {
    reason: Schema.Literals(["unavailable", "failed", "invalid", "storage", "busy"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return {
      unavailable:
        "Install claude-swap on this environment's machine to manage Claude organizations.",
      failed: "Claude organization management failed. Check cswap in Terminal and try again.",
      invalid: "Choose a saved organization and a switching threshold from 50 to 99 percent.",
      storage: "Could not save automatic switching preferences.",
      busy: "Another Claude organization action is in progress. Try again when it finishes.",
    }[this.reason];
  }
}
