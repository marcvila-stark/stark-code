// SDK callbacks use promises; this store is local to this app's credential file.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  OAuthClientInformationFullSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { PublishedPagesFailure } from "./publishedPagesPolicy.ts";

export interface PublishedPagesCredentials {
  version: 1;
  redirectUrl: string;
  registration: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}
export interface PublishedPagesStore {
  ready(): Promise<void>;
  load(): Promise<PublishedPagesCredentials | undefined>;
  save(value: PublishedPagesCredentials): Promise<void>;
  clear(): Promise<void>;
}

function decodeCredentials(text: string): PublishedPagesCredentials {
  if (Buffer.byteLength(text) > 48 * 1024) throw new PublishedPagesFailure("storage");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new PublishedPagesFailure("storage");
  const data = parsed as Record<string, unknown>;
  const url = typeof data.redirectUrl === "string" ? new URL(data.redirectUrl) : null;
  if (
    data.version !== 1 ||
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/stark-pages/callback" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new PublishedPagesFailure("storage");
  return {
    version: 1,
    redirectUrl: url.href,
    registration: OAuthClientInformationFullSchema.parse(data.registration),
    ...(data.tokens === undefined ? {} : { tokens: OAuthTokensSchema.parse(data.tokens) }),
  };
}

/** One app-owned Keychain entry per desktop profile. No browser or provider entries are read. */
export function keychainPagesStore(input: {
  directory: string;
  createEntry(
    service: string,
    account: string,
  ): Promise<{
    // The native macOS binding returns null for missing entries despite its async declaration.
    getPassword(): Promise<string | null | undefined>;
    setPassword(value: string): Promise<void>;
    deleteCredential(): Promise<boolean>;
  }>;
}): PublishedPagesStore {
  const account = NodeCrypto.createHash("sha256")
    .update(NodePath.resolve(input.directory))
    .digest("hex");
  let entry: ReturnType<typeof input.createEntry> | undefined;
  const getEntry = () => (entry ??= input.createEntry("Stark Code Published Pages", account));
  let accessChecked = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation).catch(() => {
      accessChecked = false;
      throw new PublishedPagesFailure("storage");
    });
    queue = result.catch(() => undefined);
    return result;
  };
  return {
    ready: () =>
      serial(async () => {
        // A successful load already checked access. Writes still go through Keychain.
        if (accessChecked) return;
        await (await getEntry()).getPassword();
        accessChecked = true;
      }),
    load: () =>
      serial(async () => {
        const text = await (await getEntry()).getPassword();
        accessChecked = true;
        return text == null ? undefined : decodeCredentials(text);
      }),
    save: (value) =>
      serial(async () => {
        const text = JSON.stringify(value);
        decodeCredentials(text);
        await (await getEntry()).setPassword(text);
      }),
    clear: () =>
      serial(async () => {
        const key = await getEntry();
        if ((await key.getPassword()) != null) await key.deleteCredential();
      }),
  };
}

export function encryptedPagesStore(input: {
  directory: string;
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Uint8Array>;
  decrypt(bytes: Uint8Array): Promise<string>;
}): PublishedPagesStore {
  const file = NodePath.join(input.directory, "published-pages.credentials");
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation).catch(() => {
      throw new PublishedPagesFailure("storage");
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const available = async () => {
    if (!(await input.available())) throw new PublishedPagesFailure("storage");
  };
  return {
    ready: () => serial(available),
    load: () =>
      serial(async () => {
        let handle: NodeFSP.FileHandle;
        try {
          handle = await NodeFSP.open(
            file,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
        try {
          await available();
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 64 * 1024) throw new PublishedPagesFailure("storage");
          return decodeCredentials(await input.decrypt(await handle.readFile()));
        } finally {
          await handle.close();
        }
      }),
    save: (value) =>
      serial(async () => {
        await available();
        const plaintext = JSON.stringify(value);
        if (Buffer.byteLength(plaintext) > 48 * 1024) throw new PublishedPagesFailure("storage");
        const encrypted = await input.encrypt(plaintext);
        await NodeFSP.mkdir(input.directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
        try {
          await NodeFSP.writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
          await NodeFSP.rename(temporary, file);
        } finally {
          await NodeFSP.rm(temporary, { force: true });
        }
      }),
    clear: () => serial(() => NodeFSP.rm(file, { force: true })),
  };
}
