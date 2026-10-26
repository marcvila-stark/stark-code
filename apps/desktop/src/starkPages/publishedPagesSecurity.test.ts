// These boundary tests exercise native loopback HTTP and the encrypted app credential file.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off -- real HTTP is needed to verify callback rejection and one-use closure
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  encryptedPagesStore,
  keychainPagesStore,
  type PublishedPagesCredentials,
} from "./publishedPagesStore.ts";
import { pagesOAuthCallback } from "./publishedPagesCallback.ts";
import {
  MAX_PAGES_BYTES,
  pinnedPagesFetch,
  sanitizeReadResult,
  sanitizeReadTool,
} from "./publishedPagesPolicy.ts";

const document: PublishedPagesCredentials = {
  version: 1,
  redirectUrl: "http://127.0.0.1:43219/stark-pages/callback",
  registration: {
    client_id: "test-client",
    client_secret: "test-secret",
    redirect_uris: ["http://127.0.0.1:43219/stark-pages/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  },
  tokens: {
    token_type: "Bearer",
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
  },
};

describe("Published Pages macOS Keychain", () => {
  it("reuses successful load access for readiness without caching credential values", async () => {
    let value: string | undefined;
    const getPassword = vi.fn(async () => value);
    const store = keychainPagesStore({
      directory: "/profile/readiness",
      createEntry: async () => ({
        getPassword,
        setPassword: async (next) => {
          value = next;
        },
        deleteCredential: async () => {
          value = undefined;
          return true;
        },
      }),
    });
    expect(await store.load()).toBeUndefined();
    await store.ready();
    await store.ready();
    expect(getPassword).toHaveBeenCalledOnce();
    value = JSON.stringify(document);
    expect(await store.load()).toEqual(document);
    await store.ready();
    expect(getPassword).toHaveBeenCalledTimes(2);
    await store.clear();
    expect(value).toBeUndefined();
  });

  it("invalidates readiness after native write or delete denial and permits explicit retry", async () => {
    let writeDenied = false;
    let deleteDenied = false;
    const getPassword = vi.fn(async () => JSON.stringify(document));
    const store = keychainPagesStore({
      directory: "/profile/readiness-denial",
      createEntry: async () => ({
        getPassword,
        setPassword: async () => {
          if (writeDenied) throw new Error("private Keychain write error");
        },
        deleteCredential: async () => {
          if (deleteDenied) throw new Error("private Keychain delete error");
          return true;
        },
      }),
    });
    await store.ready();
    writeDenied = true;
    await expect(store.save(document)).rejects.toThrow("securely save");
    await store.ready();
    expect(getPassword).toHaveBeenCalledTimes(2);
    deleteDenied = true;
    await expect(store.clear()).rejects.toThrow("securely save");
    await store.ready();
    expect(getPassword).toHaveBeenCalledTimes(4);
    writeDenied = false;
    deleteDenied = false;
    await store.save(document);
    await store.clear();
  });

  it.each([null, undefined])(
    "handles missing value %s and loads, saves and clears only a profile-specific app entry",
    async (missing) => {
      const secrets = new Map<string, string>();
      const entries: [string, string][] = [];
      const createEntry = async (service: string, account: string) => {
        entries.push([service, account]);
        return {
          getPassword: async () => secrets.get(account) ?? missing,
          setPassword: async (value: string) => {
            secrets.set(account, value);
          },
          deleteCredential: async () => secrets.delete(account),
        };
      };
      const first = keychainPagesStore({ directory: "/profile/one", createEntry });
      const second = keychainPagesStore({ directory: "/profile/two", createEntry });
      await first.ready();
      expect(await first.load()).toBeUndefined();
      await first.clear();
      expect(secrets.size).toBe(0);
      await first.save(document);
      expect(await first.load()).toEqual(document);
      expect(await second.load()).toBeUndefined();
      await second.save(document);
      await first.clear();
      expect(await first.load()).toBeUndefined();
      expect(await second.load()).toEqual(document);
      expect(entries).toHaveLength(2);
      expect(
        entries.every(
          ([service, account]) =>
            service === "Stark Code Published Pages" && /^[0-9a-f]{64}$/.test(account),
        ),
      ).toBe(true);
      expect(entries[0]?.[1]).not.toBe(entries[1]?.[1]);
    },
  );

  it("fails closed and redacts Keychain read, write and delete errors", async () => {
    const store = keychainPagesStore({
      directory: "/profile/error",
      createEntry: async () => ({
        getPassword: async () => {
          throw new Error("sensitive native error");
        },
        setPassword: async () => {
          throw new Error("sensitive native error");
        },
        deleteCredential: async () => {
          throw new Error("sensitive native error");
        },
      }),
    });
    for (const action of [
      () => store.ready(),
      () => store.load(),
      () => store.save(document),
      () => store.clear(),
    ]) {
      await expect(action()).rejects.toThrow("securely save");
      await expect(action()).rejects.not.toThrow("sensitive native error");
    }
  });
});

describe("Published Pages credential store", () => {
  it("stores only protected bytes with private permissions, restores them, and deletes only its own file", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-pages-auth-"));
    const encode = (input: Uint8Array) => input.map((byte) => byte ^ 93);
    const encrypt = vi.fn(async (value: string) => encode(new TextEncoder().encode(value)));
    const store = encryptedPagesStore({
      directory,
      available: async () => true,
      encrypt,
      decrypt: async (value) => new TextDecoder().decode(encode(value)),
    });
    try {
      expect(await store.load()).toBeUndefined();
      await NodeFSP.writeFile(NodePath.join(directory, "unrelated"), "keep");
      await store.save(document);
      expect(encrypt).toHaveBeenCalledOnce();
      const path = NodePath.join(directory, "published-pages.credentials");
      expect((await NodeFSP.readFile(path)).includes(Buffer.from("test-secret"))).toBe(false);
      expect((await NodeFSP.stat(path)).mode & 0o777).toBe(0o600);
      expect(await store.load()).toEqual(document);
      await store.clear();
      expect(await store.load()).toBeUndefined();
      expect(await NodeFSP.readFile(NodePath.join(directory, "unrelated"), "utf8")).toBe("keep");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on unavailable encryption, invalid ciphertext and credential symlinks", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stark-pages-auth-"));
    const file = NodePath.join(directory, "published-pages.credentials");
    let available = false;
    const encrypt = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const store = encryptedPagesStore({
      directory,
      available: async () => available,
      encrypt,
      decrypt: async () => "invalid ciphertext",
    });
    try {
      await expect(store.ready()).rejects.toThrow("securely save");
      await expect(store.save(document)).rejects.toThrow("securely save");
      expect(encrypt).not.toHaveBeenCalled();
      available = true;
      await NodeFSP.writeFile(file, "bad", { mode: 0o600 });
      await expect(store.load()).rejects.toThrow("securely save");
      await NodeFSP.rm(file);
      await NodeFSP.writeFile(NodePath.join(directory, "foreign"), "unchanged");
      await NodeFSP.symlink(NodePath.join(directory, "foreign"), file);
      await expect(store.load()).rejects.toThrow("securely save");
      await store.clear();
      expect(await NodeFSP.readFile(NodePath.join(directory, "foreign"), "utf8")).toBe("unchanged");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Published Pages network and callback boundaries", () => {
  it("pins HTTPS endpoints, blocks redirects, and bounds streamed and declared response sizes", async () => {
    const remote = vi.fn(
      async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    const fetcher = pinnedPagesFetch(remote);
    for (const url of [
      "https://evil.invalid/token",
      "http://pages-ext.starkfuture.com/token",
      "https://pages-ext.starkfuture.com@evil.invalid/token",
      "https://pages-ext.starkfuture.com/token?leak=secret",
      "https://pages-ext.starkfuture.com/api/write",
    ])
      await expect(fetcher(url, { method: "POST" })).rejects.toThrow("not supported");
    expect(remote).not.toHaveBeenCalled();
    await expect(
      pinnedPagesFetch(
        async () =>
          new Response(null, { status: 302, headers: { Location: "https://evil.invalid" } }),
      )("https://pages-ext.starkfuture.com/mcp/"),
    ).rejects.toThrow("not supported");
    await expect(
      pinnedPagesFetch(
        async () =>
          new Response("", { headers: { "Content-Length": String(MAX_PAGES_BYTES + 1) } }),
      )("https://pages-ext.starkfuture.com/mcp/"),
    ).rejects.toThrow("too large");
    const response = await pinnedPagesFetch(
      async () => new Response(new Uint8Array(MAX_PAGES_BYTES + 1)),
    )("https://pages-ext.starkfuture.com/mcp/");
    await expect(response.text()).rejects.toThrow("too large");
  });

  it("rejects wrong/duplicate OAuth state and mixed error/code without consuming the valid callback", async () => {
    const controller = new AbortController();
    const callback = await pagesOAuthCallback("correct-state", controller.signal);
    try {
      for (const query of [
        "state=wrong&code=a",
        "state=correct-state&state=correct-state&code=a",
        "state=correct-state&code=a&code=b",
        "state=correct-state&code=a&error=denied",
      ])
        expect((await fetch(`${callback.url}?${query}`)).status).toBe(400);
      const response = await fetch(`${callback.url}?state=correct-state&code=accepted`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await callback.code).toBe("accepted");
      await expect(fetch(`${callback.url}?state=correct-state&code=replay`)).rejects.toThrow();
    } finally {
      controller.abort();
      callback.close();
    }
  });

  it("rejects remote schema references and oversized payloads, exposing no app-resource metadata", () => {
    expect(() =>
      sanitizeReadTool({
        name: "pages_read_file",
        inputSchema: {
          type: "object",
          properties: { path: { $ref: "https://evil.invalid/schema" } },
        },
      }),
    ).toThrow("not supported");
    expect(() =>
      sanitizeReadResult({ content: [{ type: "text", text: "a".repeat(MAX_PAGES_BYTES) }] }),
    ).toThrow("too large");
    expect(
      sanitizeReadResult({
        content: [{ type: "resource", resource: { uri: "file:///secret", text: "secret" } }],
        _meta: { token: "never-visible" },
      }),
    ).toEqual({ content: [], isError: false });
  });
});
