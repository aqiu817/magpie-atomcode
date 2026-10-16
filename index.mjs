/**
 * AtomCode (AtomGit CodingPlan) provider plugin for Magpie.
 *
 * Direct-to-upstream, no Atom2Api instance in between:
 *
 *   - **Sign-in** is browser OAuth via the AtomGit broker (`acs.atomgit.com`);
 *     tokens live in Magpie's `plugin-auth.json` and are renewed either by
 *     `auth.refresh` (Magpie ≥ 0.1.684) or, on OpenCode and older Magpie hosts,
 *     by the fallback refresh inside `fetch`.
 *   - **Requests** reach `https://llm-api.atomgit.com/v1` as plain Chat
 *     Completions (`@ai-sdk/openai-compatible`); this plugin's `fetch` adds the
 *     `atomcode-signing-v1` headers plus the required `atomcode/<version>`
 *     User-Agent, then forwards untouched — body, streams and everything.
 *   - **Model & quota** come from CodingPlan REST (`api.gitcode.com`), mapped so
 *     the account row and `magpie quota` show the plan and its 5-hour window.
 *
 * This file exports **exactly one function, and nothing else** — the module
 * must also load under OpenCode, which calls every exported function. Helpers
 * live in `internal.mjs`, `sign.mjs`, `oauth.mjs`, `codingplan.mjs`, `quota.mjs`
 * and `models.mjs`.
 *
 * @module magpie-atomcode
 */

import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_CODING_PLAN_API_URL,
  DEFAULT_PLATFORM_BASE_URL,
  DEFAULT_GATEWAY_BASE_URL,
  ICON,
  PROVIDER,
  credentialsOf,
  fellBack,
  readAuth,
} from "./internal.mjs";
import { MASTER_KEY_HEX, signAtomGitRequest } from "./sign.mjs";
import {
  checkLogin,
  refreshTokens,
  startLogin,
  tokenFor,
  userAgentOf,
} from "./oauth.mjs";
import { claimCodingPlan, fetchStatus, planNeedsClaim } from "./codingplan.mjs";
import { createVersionSource } from "./version.mjs";
import { quotaFromStatus } from "./quota.mjs";
import {
  FALLBACK_MODELS,
  NPM,
  createCatalog,
  normalizeCodingPlanModel,
  toConfigModel,
  toProviderModel,
} from "./models.mjs";
import { fill, resolveLocale, strings as tableFor } from "./i18n.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the plugin.
 *
 * @param {{client?: object}} input - the plugin input the host passes.
 * @param {object} [options] - the `options` field from `plugins.json`:
 *   `locale`, `clientVersion`, `masterKeyHex`, `platformBaseURL`,
 *   `codingPlanAPIURL`, `quotaTtlMs`, `maxOutputTokens`.
 * @returns {Promise<object>} the hooks the host calls.
 */
export async function AtomCodePlugin({ client } = {}, options = {}) {
  const t = tableFor(resolveLocale(options.locale));

  const opts = {
    clientVersion:
      typeof options.clientVersion === "string" && options.clientVersion
        ? options.clientVersion
        : DEFAULT_CLIENT_VERSION,
    // 逃生口：上游换 master key 时不发版热修（对齐 Atom2Api 的 signer_url 思路）。
    masterKeyHex: /^[0-9a-fA-F]{64}$/.test(String(options.masterKeyHex ?? ""))
      ? options.masterKeyHex
      : MASTER_KEY_HEX,
    platformBaseURL:
      typeof options.platformBaseURL === "string" && options.platformBaseURL
        ? options.platformBaseURL
        : DEFAULT_PLATFORM_BASE_URL,
    codingPlanAPIURL:
      typeof options.codingPlanAPIURL === "string" && options.codingPlanAPIURL
        ? options.codingPlanAPIURL
        : DEFAULT_CODING_PLAN_API_URL,
    gatewayURL: DEFAULT_GATEWAY_BASE_URL,
    quotaTtlMs: Number(options.quotaTtlMs) > 0 ? Number(options.quotaTtlMs) : 60_000,
    maxOutputTokens: Number(options.maxOutputTokens) > 0 ? Number(options.maxOutputTokens) : 32_768,
    // 官方客户端发新版会强制更新 → 版本新鲜度大概率影响网关放行；默认自动跟随
    // 官方仓库版本，拉取失败退回 clientVersion，绝不阻塞请求。
    autoVersion: options.autoVersion !== false,
    // 登录成功后按 Max→Pro→Lite 幂等领取 CodingPlan（重复领取上游返回 duplicate）。
    autoClaim: options.autoClaim !== false,
  };

  const log = (level, message) => {
    try {
      client?.app?.log?.({ body: { service: PROVIDER, level, message } });
    } catch {
      /* the host's logger is best-effort */
    }
  };

  const catalog = createCatalog({
    apiBase: opts.codingPlanAPIURL,
    clientVersion: opts.clientVersion,
    output: opts.maxOutputTokens,
  });

  const versionSource = createVersionSource({
    fallback: opts.clientVersion,
    onError: (error) => log("warn", `${PROVIDER}: version check: ${error.message}`),
  });
  // 宿主一启动就后台探一次；首个真实请求到达前多半已就位。
  if (opts.autoVersion) versionSource.poke();

  /** 本次请求用的版本号：UA、X-AtomCode-Ver、签名盐取同一值（绝不抛错）。 */
  const clientVersionNow = () =>
    opts.autoVersion ? versionSource.ensure() : Promise.resolve(opts.clientVersion);

  const seedModels = () =>
    Object.fromEntries(
      FALLBACK_MODELS.map((raw) => {
        const m = normalizeCodingPlanModel(raw, { output: opts.maxOutputTokens });
        return [m.key, toConfigModel(m)];
      }),
    );

  /** How the provider row names this account. */
  const userLabel = (auth) => {
    if (!auth || typeof auth !== "object") return undefined;
    return auth.name ?? auth.email ?? auth.accountId;
  };

  const markExpired = () => Object.assign(new Error(t.reloginRequired), { signIn: "expired" });

  /**
   * Renew one account's token.
   *
   * Keyed singleflight on the refresh token: requests that discover an expiring
   * token together wait on one renewal, so a rotate-once upstream is never hit
   * twice. Returns `{access, refresh, expires}` only — the caller persists what
   * it needs (`auth.refresh`'s fields merge; `client.auth.set` replaces).
   */
  const refreshInflight = new Map();
  async function refreshAccount(credentials) {
    if (!credentials?.refresh) {
      throw markExpired();
    }
    const pending = refreshInflight.get(credentials.refresh);
    if (pending) return pending;
    const p = (async () => {
      // expires 已过时兜底值取旧剩余；上游不给 expires_in 时沿用旧宽度
      // （Atom2Api 同款：缺省找回旧值）。
      const oldSpanSec =
        credentials.expires && credentials.expires > Date.now()
          ? Math.max(1, Math.round((credentials.expires - Date.now()) / 1000))
          : 0;
      const next = await refreshTokens(
        opts.platformBaseURL,
        credentials.refresh,
        {
          clientVersion: opts.clientVersion,
          fallbackExpiresIn: oldSpanSec > 0 ? oldSpanSec : undefined,
        },
      );
      const expiresInSec =
        next.expiresIn > 0 ? next.expiresIn : oldSpanSec > 0 ? oldSpanSec : 7 * 24 * 3600;
      return {
        access: next.accessToken,
        refresh: next.refreshToken ?? credentials.refresh,
        expires: Date.now() + expiresInSec * 1000,
      };
    })().finally(() => refreshInflight.delete(credentials.refresh));
    refreshInflight.set(credentials.refresh, p);
    return p;
  }

  /** Cache quota per account so a polled hook costs one request a minute. */
  const quotaCache = new Map();

  /**
   * 签到（重领）：套餐缺失或到期时按档位级联补领一次。
   *
   * 只在 status 判定确实需要时才动手（planNeedsClaim，保守判定），30 分钟
   * 冷却防止在"日限额已满"的放量节奏上空转；结果只进日志，绝不影响
   * usage / models 的正常返回。
   */
  const RECLAIM_COOLDOWN_MS = 30 * 60_000;
  const claimCooldown = new Map();
  async function ensurePlan(credentials, { status } = {}) {
    if (!opts.autoClaim) return false;
    try {
      if (!status) {
        status = await fetchStatus(opts.codingPlanAPIURL, credentials.access, {
          clientVersion: await clientVersionNow(),
        });
      }
      if (!planNeedsClaim(status)) return false;
    } catch (error) {
      log("warn", `${PROVIDER}: ${fill(t.readFailed, { detail: error.message })}`);
      return false;
    }
    const key = credentials.uid ?? credentials.access;
    if (Date.now() < (claimCooldown.get(key) ?? 0)) return false;
    claimCooldown.set(key, Date.now() + RECLAIM_COOLDOWN_MS);
    try {
      const claim = await claimCodingPlan(opts.codingPlanAPIURL, credentials.access, {
        clientVersion: await clientVersionNow(),
      });
      if (claim.claimed) log("info", `${PROVIDER}: ${fill(t.reclaimed, { plan: claim.planName || claim.tier })}`);
      else log("warn", `${PROVIDER}: ${fill(t.reclaimFailed, { detail: claim.message })}`);
      return claim.claimed;
    } catch (error) {
      log("warn", `${PROVIDER}: ${fill(t.reclaimFailed, { detail: error.message })}`);
      return false;
    }
  }

  return {
    /** Declare the provider and its snapshot models. */
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        // 显示名固定全大写（设置页卡片/标签用）；provider id 仍是小写 atomcode
        name: "ATOMCODE",
        npm: NPM,
        api: opts.gatewayURL,
        ...was,
        models: { ...seedModels(), ...(was.models ?? {}) },
      };
    },

    provider: {
      id: PROVIDER,
      /**
       * The models this account can actually use.
       *
       * Failing (or an empty catalog) falls back to the declared list marked
       * `fellBack`, so the provider never vanishes; an expired sign-in throws,
       * which marks the account for re-login.
       */
      async models(provider, { auth } = {}) {
        const declared = provider?.models ?? seedModels();
        const credentials = credentialsOf(auth);
        if (!credentials?.access) return fellBack(declared);
        try {
          let list = await catalog.load(credentials, { clientVersion: await clientVersionNow() });
          // 目录为空的合法场景之一是"权益还没发放"（官方注释同款）——先签到重领一次再取。
          if (!list.length && (await ensurePlan(credentials))) {
            list = await catalog.load(credentials, { clientVersion: await clientVersionNow() });
          }
          if (!list.length) {
            log("warn", `${PROVIDER}: ${t.modelListEmpty}`);
            return fellBack(declared);
          }
          return Object.fromEntries(
            list.map((m) => [
              m.key,
              toProviderModel(m, PROVIDER, { baseURL: opts.gatewayURL, npm: NPM }),
            ]),
          );
        } catch (error) {
          if (error.signIn === "expired") throw markExpired();
          log("warn", `${PROVIDER}: ${t.modelsUnavailable}: ${error.message}`);
          return fellBack(declared);
        }
      },
    },

    auth: {
      provider: PROVIDER,
      ...(ICON === undefined ? {} : { icon: ICON }),

      /** One method: browser OAuth via the AtomGit broker. */
      methods: [
        {
          type: "oauth",
          label: t.methodLabel,
          async authorize() {
            let started;
            try {
              started = await startLogin(opts.platformBaseURL, { clientVersion: await clientVersionNow() });
            } catch (error) {
              throw new Error(fill(t.loginFailed, { detail: error.message }));
            }
            return {
              url: started.loginUrl,
              instructions: t.instructions,
              method: "auto",
              /**
               * Poll until the browser side finishes: check → token, ~2.5 s
               * cadence, ~9 min budget (the broker's own session is 10 min).
               */
              async callback() {
                const deadline = Date.now() + 9 * 60_000;
                while (Date.now() < deadline) {
                  await sleep(2_500);
                  let valid = false;
                  try {
                    valid = await checkLogin(opts.platformBaseURL, started.state, {
                      clientVersion: await clientVersionNow(),
                    });
                  } catch (error) {
                    log("warn", `${PROVIDER}: login check: ${error.message}`);
                    continue;
                  }
                  if (!valid) continue;
                  try {
                    const token = await tokenFor(opts.platformBaseURL, started.state, {
                      clientVersion: await clientVersionNow(),
                    });
                    // 签到闭环的最后一步（Atom2Api 登录后同款）：把计划领上。
                    // 幂等（重复领取返回 duplicate），失败只记日志、绝不拦登录。
                    if (opts.autoClaim) {
                      try {
                        const claim = await claimCodingPlan(opts.codingPlanAPIURL, token.accessToken, {
                          clientVersion: await clientVersionNow(),
                        });
                        if (claim.claimed) log("info", `${PROVIDER}: coding plan: ${claim.planName || claim.tier}`);
                        else log("warn", `${PROVIDER}: coding plan: ${claim.message}`);
                      } catch (error) {
                        log("warn", `${PROVIDER}: coding plan claim failed: ${error.message}`);
                      }
                    }
                    return {
                      type: "success",
                      refresh: token.refreshToken,
                      access: token.accessToken,
                      expires: Date.now() + (token.expiresIn > 0 ? token.expiresIn * 1000 : 7 * 24 * 3600_000),
                      // Magpie names the account from accountId, then metadata.email,
                      // then email — email first, per its own guidance.
                      accountId: token.user.email || token.user.username || String(token.user.id),
                      email: token.user.email || undefined,
                      name: token.user.name || token.user.username || undefined,
                      uid: String(token.user.id),
                    };
                  } catch (error) {
                    log("warn", `${PROVIDER}: login finish: ${error.message}`);
                    return { type: "failed", error: fill(t.loginFailed, { detail: error.message }) };
                  }
                }
                return { type: "failed", error: t.loginTimeout };
              },
            };
          },
        },
      ],

      /**
       * The account, resolved into request routing.
       *
       * The returned `fetch` is the only place bodies get touched — they are
       * read (to sign) but never modified; responses stream back untouched.
       */
      async loader(getAuth) {
        return {
          baseURL: opts.gatewayURL,
          async fetch(input, init) {
            // Re-read per request so a sign-in that changes mid-session is
            // picked up without waiting for the loader to re-run.
            const raw = await readAuth(getAuth);
            let credentials = credentialsOf(raw);
            if (!credentials) {
              // No signed-in account: ship the request without credentials and
              // let the upstream's own answer tell the agent what happened.
              const isRequest = input instanceof Request;
              const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
              headers.delete("authorization");
              if (isRequest) return fetch(new Request(input, { ...init, headers }));
              return fetch(input, { ...init, headers });
            }

            // Fallback renewal (Magpie's native auth.refresh normally runs first
            // and finds the token already fresh). Fully caused-and-persisted here.
            if (credentials.expires && credentials.expires <= Date.now()) {
              try {
                const next = await refreshAccount(credentials);
                await client?.auth?.set?.({
                  path: { id: PROVIDER },
                  body: {
                    ...raw,
                    type: "oauth",
                    access: next.access,
                    refresh: next.refresh,
                    expires: next.expires,
                  },
                });
                credentials = { ...credentials, ...next };
              } catch (error) {
                if (error.signIn === "expired") throw markExpired();
                // 网络类的续期失败不拦请求：带着旧 token 继续发，由上游回答。
                log("warn", `${PROVIDER}: ${fill(t.refreshFailed, { detail: error.message })}`);
              }
            }

            if (!credentials.uid) throw markExpired();

            // UA、X-AtomCode-Ver、签名盐同源自这一个值
            const clientVersion = await clientVersionNow();

            const isRequest = input instanceof Request;
            const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));

            // Hash what is actually being sent. Magpie hands a JSON string in
            // `init.body`; a Request's stream is buffered once, read-only.
            let body = init?.body;
            if (body === undefined || body === null) {
              if (isRequest && input.body) body = new Uint8Array(await input.clone().arrayBuffer());
              else body = "";
            }

            const signed = signAtomGitRequest({
              method: init?.method ?? (isRequest ? input.method : "GET"),
              path: new URL(isRequest ? input.url : String(input)).pathname,
              body,
              oauthToken: credentials.access,
              userId: credentials.uid,
              clientVersion,
              masterKeyHex: opts.masterKeyHex,
            });
            for (const [key, value] of Object.entries(signed)) headers.set(key, value);
            headers.set("authorization", `Bearer ${credentials.access}`);
            headers.set("user-agent", userAgentOf(clientVersion));

            // body 与响应都不改写（流式逐块透传是 Magpie 的本职）。
            if (isRequest) return fetch(new Request(input, { ...init, headers }));
            return fetch(input, { ...init, headers });
          },
        };
      },

      /**
       * The CodingPlan quota, as the provider row and `magpie quota` show it.
       */
      async usage(getAuth) {
        const raw = await readAuth(getAuth);
        const user = userLabel(raw);
        const credentials = credentialsOf(raw);
        const cacheKey = credentials?.uid ?? credentials?.access ?? "no-account";
        const hit = quotaCache.get(cacheKey);
        if (hit && Date.now() - hit.at < opts.quotaTtlMs) return hit.value;

        if (!credentials) {
          const value = { plan: t.planFallback, error: t.noAccount, windows: [] };
          // 失败态只留 15 秒：下一次轮询正是重登之后该重试的时刻。
          quotaCache.set(cacheKey, { at: Date.now() - opts.quotaTtlMs + 15_000, value });
          return value;
        }

        try {
          let status = await fetchStatus(opts.codingPlanAPIURL, credentials.access, {
            clientVersion: await clientVersionNow(),
          });
          // 签到语义：套餐缺失/到期 → 自动重领一次，成功后重取状态再映射。
          if (await ensurePlan(credentials, { status })) {
            status = await fetchStatus(opts.codingPlanAPIURL, credentials.access, {
              clientVersion: await clientVersionNow(),
            });
          }
          const value = quotaFromStatus(status, t, { user });
          quotaCache.set(cacheKey, { at: Date.now(), value });
          return value;
        } catch (error) {
          const expired = error.signIn === "expired";
          const value = {
            plan: t.planFallback,
            ...(user ? { user } : {}),
            error: expired
              ? t.reloginRequired
              : error.status
                ? fill(t.usageHttp, { status: error.status })
                : fill(t.readFailed, { detail: error.message }),
            windows: [],
          };
          quotaCache.set(cacheKey, { at: Date.now() - opts.quotaTtlMs + 15_000, value });
          log("warn", `${PROVIDER}: usage: ${error.message}`);
          return value;
        }
      },

      /**
       * 签到 —— magpie 原生 checkin 设置开关调度的钩子（社区 raccoon/
       * autoclaw 插件同款）：AtomCode 的对应端点就是 claim-v2 领取。
       *
       *   - 这次真的领到了（fresh claim）→ claimed（带套餐名与档位）；
       *   - 本来就持有对应/更高档（duplicate）→ done（仍有效，无新领取）；
       *   - 上游拒绝（日限额已满等）→ failed，把上游 message 带回去。
       */
      async checkin(getAuth) {
        const credentials = credentialsOf(await readAuth(getAuth));
        if (!credentials?.access) {
          return { outcome: "failed", message: t.noAccount };
        }
        // 状态先看一眼：套餐仍在有效期内就不打扰领取接口（claim-v2 幂等，
        // 但一次元数据请求换一个确定的 done 比一次网络往返更稳）。
        try {
          const status = await fetchStatus(opts.codingPlanAPIURL, credentials.access, {
            clientVersion: await clientVersionNow(),
          });
          if (!planNeedsClaim(status)) {
            const plan = status?.codingplan_free ?? status?.plan ?? {};
            return { outcome: "done", message: fill(t.checkinDone, {}) + (plan.plan_name ? `（${plan.plan_name}）` : "") };
          }
        } catch (error) {
          if (error.signIn === "expired") return { outcome: "failed", message: t.reloginRequired };
          // 状态读不到（网络抖动）不放弃：直接尝试领取，由领取结果说话。
        }
        try {
          const claim = await claimCodingPlan(opts.codingPlanAPIURL, credentials.access, {
            clientVersion: await clientVersionNow(),
          });
          if (!claim.claimed) {
            return { outcome: "failed", message: claim.message || fill(t.reclaimFailed, { detail: "no tier" }) };
          }
          if (claim.duplicate) {
            return { outcome: "done", message: fill(t.checkinDone, {}) + (claim.planName ? `（${claim.planName}）` : "") };
          }
          return {
            outcome: "claimed",
            message: claim.planName || claim.tier || undefined,
          };
        } catch (error) {
          return { outcome: "failed", message: fill(t.reclaimFailed, { detail: error.message }) };
        }
      },

      /**
       * Token renewal before expiry — Magpie's own hook (OpenCode ignores it).
       */
      refreshLead: 5 * 60 * 1000,
      async refresh(auth) {
        const credentials = credentialsOf(auth);
        if (!credentials?.access) throw markExpired();
        const next = await refreshAccount(credentials);
        return {
          access: next.access,
          refresh: next.refresh,
          expires: next.expires,
        };
      },
    },
  };
}
