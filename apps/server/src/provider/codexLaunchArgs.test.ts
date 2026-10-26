import { CODEX_PRIVACY_ARGS } from "@starkfuture/shared/providerPrivacy";
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses STARK_CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { STARK_CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when STARK_CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { STARK_CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { STARK_CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server", ...CODEX_PRIVACY_ARGS]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
      ...CODEX_PRIVACY_ARGS,
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5", ...CODEX_PRIVACY_ARGS],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
      ...CODEX_PRIVACY_ARGS,
    ]);
  });
});
