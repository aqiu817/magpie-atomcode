/**
 * Auto-tracking of the upstream AtomCode client version.
 *
 * Why track at all: the official client force-updates itself on launch, so the
 * gateway most plausibly treats version freshness as part of looking like the
 * client (Atom2Api ships a whole UA checker that reads the same manifest for
 * exactly this concern). This module keeps the plugin on the current version
 * without releases or user action.
 *
 * Behavior contract (deliberately gentle — a metadata fetch must never break a
 * model request):
 *
 *   - the manifest is a public file (`raw.atomgit.com`, same URL Atom2Api's
 *     `ua.go` reads); it is fetched with a short timeout and validated strict;
 *   - a TTL cache (12 h) plus a short failure retry window (5 min) keep the
 *     network load at one GET per host process, retrying quietly;
 *   - `ensure()` can block once per host process at most (cold start); every
 *     later failure just keeps the last known version;
 *   - the fallback is the built-in anchor constant, so an unreachable manifest
 *     degrades to exactly the behavior we shipped and verified live.
 *
 * The version feeds three places and they must agree — `User-Agent`,
 * `X-AtomCode-Ver`, and the signing salt (`sha256(client_version)`). Any
 * self-consistent version produces a valid signature; freshness is the only
 * thing being chased here.
 *
 * @module magpie-atomcode/version
 */

/** Atom2Api `ua.go` 同款 URL：官方仓库的 workspace 声明。 */
export const ATOMCODE_CARGO_URL = "https://raw.atomgit.com/atomgit_atomcode/atomcode/raw/main/Cargo.toml";

/** On a fresh fetch this version is trusted for… */
export const VERSION_TTL_MS = 12 * 3600_000;
/** …and after a failed fetch we stay quiet (and on the cached value) for… */
export const VERSION_FAIL_TTL_MS = 5 * 60_000;
/** Bounded wait for the manifest fetch (once per host process, cold start). */
export const VERSION_TIMEOUT_MS = 10_000;

/** Upstream reads `workspace.package.version` (go-toml), semantic. */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * Pull `workspace.package.version` out of a Cargo.toml text.
 *
 * Line-based on purpose (no TOML dependency): only the top-level
 * `[workspace.package]` section is read, and only semantic versions count.
 * `[package]` versions (like the example crate) are ignored, mirroring
 * Atom2Api's manifest struct.
 *
 * @param {string} text
 * @returns {string|null} the version, or null when absent/invalid.
 */
export function extractVersionFromManifest(text) {
  if (typeof text !== "string") return null;
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inSection = section[1] === "workspace.package";
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*version\s*=\s*"([^"]+)"/);
    if (m) {
      const version = m[1].trim();
      return SEMVER.test(version) ? version : null;
    }
  }
  return null;
}

/** download cap, mirroring Atom2Api's 1 MiB guard */
const MAX_MANIFEST_BYTES = 1 << 20;

/**
 * Fetch and validate the version from the manifest.
 *
 * @param {{url?: string, fetchImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} a semantic version.
 * @throws on network failure, non-2xx, oversize body, missing version.
 */
export async function fetchAtomCodeVersion({
  url = ATOMCODE_CARGO_URL,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = VERSION_TIMEOUT_MS,
} = {}) {
  const res = await fetchImpl(url, {
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`AtomCode manifest returned ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_MANIFEST_BYTES) throw new Error("AtomCode manifest exceeds 1 MiB");
  const version = extractVersionFromManifest(text);
  if (!version) throw new Error("AtomCode manifest has no valid workspace.package.version");
  return version;
}

/**
 * A version source: cache + inflight + bounded refresh.
 *
 * @param {{fallback?: string, url?: string, fetchImpl?: Function, timeoutMs?: number,
 *           ttlMs?: number, failTtlMs?: number, onError?: Function}} [opts]
 * @returns {{get(): string, isLive(): boolean, ensure(): Promise<string>, poke(): void}}
 */
export function createVersionSource({
  fallback = "0.0.0",
  url,
  fetchImpl,
  timeoutMs,
  ttlMs = VERSION_TTL_MS,
  failTtlMs = VERSION_FAIL_TTL_MS,
  onError,
} = {}) {
  // Seeded with the fallback so `get()` is meaningful before any network:
  // at=0 means "stale", which is what makes the first ensure()/poke() fetch.
  const cache = { at: 0, version: fallback ?? "0.0.0" };
  let failedAt = 0;
  let filled = false; // has this host process ever completed one fetch (success or fail)?
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const version = await fetchAtomCodeVersion({ url, fetchImpl, timeoutMs });
        cache.at = Date.now();
        cache.version = version;
        filled = true;
        failedAt = 0;
        return version;
      } catch (error) {
        filled = true; // 冷启动最多等一次，此后一律不阻塞
        failedAt = Date.now();
        try {
          onError?.(error);
        } catch {
          /* the logger is best-effort */
        }
        return undefined;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  const fresh = () => Date.now() - cache.at < ttlMs;
  const quiet = () => Date.now() - failedAt < failTtlMs;

  return {
    /** The current best version — synchronous, never throws. */
    get() {
      return cache.version;
    },
    /** True while the cache is inside its TTL. */
    isLive() {
      return fresh();
    },
    /**
     * Best-effort current version.
     *
     * Fresh cache → immediate. Cold start (first use in this host process) →
     * bounded wait for one fetch. Anything else → background refresh, answer
     * now with the cached value. Never throws.
     */
    async ensure() {
      if (fresh()) return cache.version;
      if (quiet()) return cache.version;
      if (!filled) {
        await refresh();
        return cache.version;
      }
      if (!inflight) refresh().catch(() => {});
      return cache.version;
    },
    /** Fire-and-forget refresh for host startup; never throws. */
    poke() {
      if (fresh() || quiet() || inflight) return;
      refresh().catch(() => {});
    },
  };
}
