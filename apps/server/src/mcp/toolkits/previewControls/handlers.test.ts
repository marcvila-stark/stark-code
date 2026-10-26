import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AGENT_BROWSER_PROFILE_ID,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@starkfuture/contracts";
import { resolveProjectSettings } from "@starkfuture/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as Preview from "../../../preview/Manager.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewControlsHandlers from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

it.effect.each([
  { name: "project opt-in", globalAccess: false, projectAccess: true },
  { name: "project opt-out", globalAccess: true, projectAccess: false },
])("list and close respect the credential for a $name", ({ globalAccess, projectAccess }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectId = ProjectId.make("preview-controls-project");
      const threadId = ThreadId.make("preview-controls-thread");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentBrowserAccess: globalAccess,
        projectSettingsOverrides: {
          [projectId]: { enableAgentBrowserAccess: projectAccess },
        },
      };
      const effective = resolveProjectSettings(settings, projectId).settings;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("preview-controls-environment"),
        requestNamespace: "preview-controls-provider-session",
        thread: {
          threadId,
          providerSessionId: "preview-controls-provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(effective.enableAgentBrowserAccess ? ["preview"] : []),
        issuedAt: 0,
      };
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "stark-preview-controls-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const personal = yield* manager.open({
        threadId,
        url: "https://private.example.test",
        profileId: "personal-imported",
      });
      const tab = yield* manager.open({
        threadId,
        url: "http://localhost:3000",
        profileId: AGENT_BROWSER_PROFILE_ID,
      });
      const layerDependencies = Layer.mergeAll(
        PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
      const listed = yield* toolkit
        .handle("stark_preview_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      const closed = yield* toolkit
        .handle("stark_preview_close", { tabId: tab.tabId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      if (projectAccess) {
        expect(listed.at(-1)?.result).toMatchObject({
          sessions: [{ tabId: tab.tabId, navStatus: { _tag: "Idle" } }],
          nextCursor: null,
        });
        expect(JSON.stringify(listed.at(-1)?.result)).not.toContain("localhost:3000");
        expect(JSON.stringify(listed.at(-1)?.result)).not.toContain("private.example.test");
        expect(closed.at(-1)?.result).toEqual({});
        const refused = yield* toolkit
          .handle("stark_preview_close", { tabId: personal.tabId })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
        expect(refused.at(-1)?.result).toMatchObject({ _tag: "OrchestratorMcpFailure" });
        expect((yield* manager.list({ threadId })).sessions).toEqual([personal]);
      } else {
        for (const result of [listed, closed]) {
          expect(result.at(-1)?.result).toMatchObject({
            _tag: "PreviewAutomationUnavailableError",
            capability: "preview",
            threadId,
          });
        }
        expect((yield* manager.list({ threadId })).sessions).toEqual([personal, tab]);
      }
    }),
  ),
);
