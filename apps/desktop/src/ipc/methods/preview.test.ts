import { it as effectIt } from "@effect/vitest";
import {
  AGENT_BROWSER_PROFILE_ID,
  IMPORTED_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewAutomationStatus,
} from "@starkfuture/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

const packagedApp = {
  ...ElectronApp.make,
  metadata: Effect.succeed({
    appVersion: "1",
    appPath: "/fixture",
    isPackaged: true,
    resourcesPath: "/fixture",
    runningUnderArm64Translation: false,
  }),
};
const encryptedStorage = ElectronSafeStorage.ElectronSafeStorage.of({
  isEncryptionAvailable: Effect.succeed(true),
  selectedStorageBackend: Effect.succeed(Option.none()),
  encryptString: () => Effect.die("unused"),
  decryptString: () => Effect.die("unused"),
});

const mainFrame = { url: "starkcode://app/" };
const trustedEvent = { sender: { id: 42 }, senderFrame: mainFrame };
const trustedSender = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(ElectronWindow.ElectronWindow, {
      currentMainOrFirst: Effect.succeedSome({ webContents: { id: 42, mainFrame } }),
    } as never),
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
      isDevelopment: false,
      devServerUrl: Option.none(),
    } as never),
  );

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("keeps agent storage ephemeral and outside every personal partition", () => {
    expect(PreviewIpc.resolvePartitionScope("environment", "agent")).toEqual({
      scope: "environment",
      persistent: false,
      namespace: "agent",
    });
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "c");

    expect(first).toEqual({ scope: '["a","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["a::b","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("preserves lone surrogates without collapsing them to replacement characters", () => {
    const highSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\ud800");
    const lowSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\udc00");
    const replacement = PreviewIpc.resolvePartitionScope("environment", "profile-�");

    expect(highSurrogate.scope).toBe('["environment","profile-\\ud800"]');
    expect(lowSurrogate.scope).toBe('["environment","profile-\\udc00"]');
    expect(highSurrogate.scope).not.toBe(lowSurrogate.scope);
    expect(highSurrogate.scope).not.toBe(replacement.scope);
    expect(lowSurrogate.scope).not.toBe(replacement.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID),
    ).toEqual({ scope: "environment::legacy", persistent: true });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID),
    ).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });

  effectIt.effect("imports only selected sites into a personal profile from the main frame", () => {
    const received: Array<Parameters<BrowserImport.BrowserImport["Service"]["importCookies"]>[0]> =
      [];
    const browserImport = BrowserImport.BrowserImport.of({
      listSources: Effect.succeed([]),
      importCookies: (input) =>
        Effect.sync(() => {
          received.push(input);
          return { imported: 0, skipped: 0, skippedDomains: [] };
        }),
    });
    const input = {
      environmentId: "env",
      sourceId: "helium",
      sourceProfileDirectory: "Default",
      targetProfileId: IMPORTED_BROWSER_PROFILE_ID,
      selectedDomains: ["docs.example.com"],
      consent: true,
    };
    return Effect.gen(function* () {
      yield* PreviewIpc.importBrowserCookies.handler(input, trustedEvent);
      expect(received[0]).toMatchObject(
        PreviewIpc.resolvePartitionScope("env", IMPORTED_BROWSER_PROFILE_ID),
      );
      for (const targetProfileId of ["default", "incognito", AGENT_BROWSER_PROFILE_ID, "custom"]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              PreviewIpc.importBrowserCookies.handler({ ...input, targetProfileId }, trustedEvent),
            ),
          ),
        ).toBe(true);
      }
      for (const event of [
        undefined,
        { sender: { id: 43 }, senderFrame: mainFrame },
        { sender: { id: 42 }, senderFrame: { url: "starkcode://app/" } },
      ]) {
        expect(
          Exit.isFailure(yield* Effect.exit(PreviewIpc.importBrowserCookies.handler(input, event))),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(PreviewIpc.listBrowserImportSources.handler(undefined, event)),
          ),
        ).toBe(true);
      }
      for (const unsafe of [{ selectedDomains: [] }, { consent: false }, { consent: undefined }]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              PreviewIpc.importBrowserCookies.handler({ ...input, ...unsafe }, trustedEvent),
            ),
          ),
        ).toBe(true);
      }
      expect(received).toHaveLength(1);
    }).pipe(
      Effect.provideService(BrowserImport.BrowserImport, browserImport),
      Effect.provideService(ElectronApp.ElectronApp, packagedApp),
      Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, encryptedStorage),
      trustedSender,
    );
  });

  effectIt.effect("blocks unencrypted imports before the source service runs", () =>
    Effect.gen(function* () {
      const importCookies = vi.fn(() =>
        Effect.succeed({ imported: 0, skipped: 0, skippedDomains: [] }),
      );
      for (const runtime of [
        { packaged: false, encryption: true, backend: Option.none<string>() },
        { packaged: true, encryption: false, backend: Option.none<string>() },
        { packaged: true, encryption: true, backend: Option.some("basic_text") },
      ]) {
        const error = yield* PreviewIpc.importBrowserCookies
          .handler(
            {
              environmentId: "env",
              sourceId: "helium",
              sourceProfileDirectory: "Default",
              targetProfileId: IMPORTED_BROWSER_PROFILE_ID,
              selectedDomains: ["example.test"],
              consent: true,
            },
            trustedEvent,
          )
          .pipe(
            Effect.provideService(ElectronApp.ElectronApp, {
              ...packagedApp,
              metadata: packagedApp.metadata.pipe(
                Effect.map((metadata) => ({ ...metadata, isPackaged: runtime.packaged })),
              ),
            }),
            Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, {
              ...encryptedStorage,
              isEncryptionAvailable: Effect.succeed(runtime.encryption),
              selectedStorageBackend: Effect.succeed(runtime.backend),
            }),
            Effect.provideService(BrowserImport.BrowserImport, {
              listSources: Effect.succeed([]),
              importCookies,
            }),
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => {
                throw new Error("Expected the unencrypted import to be refused.");
              },
            }),
          );
        expect(error).toMatchObject({ reason: "storageNotEncrypted" });
      }
      expect(importCookies).not.toHaveBeenCalled();
    }).pipe(trustedSender),
  );

  effectIt.effect("marks the default source without importing or choosing its profile", () => {
    const importCookies = vi.fn();
    const sources = [
      { id: "chrome" as const, name: "Chrome", profiles: [] },
      {
        id: "firefox" as const,
        name: "Firefox",
        profiles: [],
        unavailable: "browserRunning" as const,
      },
    ];
    return Effect.gen(function* () {
      const listed = yield* PreviewIpc.listBrowserImportSources.handler(undefined, trustedEvent);
      expect(listed).toEqual([sources[0], { ...sources[1], isDefault: true }]);
      expect(importCookies).not.toHaveBeenCalled();
    }).pipe(
      trustedSender,
      Effect.provideService(BrowserImport.BrowserImport, {
        listSources: Effect.succeed(sources),
        importCookies,
      }),
      Effect.provideService(ElectronApp.ElectronApp, {
        ...ElectronApp.make,
        applicationForProtocol: () =>
          Effect.succeed({ name: "Firefox", path: "/Applications/Firefox.app" }),
      }),
    );
  });

  effectIt.effect("keeps sources usable when the default handler is unknown", () => {
    const sources = [{ id: "chrome" as const, name: "Chrome", profiles: [] }];
    return Effect.gen(function* () {
      expect(yield* PreviewIpc.listBrowserImportSources.handler(undefined, trustedEvent)).toEqual(
        sources,
      );
    }).pipe(
      trustedSender,
      Effect.provideService(BrowserImport.BrowserImport, {
        listSources: Effect.succeed(sources),
        importCookies: vi.fn(),
      }),
      Effect.provideService(ElectronApp.ElectronApp, {
        ...ElectronApp.make,
        applicationForProtocol: () =>
          Effect.succeed({ name: "Browser Selector", path: "/Applications/Browser Selector.app" }),
      }),
    );
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  it("keeps the public automation status tab id limit", () => {
    const encode = Schema.encodeUnknownSync(PreviewAutomationStatus);
    const tabId = "t".repeat(129);

    expect(() =>
      encode({
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      }),
    ).toThrow();
  });
});
