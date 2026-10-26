import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  PreviewListResult,
  PreviewTabId,
} from "@starkfuture/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, PreviewAutomationUnavailableError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PreviewManager.PreviewManager,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
};
const PreviewListTool = Tool.make("stark_preview_list", {
  ...shared,
  description:
    "List this thread's agent-browser tab identifiers, without page content. Call preview_status with a tabId to obtain its URL and title after site approval. Idle navStatus here is a redacted placeholder, not the tab's actual navigation state.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    ...PreviewListResult.fields,
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PreviewCloseTool = Tool.make("stark_preview_close", {
  ...shared,
  description:
    "Close one preview tab owned by this thread through the normal server/host tab lifecycle. This does not wait for renderer cleanup.",
  parameters: Schema.Struct({ tabId: PreviewTabId }),
  success: Schema.Struct({}),
}).annotate(Tool.Destructive, true);
export const PreviewControlsToolkit = Toolkit.make(PreviewListTool, PreviewCloseTool);
