// @effect-diagnostics nodeBuiltinImport:off - Builds encrypted browser-shaped
// SQLite fixtures with Node's crypto/SQLite APIs; no real browser data is read.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { BROWSER_IMPORT_MAX_DOMAINS } from "@starkfuture/contracts";
import * as HostProcess from "@starkfuture/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { CookiesSetDetails, Session } from "electron";
import { beforeEach, vi } from "vite-plus/test";

import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "./Sources.ts";

const { keychainEntry, getPassword } = vi.hoisted(() => ({
  keychainEntry: vi.fn<(service: string, account: string) => void>(),
  getPassword: vi.fn(() => "fixture-passphrase"),
}));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(service: string, account: string) {
      keychainEntry(service, account);
    }
    getPassword = getPassword;
  },
}));
beforeEach(() => {
  keychainEntry.mockClear();
  getPassword.mockClear();
});

const encryptCookie = (host: string, value: string) => {
  const key = NodeCrypto.pbkdf2Sync("fixture-passphrase", "saltysalt", 1003, 16, "sha1");
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const bound = Buffer.concat([
    NodeCrypto.createHash("sha256").update(host).digest(),
    Buffer.from(value),
  ]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(bound), cipher.final()]);
};

const fixture = Effect.fnUntraced(function* (
  sourceId: "chrome" | "brave" | "zen",
  selectedDomains: ReadonlyArray<string> = ["chosen.example"],
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "stark-browser-fixture-" });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  const definition = BROWSER_IMPORT_SOURCES.find((source) => source.id === sourceId)!;
  const browserRoot = definition.userDataDirectory(context)!;
  const directory = sourceId === "zen" ? "Profiles/current" : "Profile 1";
  const profile = context.path.join(browserRoot, directory);
  yield* fs.makeDirectory(sourceId === "zen" ? profile : context.path.join(profile, "Network"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    context.path.join(browserRoot, sourceId === "zen" ? "profiles.ini" : "Local State"),
    sourceId === "zen"
      ? "[Profile0]\nName=Work account\nIsRelative=1\nPath=Profiles/current\n"
      : '{"profile":{"info_cache":{"Profile 1":{"name":"Work account"}}}}',
  );
  const filename = context.path.join(
    profile,
    ...(sourceId === "zen" ? ["cookies.sqlite"] : ["Network", "Cookies"]),
  );
  yield* Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(filename);
    try {
      if (sourceId === "zen") {
        database.exec(`
          pragma user_version = 16;
          create table moz_cookies (
            host text, name text, value text, path text, expiry integer,
            isSecure integer, isHttpOnly integer, sameSite integer, originAttributes text
          );
        `);
        const insert = database.prepare(
          "insert into moz_cookies values (?, ?, ?, '/', 0, 1, 1, 1, ?)",
        );
        insert.run("chosen.example", "session", "selected-value", "");
        insert.run("other.example", "other", "excluded-value", "");
        insert.run("chosen.example", "session", "container-identity", "^userContextId=2");
      } else {
        database.exec(`
          create table meta (key text primary key, value text);
          insert into meta values ('version', '24');
          create table cookies (
            host_key text, name text, value text, encrypted_value blob, path text,
            expires_utc integer, is_secure integer, is_httponly integer,
            samesite integer, top_frame_site_key text
          );
        `);
        const insert = database.prepare(
          "insert into cookies values (?, ?, '', ?, '/', 0, 1, 1, 1, '')",
        );
        insert.run("chosen.example", "session", encryptCookie("chosen.example", "selected-value"));
        insert.run("other.example", "other", encryptCookie("other.example", "excluded-value"));
      }
    } finally {
      database.close();
    }
  });
  const sourceBefore = yield* fs.readFile(filename);
  const writes: CookiesSetDetails[] = [];
  let flushes = 0;
  const sessions: Array<{
    scope: string | undefined;
    persistent: boolean | undefined;
    namespace: string | undefined;
  }> = [];
  const browserSession = BrowserSession.BrowserSession.of({
    getPartition: () => Effect.die("unused"),
    isPartition: () => false,
    getSession: (scope, persistent, namespace) =>
      Effect.sync(() => {
        sessions.push({ scope, persistent, namespace });
        return {
          cookies: {
            set: async (cookie: CookiesSetDetails) => {
              writes.push(cookie);
            },
            flushStore: async () => {
              flushes += 1;
            },
          },
        } as unknown as Session;
      }),
    clearCookies: () => Effect.die("unused"),
    clearCache: () => Effect.die("unused"),
  });
  const importer = yield* BrowserImport.make.pipe(
    Effect.provideService(BrowserSession.BrowserSession, browserSession),
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.ExecutablePath, "/fixture/Stark Code.app"),
  );
  const listed = (yield* importer.listSources).find((source) => source.id === sourceId);
  expect(listed?.unavailable).toBeUndefined();
  expect(listed?.profiles).toEqual([
    {
      directory,
      name: "Work account",
      cookieCount: 2,
      domains: ["chosen.example", "other.example"],
      domainsTruncated: false,
    },
  ]);
  // Inventory never requests the browser's key.
  expect(keychainEntry).not.toHaveBeenCalled();
  const result = yield* importer.importCookies({
    input: {
      sourceId,
      sourceProfileDirectory: directory,
      targetProfileId: "personal-imported",
      selectedDomains,
      consent: true,
    },
    scope: "fixture-personal-imported",
    persistent: true,
    namespace: "profile",
  });
  expect(result).toEqual({ imported: 1, skipped: 1, skippedDomains: ["other.example"] });
  expect(writes).toEqual([
    expect.objectContaining({
      url: "https://chosen.example/",
      name: "session",
      value: "selected-value",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    }),
  ]);
  expect(sessions).toEqual([
    { scope: "fixture-personal-imported", persistent: true, namespace: "profile" },
  ]);
  expect(flushes).toBe(1);
  expect(yield* fs.readFile(filename)).toEqual(sourceBefore);
});

it.effect.each([
  { sourceId: "chrome", service: "Chrome Safe Storage", account: "Chrome" },
  { sourceId: "brave", service: "Brave Safe Storage", account: "Brave" },
] as const)(
  "$sourceId: discovers its profile and decrypts only into the personal destination",
  ({ sourceId, service, account }) =>
    fixture(sourceId).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(keychainEntry).toHaveBeenCalledExactlyOnceWith(service, account);
          expect(getPassword).toHaveBeenCalledTimes(1);
        }),
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
);

it.effect(
  "Zen: discovers its own profile and preserves default-container identity without Keychain",
  () =>
    fixture("zen").pipe(
      Effect.tap(() => Effect.sync(() => expect(keychainEntry).not.toHaveBeenCalled())),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
);

it.effect("accepts the maximum exact-host selection, including manually entered sites", () =>
  fixture("zen", [
    ...Array.from(
      { length: BROWSER_IMPORT_MAX_DOMAINS - 1 },
      (_, index) => `manual-${index}.example`,
    ),
    "chosen.example",
  ]).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
