import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@starkfuture/client-runtime/connection";
import { EnvironmentId, type DesktopEnvironmentBootstrap } from "@starkfuture/contracts";
import { describe, expect, it } from "vite-plus/test";
import { isStarkPagesLocalConnectionTarget } from "./starkPagesConnection";

const identity = { environmentId: EnvironmentId.make("local-test"), label: "This Mac" };
const native: DesktopEnvironmentBootstrap = {
  id: "primary",
  label: "This Mac",
  runningDistro: null,
  httpBaseUrl: "http://127.0.0.1:3773/",
  wsBaseUrl: "ws://127.0.0.1:3773/",
};
const primary = (httpBaseUrl = "http://127.0.0.1:3773", wsBaseUrl = "ws://127.0.0.1:3773") =>
  new PrimaryConnectionTarget({ ...identity, httpBaseUrl, wsBaseUrl });

describe("Pages host filesystem eligibility", () => {
  it("recognizes the native primary desktop backend with normalized endpoints", () => {
    expect(isStarkPagesLocalConnectionTarget(primary(), [native])).toBe(true);
  });

  it.each([
    ["http://remote.example:3773", "ws://remote.example:3773"],
    ["http://127.0.0.1:4000", "ws://127.0.0.1:4000"],
    ["http://127.0.0.1:3773", "ws://127.0.0.1:4000"],
    ["http://127.0.0.1:3773@remote.example", "ws://127.0.0.1:3773"],
    ["not a URL", "ws://127.0.0.1:3773"],
  ])("refuses a primary that does not match this desktop: %s", (http, ws) => {
    expect(isStarkPagesLocalConnectionTarget(primary(http, ws), [native])).toBe(false);
  });

  it.each([
    { name: "absent", bootstraps: [] },
    { name: "WSL primary", bootstraps: [{ ...native, runningDistro: "Ubuntu" }] },
    {
      name: "unknown filesystem",
      bootstraps: [{ id: native.id, httpBaseUrl: native.httpBaseUrl, wsBaseUrl: native.wsBaseUrl }],
    },
    { name: "pending HTTP", bootstraps: [{ ...native, httpBaseUrl: null }] },
    { name: "pending WebSocket", bootstraps: [{ ...native, wsBaseUrl: null }] },
  ])("fails closed for $name bootstrap", ({ bootstraps }) => {
    expect(isStarkPagesLocalConnectionTarget(primary(), bootstraps)).toBe(false);
  });

  it("requires a matching native bootstrap for a managed secondary", () => {
    const target = new BearerConnectionTarget({
      ...identity,
      connectionId: "local:native-secondary",
    });
    expect(isStarkPagesLocalConnectionTarget(target, [native])).toBe(false);
    expect(isStarkPagesLocalConnectionTarget(target, [{ ...native, id: "native-secondary" }])).toBe(
      true,
    );
  });

  it("never treats a WSL connection as the desktop host filesystem", () => {
    const target = new BearerConnectionTarget({ ...identity, connectionId: "local:wsl:Ubuntu" });
    expect(isStarkPagesLocalConnectionTarget(target, [{ ...native, id: "wsl:Ubuntu" }])).toBe(
      false,
    );
  });

  it.each([
    new BearerConnectionTarget({ ...identity, connectionId: "saved-remote" }),
    new SshConnectionTarget({ ...identity, connectionId: "ssh-remote" }),
    new RelayConnectionTarget(identity),
  ])("excludes remote targets even while a native bootstrap exists: $_tag", (target) => {
    expect(isStarkPagesLocalConnectionTarget(target, [native])).toBe(false);
  });

  it.each([
    "http://remote.example:3773/",
    "http://user:pass@127.0.0.1:3773/",
    "file:///tmp/host",
    "invalid",
  ])("refuses invalid native bootstrap endpoints: %s", (httpBaseUrl) => {
    expect(
      isStarkPagesLocalConnectionTarget(primary(httpBaseUrl), [{ ...native, httpBaseUrl }]),
    ).toBe(false);
  });
});
