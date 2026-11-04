import * as Schema from "effect/Schema";

import * as Generated from "./_generated/schema.gen.ts";

export * from "./_generated/schema.gen.ts";
export * from "./_generated/meta.gen.ts";
export * from "./_generated/namespaces.gen.ts";

/*
 * Hand-decoded fields from the Codex 0.163.0 app-server protocol that the
 * checked-in schema (pinned to an older upstream ref) drops on decode. Only
 * the permission and approval fields Stark acts on are added; the rest of the
 * generated schema stays as generated.
 */

/** The profile Codex reports as producing a thread's active permissions, when it knows one. */
const ActivePermissionProfile = Schema.Struct({
  id: Schema.String,
  extends: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * `item/commandExecution/requestApproval` params with the 0.163.0 fields
 * `availableDecisions` (the ordered decisions this prompt offers) and
 * `additionalPermissions` (the extra sandbox access the command asks for).
 */
export const CommandExecutionRequestApprovalParamsV0163 =
  Generated.CommandExecutionRequestApprovalParams.pipe(
    Schema.fieldsAssign({
      availableDecisions: Schema.optionalKey(
        Schema.NullOr(
          Schema.Array(
            Generated.CommandExecutionRequestApprovalParams__CommandExecutionApprovalDecision,
          ),
        ),
      ),
      additionalPermissions: Schema.optionalKey(
        Schema.NullOr(Generated.CommandExecutionRequestApprovalParams__AdditionalPermissionProfile),
      ),
    }),
  );
export type CommandExecutionRequestApprovalParamsV0163 =
  typeof CommandExecutionRequestApprovalParamsV0163.Type;

/** `thread/start` response with the 0.163.0 `activePermissionProfile`. */
export const ThreadStartResponseV0163 = Generated.V2ThreadStartResponse.pipe(
  Schema.fieldsAssign({
    activePermissionProfile: Schema.optionalKey(Schema.NullOr(ActivePermissionProfile)),
  }),
);
export type ThreadStartResponseV0163 = typeof ThreadStartResponseV0163.Type;

/** `thread/fork` response with the 0.163.0 `activePermissionProfile`. */
export const ThreadForkResponseV0163 = Generated.V2ThreadForkResponse.pipe(
  Schema.fieldsAssign({
    activePermissionProfile: Schema.optionalKey(Schema.NullOr(ActivePermissionProfile)),
  }),
);
export type ThreadForkResponseV0163 = typeof ThreadForkResponseV0163.Type;

/**
 * The permission settings Codex reports for a loaded thread, read leniently
 * from a `thread/start`, `thread/resume` or `thread/fork` response. Values stay
 * as Codex sent them; Stark compares them, it never re-derives them.
 */
export const ReportedPermissionSettings = Schema.Struct({
  approvalPolicy: Schema.optionalKey(Schema.Unknown),
  approvalsReviewer: Schema.optionalKey(Schema.Unknown),
  sandbox: Schema.optionalKey(Schema.Unknown),
  activePermissionProfile: Schema.optionalKey(Schema.NullOr(ActivePermissionProfile)),
});
export type ReportedPermissionSettings = typeof ReportedPermissionSettings.Type;

/**
 * The permission keys of a `config/read` response's effective config. Read
 * leniently: a config shape the checked-in schema does not know must not hide
 * the fields Stark compares.
 */
export const ConfiguredPermissionSettings = Schema.Struct({
  config: Schema.Struct({
    approval_policy: Schema.optionalKey(Schema.Unknown),
    approvals_reviewer: Schema.optionalKey(Schema.Unknown),
    sandbox_mode: Schema.optionalKey(Schema.Unknown),
    default_permissions: Schema.optionalKey(Schema.Unknown),
  }),
});

/**
 * The permission keys of a `configRequirements/read` response, read leniently
 * like `ConfiguredPermissionSettings`: managed requirements Stark shows but
 * never re-derives.
 */
export const ConfiguredPermissionRequirements = Schema.Struct({
  requirements: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        allowedApprovalPolicies: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
        allowedSandboxModes: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
        defaultPermissions: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type ConfiguredPermissionRequirements = typeof ConfiguredPermissionRequirements.Type;
