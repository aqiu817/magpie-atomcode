/**
 * Model discovery for AtomCode CodingPlan.
 *
 * The model catalog lives on `models-v2`, is scoped to the account's plan tier,
 * and shifts over time and between accounts (Atom2Api's README example names
 * models different from what real accounts receive), so the live list is the
 * source of truth once a signed-in account exists.
 *
 * `FALLBACK_MODELS` is the snapshot that keeps the provider selectable before a
 * sign-in or when the fetch fails; it is the real list this account observed on
 * 2026-10-16 and may go stale — which is fine, the live list replaces it.
 *
 * The model *key* (what agents address by) is sanitized; the original
 * `display_model_name` rides along as `api.id` because that is the id the
 * upstream gateway expects in request bodies.
 *
 * @module magpie-atomcode/models
 */

import { fetchStatus, fetchModels, planOf, planTier } from "./codingplan.mjs";
import { DEFAULT_GATEWAY_BASE_URL } from "./internal.mjs";

/** The AI SDK package that speaks the OpenAI-compatible dialect. */
export const NPM = "@ai-sdk/openai-compatible";

/** LLM gateway root; loader requests and `api.url` default to it. */
export const DEFAULT_BASE_URL = DEFAULT_GATEWAY_BASE_URL;

/** Upstream `defaults 64000` when a row lacks a context window (Atom2Api 同款兜底). */
export const DEFAULT_CONTEXT = 64000;
export const DEFAULT_OUTPUT = 32768;

/** How long one account's fetched list is trusted. */
export const MODELS_TTL_MS = 10 * 60_000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Model keys may contain `/` or other characters that complicate addressing;
 * the unsanitized id stays in `api.id`, so the wire never sees the mangled one.
 */
export function sanitizeModelKey(value) {
  const id = String(value ?? "").trim();
  const key = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return key || id;
}

/** The observed 2026-10-16 catalog, in `models-v2` row shape. */
export const FALLBACK_MODELS = [
  {
    display_model_name: "qwen3.8-27b",
    context_window: 262144,
    reasoning_effort_levels: ["low", "medium", "xhigh"],
    supports_vision: true,
  },
  {
    display_model_name: "glm5.3-flash",
    context_window: 512000,
    reasoning_effort_levels: ["low", "high"],
    supports_vision: true,
  },
];

/**
 * Normalize one `models-v2` row (or a `FALLBACK_MODELS` entry, same shape).
 *
 * @returns {{id: string, key: string, context: number, output: number, levels: string[], vision: boolean, type: string, baseURL?: string}|null}
 */
export function normalizeCodingPlanModel(raw = {}, { output = DEFAULT_OUTPUT } = {}) {
  const id = typeof raw.display_model_name === "string" ? raw.display_model_name.trim() : "";
  if (!id) return null;
  const levels = Array.isArray(raw.reasoning_effort_levels)
    ? raw.reasoning_effort_levels.filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim())
    : [];
  return {
    id,
    key: sanitizeModelKey(id),
    context: num(raw.context_window) > 0 ? num(raw.context_window) : DEFAULT_CONTEXT,
    output,
    levels,
    vision: raw.supports_vision === true,
    type: typeof raw.type === "string" && raw.type ? raw.type : "openai",
    baseURL: typeof raw.base_url === "string" && raw.base_url ? raw.base_url : undefined,
  };
}

/** The `config` hook's entry declaring one model. */
export function toConfigModel(m = {}) {
  const levels = m.levels ?? [];
  const entry = {
    name: m.id ?? m.key,
    reasoning: levels.length > 0,
    tool_call: true,
    attachment: m.vision === true,
    modalities: { input: m.vision === true ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: m.context ?? DEFAULT_CONTEXT, output: m.output ?? DEFAULT_OUTPUT },
  };
  if (levels.length) entry.variants = Object.fromEntries(levels.map((l) => [l, {}]));
  if (m.key && m.id && m.key !== m.id) entry.id = m.id;
  return entry;
}

/** The `provider.models` entry for one model, in Magpie's model shape. */
export function toProviderModel(m = {}, providerID, { baseURL = DEFAULT_BASE_URL, npm = NPM } = {}) {
  const levels = m.levels ?? [];
  return {
    id: m.key,
    providerID,
    name: m.id ?? m.key,
    api: { id: m.id ?? m.key, url: m.baseURL ?? baseURL, npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? DEFAULT_CONTEXT, output: m.output ?? DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning: levels.length > 0,
      attachment: m.vision === true,
      toolcall: true,
      input: { text: true, image: m.vision === true, audio: false, video: false, pdf: false },
      output: { text: true },
      interleaved: false,
    },
    release_date: "",
    variants: Object.fromEntries(levels.map((l) => [l, {}])),
  };
}

/**
 * One account's catalog, fetched once and cached.
 *
 * The chain is `status-v2` → plan tier → `models-v2?plan_type=`; results key on
 * the account (`uid` preferred, access token otherwise) so two accounts never
 * share a cache entry. Errors propagate — including `signIn: "expired"` ones —
 * so the provider hook decides between fallback and account marking.
 *
 * @param {{apiBase: string, clientVersion: string, timeoutMs?: number, ttlMs?: number, output?: number, fetchImpl?: Function}} opts
 */
export function createCatalog({
  apiBase,
  clientVersion,
  timeoutMs = 20_000,
  ttlMs = MODELS_TTL_MS,
  output = DEFAULT_OUTPUT,
  fetchImpl,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  /**
   * @param {{access: string, uid?: string}} credentials
   * @param {{output?: number}} [perCall]
   */
  async function load(credentials, { output: outputOverride = output, clientVersion: version = clientVersion } = {}) {
    if (!credentials?.access) return [];
    const key = credentials.uid ?? credentials.access;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.models;
    const pending = inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      const status = await fetchStatus(apiBase, credentials.access, { fetchImpl, clientVersion: version, timeoutMs });
      const tier = planTier(planOf(status)?.plan_name);
      const rows = await fetchModels(apiBase, credentials.access, tier, { fetchImpl, clientVersion: version, timeoutMs });
      const models = rows
        .map((row) => normalizeCodingPlanModel(row, { output: outputOverride }))
        .filter(Boolean);
      if (models.length) cache.set(key, { at: Date.now(), models });
      return models;
    })().finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  return { load };
}
