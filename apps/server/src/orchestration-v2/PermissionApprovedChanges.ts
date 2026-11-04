/**
 * Every intended difference from the permission wire golden captured before
 * provider-native permissions (`PermissionWireGolden.test.ts`). The golden
 * table itself never changes; a package that changes what Stark sends, or the
 * stored mode a saved chat runs under, appends one row per changed field here
 * with the decision that approved it.
 *
 * Append only. Later packages (Claude, Codex, boundaries) add rows at the end.
 */

export type PermissionGoldenProvider =
  | "claude-bypass-on"
  | "claude-bypass-off"
  | "codex"
  | "opencode"
  | "grok";

export interface PermissionApprovedChange {
  /** `<provider>|<stored mode>|<interaction>` of the golden row, or `terminal|<case>`. */
  readonly row: string;
  /** Dot path of the changed field inside the row. */
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  /** The package that made the change. */
  readonly owner: "D0" | "D1" | "D2" | "D5";
  /** The plan decision that approved it. */
  readonly decision: string;
}

/** The claude.ai Pages connector's write tools Claude chats deny natively (D1). */
const D1_PAGES_CONNECTOR_DENY = [
  "mcp__claude_ai_Pages__pages_create_project",
  "mcp__claude_ai_Pages__pages_update_project",
  "mcp__claude_ai_Pages__pages_invite_member",
  "mcp__claude_ai_Pages__pages_upload_begin",
  "mcp__claude_ai_Pages__pages_upload_commit",
  "mcp__claude_ai_Pages__pages_upload_files",
  "mcp__claude_ai_Pages__pages_add_data_row",
  "mcp__claude_ai_Pages__pages_update_data_row",
  "mcp__claude_ai_Pages__pages_delete_data_row",
];

export const PERMISSION_APPROVED_CHANGES: ReadonlyArray<PermissionApprovedChange> = [
  // D0: the startup freeze narrows each stored mode to what the chat already
  // ran with. Only the stored mode changes; every wire field stays identical.
  {
    row: "claude-bypass-off|full-access|default",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Claude full access without Bypass already ran as Manual (C1, O3)",
  },
  {
    row: "claude-bypass-off|full-access|plan",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Claude full access without Bypass already ran as Manual (C1, O3)",
  },
  {
    row: "codex|auto-accept-edits|default",
    field: "storedRuntimeMode",
    before: "auto-accept-edits",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "codex|auto-accept-edits|plan",
    field: "storedRuntimeMode",
    before: "auto-accept-edits",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "codex|auto|default",
    field: "storedRuntimeMode",
    before: "auto",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "codex|auto|plan",
    field: "storedRuntimeMode",
    before: "auto",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "codex|full-access|default",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "codex|full-access|plan",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "opencode|auto-accept-edits|default",
    field: "storedRuntimeMode",
    before: "auto-accept-edits",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "opencode|auto-accept-edits|plan",
    field: "storedRuntimeMode",
    before: "auto-accept-edits",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "opencode|auto|default",
    field: "storedRuntimeMode",
    before: "auto",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "opencode|auto|plan",
    field: "storedRuntimeMode",
    before: "auto",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "opencode|full-access|default",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "opencode|full-access|plan",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "grok|auto-accept-edits|default",
    field: "storedRuntimeMode",
    before: "auto-accept-edits",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "grok|auto-accept-edits|plan",
    field: "storedRuntimeMode",
    before: "auto-accept-edits",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "grok|auto|default",
    field: "storedRuntimeMode",
    before: "auto",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "grok|auto|plan",
    field: "storedRuntimeMode",
    before: "auto",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "grok|full-access|default",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  {
    row: "grok|full-access|plan",
    field: "storedRuntimeMode",
    before: "full-access",
    after: "approval-required",
    owner: "D0",
    decision: "freeze: Stark already ran this provider Supervised (C1, O3)",
  },
  // D1: the Claude package. Pages connector writes are denied natively in every mode; Stark
  // no longer forces the user's hooks back on (its guard is an SDK callback hook, which runs
  // with settings hooks off); every Claude ask becomes a visible request, Bypass included.
  {
    row: "claude-bypass-on|approval-required|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|approval-required|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|auto-accept-edits|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|auto-accept-edits|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|auto|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|auto|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|full-access|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|full-access|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|approval-required|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|approval-required|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|auto-accept-edits|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|auto-accept-edits|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|auto|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|auto|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|full-access|default",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-off|full-access|plan",
    field: "wire.disallowedTools",
    before: null,
    after: D1_PAGES_CONNECTOR_DENY,
    owner: "D1",
    decision: "Pages guard -> native deny of the Pages connector's write tools (PLAN-002 D1 #2)",
  },
  {
    row: "claude-bypass-on|approval-required|default",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-on|approval-required|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-on|auto-accept-edits|default",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-on|auto-accept-edits|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-on|auto|default",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-on|auto|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-on|full-access|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|approval-required|default",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|approval-required|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|auto-accept-edits|default",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|auto-accept-edits|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|auto|default",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|auto|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|full-access|default",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-off|full-access|plan",
    field: "wire.disableAllHooks",
    before: false,
    after: null,
    owner: "D1",
    decision: "hooks: never force disableAllHooks; the user's setting stands (PLAN-002 D1 #7)",
  },
  {
    row: "claude-bypass-on|full-access|default",
    field: "wire.permissionCallback",
    before: false,
    after: true,
    owner: "D1",
    decision: "auto-allow removal: Bypass asks reach the user (PLAN-002 §4, D1 #3)",
  },

  // D2: a saved Codex chat may opt in to Codex's own settings (O2). Its
  // override wire is unchanged; once it inherits, Stark sends none of the
  // four permission keys, so Codex's config, profiles and rules apply. Plan
  // still sends its collaboration mode.
  {
    row: "codex|approval-required|default",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: null,
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
  {
    row: "codex|approval-required|plan",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: "plan",
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
  {
    row: "codex|auto-accept-edits|default",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: null,
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
  {
    row: "codex|auto-accept-edits|plan",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: "plan",
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
  {
    row: "codex|auto|default",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: null,
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
  {
    row: "codex|auto|plan",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: "plan",
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
  {
    row: "codex|full-access|default",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: null,
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
  {
    row: "codex|full-access|plan",
    field: "inheritWire",
    before: undefined,
    after: {
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      permissions: null,
      collaborationMode: "plan",
    },
    owner: "D2",
    decision:
      "Codex inherit is a per-chat opt-in that omits approvalPolicy, approvalsReviewer, sandboxPolicy and permissions (O2, PLAN-002 §1, D2 change 2)",
  },
];
