import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderApprovalOption } from "./providerPolicy.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
it("round-trips exact saved-rule previews", () => {
  const option = {
    decision: "acceptAlways",
    label: "Always allow in this project",
    rulePreview: ["Bash(npm test)"],
  };
  expect(Schema.decodeUnknownSync(ProviderApprovalOption)(option)).toEqual(option);
});
it("requires settings permission only for a persistent approval decision", () => {
  expect(
    clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
      type: "runtime-request.respond",
      decision: "acceptAlways",
    }),
  ).toEqual(["orchestration:operate", "settings:write"]);
  expect(
    clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
      type: "runtime-request.respond",
      decision: "acceptForSession",
    }),
  ).toEqual(["orchestration:operate"]);
});
