import type { ServerProvider } from "@starkfuture/contracts";

const STORAGE_KEY = "starkcode:title-skill-catalog:v1";
const MAX_SCOPES = 256;
const MAX_NAMES = 512;
type Catalog = Record<string, readonly string[]>;
let lastRaw: string | null = null;
let loaded: Catalog = {};

const keyFor = (environmentId: string, providerId: string, cwd?: string | null) =>
  JSON.stringify([environmentId, providerId, cwd ?? null]);

function readCatalog(): Catalog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === lastRaw) return loaded;
    const value: unknown = raw ? JSON.parse(raw) : {};
    const next: Catalog = {};
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [key, names] of Object.entries(value).slice(-MAX_SCOPES)) {
        if (Array.isArray(names))
          next[key] = names
            .filter(
              (name): name is string =>
                typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(name),
            )
            .slice(0, MAX_NAMES);
      }
    }
    lastRaw = raw;
    loaded = next;
  } catch {
    // Storage is optional. Never turn unavailable metadata into a guessed skill.
  }
  return loaded;
}

/** Display-only names and workspace scopes from real catalogs; never credentials or skill content. */
export function rememberTitleSkills(
  environmentId: string,
  providers: readonly Pick<ServerProvider, "instanceId" | "skills" | "workspaceSnapshots">[],
) {
  const next = { ...readCatalog() };
  let changed = false;
  const remember = (
    providerId: string,
    cwd: string | null,
    skills: readonly { name: string }[],
  ) => {
    if (!skills.length) return;
    const key = keyFor(environmentId, providerId, cwd);
    const names = [...new Set([...(next[key] ?? []), ...skills.map((skill) => skill.name)])].slice(
      -MAX_NAMES,
    );
    if (JSON.stringify(names) === JSON.stringify(next[key])) return;
    delete next[key];
    next[key] = names;
    changed = true;
  };
  for (const provider of providers) {
    remember(provider.instanceId, null, provider.skills);
    for (const snapshot of provider.workspaceSnapshots ?? [])
      remember(provider.instanceId, snapshot.cwd, snapshot.skills);
  }
  if (!changed) return;
  loaded = Object.fromEntries(Object.entries(next).slice(-MAX_SCOPES));
  try {
    lastRaw = JSON.stringify(loaded);
    localStorage.setItem(STORAGE_KEY, lastRaw);
  } catch {
    lastRaw = null;
  }
}

export function rememberedTitleSkills(
  environmentId: string | null | undefined,
  providerId: string | null | undefined,
  cwd?: string | null,
): readonly { name: string }[] {
  if (!environmentId || !providerId) return [];
  const catalog = readCatalog();
  return [
    ...new Set([
      ...(catalog[keyFor(environmentId, providerId)] ?? []),
      ...(cwd ? (catalog[keyFor(environmentId, providerId, cwd)] ?? []) : []),
    ]),
  ].map((name) => ({ name }));
}
