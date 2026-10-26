import { AGENT_BROWSER_PROFILE_ID, OrchestratorMcpFailure } from "@starkfuture/contracts";
import * as Effect from "effect/Effect";
import * as Preview from "../../../preview/Manager.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const access = Effect.gen(function* () {
  // The preview capability already reflects the calling project's access setting.
  const scope = yield* requireThreadMcpCapability("preview");
  return { scope, manager: yield* Preview.PreviewManager };
});
export const layer = McpToolAccess.toLayer(PreviewControlsToolkit, {
  stark_preview_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const result = yield* manager.list({ threadId: scope.thread.threadId });
      // The manager snapshot has not passed the per-site gate. Expose only
      // identities here; preview_status authorizes the actual page before
      // returning its URL, title, dialogs or downloads.
      const sessions = result.sessions
        .filter((session) => session.profileId === AGENT_BROWSER_PROFILE_ID)
        .map((session) => ({
          threadId: session.threadId,
          tabId: session.tabId,
          profileId: session.profileId,
          ...(session.runtime === undefined ? {} : { runtime: session.runtime }),
          navStatus: { _tag: "Idle" as const },
          canGoBack: false,
          canGoForward: false,
          updatedAt: session.updatedAt,
        }));
      const start = input.cursor ?? 0;
      const end = start + (input.limit ?? 20);
      return {
        ...result,
        sessions: sessions.slice(start, end),
        nextCursor: end < sessions.length ? end : null,
      };
    }),
  ),
  stark_preview_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      if (
        !sessions.some(
          (session) =>
            session.tabId === input.tabId && session.profileId === AGENT_BROWSER_PROFILE_ID,
        )
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Personal browser tabs are unavailable to agents.",
        });
      if (
        sessions.some((session) => session.tabId === input.tabId && session.runtime === "server")
      ) {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        yield* broker
          .invoke({ scope, operation: "close", input: {}, tabId: input.tabId })
          .pipe(Effect.mapError(unavailable));
        return {};
      }
      yield* manager
        .close({ threadId: scope.thread.threadId, tabId: input.tabId })
        .pipe(Effect.mapError(unavailable));
      return {};
    }),
  ),
});
