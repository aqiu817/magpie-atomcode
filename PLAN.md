# magpie-atomcode 插件制作规划

- 版本：v1.5（2026-10-16）
- 状态：**已发布 GitHub（M5 路线 A 部分完成）**——仓库 https://github.com/aqiu817/magpie-atomcode ，main 分支，topic `magpie-plugin`（另附 atomcode/atomgit/codingplan/opencode）；README 默认英文（中文移至 README.zh-CN.md）；显示名 ATOMCODE；27/27 单测、真机 checkin=true。剩余可选：npm 发布与 registry.json PR、深度单测补全
- 目标产物：magpie 供应商插件 `magpie-atomcode` —— 让所有 Agent 通过 magpie 使用 AtomCode（AtomGit CodingPlan）的模型，写作 `atomcode/<模型>`

---

## 0. 摘要（先读这一段）

**做什么。** 制作一个 magpie 供应商插件：用户在 magpie 里用浏览器登录 AtomGit 账号，插件把 AtomCode CodingPlan 的模型（当前为 `qwen3.8-27b`、`glm5.3-flash`）作为 magpie 供应商 `atomcode` 提供出来；Claude Code、Codex、OpenCode 等任何 Agent 都能选 `atomcode/<模型>` 使用，额度（5 小时窗口）显示在 magpie 的账号行与 `magpie quota` 里。

**怎么做。** 插件**直连 AtomGit**（不依赖单独运行 Atom2Api）：

1. 登录：AtomGit OAuth broker（`acs.atomgit.com`），token 存在 magpie 的 `plugin-auth.json`，由 `auth.refresh` 自动续期；
2. 请求：magpie 网关把任意 Agent 的请求转成 Chat Completions，插件的 `fetch` 给每个请求补上 `atomcode-signing-v1` 签名头后转发到 `llm-api.atomgit.com/v1`，响应（含 SSE 流）原样流回；
3. 模型与额度：`api.gitcode.com` 的 CodingPlan 接口读计划类型、模型目录与窗口用量，映射到 magpie 的模型列表和 quota windows。

**为什么这条路线（而不是包装 Atom2Api）。** Atom2Api（MIT）与社区笔记已经证明协议可行，但它是给"任意 OpenAI 兼容客户端"用的独立服务；对 magpie 来说，插件直连少一个常驻服务、登录与额度都是一等公民（magpie 账号模型、`auth.usage` 原生呈现），且用户的其它插件（sensenova、kilo-gateway）都是同样的"直连厂商"形态。Atom2Api 在本规划中的角色是**协议参考与逃生口**（其 `signer_url` 思路对应本插件 `masterKeyHex`/`clientVersion` 选项）。

**关键验证结论（2026-10-16 在本机用真实账号实测，非推测）：**

| 验证项 | 结果 |
|---|---|
| 纯 Node（node:crypto）实现 `atomcode-signing-v1` | ✅ 与 Atom2Api 的独立测试向量逐字节一致 |
| 真实网关 `POST /v1/chat/completions`（签名 + UA） | ✅ 200，"pong" 正常返回，usage 正常 |
| 流式 SSE + `stream_options.include_usage` | ✅ text/event-stream、12 个事件、`[DONE]`、usage 含 `reasoning_tokens` |
| `reasoning_effort: "xhigh"` | ✅ 200，返回 `reasoning_content` |
| CodingPlan `status-v2` / `models-v2`（真实账号） | ✅ 计划、窗口额度、模型目录全部可用（见 §5.4） |

本次验证共发起 **3 次真实推理调用**（占该账号 5 小时窗口 200 次额度的 1.5%），无任何写入类操作。

**待确认问题 3 个已按默认决策定稿**（见 §11），不影响开工 M0/M1。

---

## 1. 目标与范围

### 1.1 目标
- 一个插件包（本地文件夹起步，可发布），在 magpie 里表现为供应商 `AtomCode`；
- 浏览器 OAuth 登录（多账号可重复登录），token 自动续期，失效时明确提示重新登录；
- Agent 可通过 magpie 使用 CodingPlan 模型：流式、工具调用、推理档位（reasoning_effort）与普通对话一致可用；
- 账号行与 `magpie quota` 显示计划名、到期时间、5 小时窗口用量（调用次数口径）；
- 与既有插件模板（`magpie-sensenova`、`magpie-kilo-gateway`）同一套工程约定：单函数入口、模块拆分、`node --test` 单测、NOTICE 署名、内联 data URI 图标。

### 1.2 非目标（本期明确不做）
- **不做 Atom2Api 的包装/管理**：不管理 Atom2Api 实例、不代替其多账号路由（那是 magpie 路由组的职责）。已有 Atom2Api 的用户继续用 magpie 的"自定义供应商"即可。
- ~~不做 CodingPlan 的自动 claim（claim-v2）~~（2026-10-16 用户改口，决策 ⑥）：登录成功后按 Max→Pro→Lite 幂等领取 —— `claim-v2`，重复领取上游返回 duplicate 无副作用，失败只记日志不拦登录；`autoClaim: false` 关闭。模型目录仍为空时给出提示（log warn）。
- 不做 `usage`（60 天历史）、embeddings、Responses 原生通道的特殊适配（Chat Completions 一条通道打满）。
- 不做 auth.toml 复用登录（P1 备选，见 §5.5）。
- 不做 CLI、不做后台服务：插件只在 magpie 插件宿主内运行。

---

## 2. 资料与事实基线（全部带出处）

| 来源 | 用途 | 关键结论 |
|---|---|---|
| [Atom2Api](https://github.com/cnluminous/Atom2Api)（MIT，cnluminous） | 协议参考主体 | OAuth 流程、签名算法与 master key 默认值、CodingPlan REST、字段结构、UA 要求、`signer_url` 逃生口。本地副本见 `.research/atom2api-*.go`；2026-10-16 晚在线核对：HEAD 仍为 2ba2299（2026-08-17），其后无提交，README.zh-CN.md 与快照逐字一致，open issue 无协议报障 |
| [magpie 插件开发指南](https://usemagpie.ai/docs/zh/plugins) | 插件规范 | hooks 体系、登录/额度/账号规则、包结构、测试与发布、供应商 id 规则。本地副本 `.research/magpie_plugins.txt`；2026-10-16 晚在线重比：现网页面与本地快照全文一致（14 个哨兵点 SAME） |
| [magpie 快速上手](https://usemagpie.ai/docs/zh/start) | 集成背景 | AtomCode 已是 magpie 内置的 **Agent 目标**（magpie 会往 `~/.atomcode/config.toml` 写供应商账户）；"自定义 URL" 供应商的存在说明本插件的差异化在登录与额度。本地副本 `.research/magpie_start.txt` |
| [atomgit-opencode-bridge](https://github.com/zhuguang-ZFG/atomgit-opencode-bridge)（**无许可证**） | 补充事实 | `403 ATOMCODE_UA_REQUIRED`、UA 必须 `atomcode/<版本>`、reasoning 注入细节、auth.toml 结构。**仅参考事实，不复制其代码** |
| AtomCode 官方仓库（MIT） | 版本锚点 | 当前版本 **5.2.3**（`Cargo.toml` workspace.package.version，与 README badge 一致） |
| 本机环境实测 | 落地约束 | magpie 0.1.1267；CLI `C:\Users\Robin\Downloads\magpie-windows-amd64.exe`（`magpie.cmd` 包装）；Node v24.13.0 / Bun 1.3.6 / Git 2.47；无 docker（不需要）；`~/.atomcode/auth.toml` 已有可用登录 |
| 既有插件模板 | 工程约定 | `C:\Users\Robin\Documents\1111\magpie-sensenova`（provider+quota 范式）、`magpie-kilo-gateway`（catalog+fallback 范式） |

### 2.1 需要特别记住的既有事实
- 本机 `providers.json` / `plugin-providers.json` 中**没有** `atomcode` 供应商 id（现有：sensenova、kilo、qoder、zcode、workbuddy、opencode-zen-free 等）；
- magpie 的 `applied.json` 里有 `atomcode` 是 **Agent 配置**命名（写 `~/.atomcode/config.toml`），与供应商 id 不冲突；若真被占用，magpie 会自动把插件供应商显示为 `atomcode-plugin`（曾在 `kilo` 上实际发生过），插件代码无需改造；若两个插件同时持有同一 id，只有被选中的那个生效——用 `magpie plugin use <名字> <id>` 或应用里「用于 …」按钮改选（官方指南规则）；
- magpie 插件沙箱在 Windows 上可用：`HOME` + `USERPROFILE` + `XDG_CONFIG_HOME` 三件套指向临时目录即可完全隔离（已实测：沙箱内看不到真实插件，真实 `plugins.json` 哈希不变）。

---

## 3. 架构设计

### 3.1 请求链路

```
Agent (Claude Code / Codex / OpenCode / …)
   │ 任意 API（chat / responses / anthropic / gemini）
   ▼
magpie 网关（本地 127.0.0.1:3425，负责协议转换、流式、故障转移、计量）
   │ OpenAI Chat Completions（本插件 npm = @ai-sdk/openai-compatible）
   ▼
magpie 插件宿主（Bun）→ magpie-atomcode
   │ loader.fetch：补签名头（atomcode-signing-v1）+ UA + Bearer
   ▼
https://llm-api.atomgit.com/v1/chat/completions（SSE 原样流回）
```

旁路（不经过 LLM 网关）：
- 登录：`acs.atomgit.com` OAuth broker；
- 模型/计划/额度：`api.gitcode.com/api/v5/coding-plan/*`。

### 3.2 登录与令牌生命周期

```
plugin login atomcode（或应用里点登录）
  → authorize(): GET {acs}/auth/login?provider=atomgit → {login_url, state}
  → magpie 打开 login_url；用户在浏览器完成 AtomGit 登录
  → callback(): 每 ~2.5s GET {acs}/auth/check?state=… → 直到 {valid:true}
  → GET {acs}/auth/token?state=… → {access_token, refresh_token, expires_in≈7d, user}
  → 保存（magpie 写入 plugin-auth.json）：{type:"oauth", access, refresh, expires, accountId…}
后续：
  → auth.refresh（magpie ≥0.1.684 原生调度，默认提前 5 分钟）POST {acs}/oauth/refresh
  → 刷新失败且判定为凭证失效 → 抛 {signIn:"expired"} → magpie 标记账号需重新登录
请求中兜底：
  → fetch 内单飞刷新（同一时刻只刷一次）；OpenCode 宿主下没有 auth.refresh，靠它工作
```

### 3.3 数据流：模型与额度
- `provider.models`（每账号一次）：先 `status-v2` 取 plan_type → `models-v2?plan_type=` 取目录 → 归一化成 magpie 模型对象；失败时返回声明时列表并打 `fellBack` 标记（供应商不消失）。
- `auth.usage`（显示在账号行 / `magpie quota`）：`status-v2` 的 `current_usage` + `rate_limit_windows` → magpie windows；缓存 60s（对齐 sensenova 的 `quotaTtlMs`），报错不缓存满 TTL。

---

## 4. magpie 插件规范映射（hooks 设计）

包结构按 magpie 指南的顺序被加载：`package.json` `exports["./server"]` → `main` → `exports["."]`，其次 `index.ts/js/mjs`。本插件用 `main: ./index.mjs`。

| 钩子 | 设计要点 |
|---|---|
| `config` | `cfg.provider["atomcode"] ??= {name:"AtomCode", npm:"@ai-sdk/openai-compatible", api:"https://llm-api.atomgit.com/v1", models: 快照}`；先铺默认再用 `...was` 覆盖用户在配置里的修改（对齐 sensenova/kilo 写法） |
| `auth.provider` | `"atomcode"` |
| `auth.icon` | 内联 data URI（`assets/` 内自包含，离线可显示；候选素材：`atomgit.com/favicon.ico` 已下载 9.6KB 真实 ICO，M0 决定转换/自绘） |
| `auth.methods` | 单方法 `{type:"oauth", label:"AtomGit 登录（浏览器）", authorize, }`，无 prompts；`authorize` 返回 `{url, instructions, method:"auto", callback}`；`callback` 轮询 `check`→`token`，超时 ~9 分钟返回 `{type:"failed", error:"登录超时，请重试"}`；成功返回 `{type:"success", refresh, access, expires: Date.now()+expires_in*1000, accountId: email??username??user.id, email, name}`（`accountId` 用作账号显示名与重登替换依据，指南示例即此用法） |
| `auth.loader` | 返回 `{baseURL, fetch}`：`fetch` 每次请求重新 `getAuth()` 取 token（中途重登无需等 loader 重跑），先确保未过期（单飞刷新兜底），再补 `authorization`、`user-agent: atomcode/<版本>`、`X-AtomCode-*` 五头；**不改写请求体、不缓冲响应、不手动设置 Accept-Encoding/content-length**，并行与 SSE 原样透传 |
| `auth.usage` | 见 §5.4 映射；`plan`/`until`/`user` + windows；错误信息走 `error` 字段 |
| `auth.refresh` | `refreshLead: 5*60*1000`；调 `POST {acs}/oauth/refresh`；`invalid_grant`/400/401/403 → 抛 `signIn:"expired"`；返回 `{access, refresh: 新??旧, expires}`（magpie 合并保存） |
| `provider.models` | 见 §3.3；每账号作用域；失败 → `fellBack(declared)`，`signIn:"expired"` 错误单独抛出以标记账号 |
| `chat.headers` | 不需要（会话保持由网关/厂商缓存决定；留观察项，不预设） |
| `package.json` `magpie` 字段 | `"icon"`、`"maxConcurrency": 4`（上游有并发/调用窗口限制，先与文档示例一致的 4，用户可在供应商处覆盖） |

### 4.1 请求体策略（KISS，能不动就不动）
- 默认**纯透传**。仅在 M3 实测发现下列之一时再引入 `wire.mjs` 修补（修补后重新签名，签名永远对最终字节负责）：
  1. 流式响应缺 `usage` 且影响 magpie 计量 → 补 `stream_options.include_usage`（上游已验证接受）；
  2. 推理档位在 openai-compatible 通道下未被网关正确传递 → 补 `reasoning_effort`（上游已验证接受；社区笔记提示个别模型还需 `thinking:{type:"enabled"}`，实测 qwen3.8-27b 不需要）。

### 4.2 失败语义
| 上游 | 插件行为 |
|---|---|
| 401 / 403（凭证问题） | 透传响应体（Agent 会显示原文）；依据实测决定是否补 `X-Magpie-Sign-In: expired`（magpie 默认 401 已标记；403 需实测确认语义，M3 项） |
| 429 / 5xx | 原样透传 → magpie 按路由规则故障转移；`Retry-After` 等头不吞 |
| 网络层异常（DNS/连接失败） | 抛出异常让请求失败（不伪造响应），错误信息中带可读原因 |
| 刷新时 `invalid_grant` | `signIn:"expired"` 标记，提示重新登录 |

### 4.3 插件选项（`plugins.json` 的 options，但都带默认值）
```
locale: "zh" | "en"            # i18n，默认 zh
autoVersion: true              # 自动跟随 AtomCode 官方仓库版本（决策 ⑤）
clientVersion: "5.2.3"         # 兜底版本号：autoVersion 拉取失败或关闭时用
autoClaim: true                # 登录成功后幂等领取 CodingPlan（决策 ⑥）
masterKeyHex: "<32B hex>"       # 逃生口：上游换密钥时热更新（对齐 Atom2Api 的 signer_url 思路）
platformBaseURL                 # 默认 https://acs.atomgit.com（测试/镜像用）
codingPlanAPIURL                # 默认 https://api.gitcode.com/api/v5（测试/镜像用）
quotaTtlMs: 60000               # 额度缓存
maxOutputTokens: 32768          # 模型 output limit 默认值
```

---

## 5. 协议细节（实现依据；均已实测或来自 MIT 源码）

### 5.1 OAuth broker（`https://acs.atomgit.com`）
| 步骤 | 请求 | 响应 |
|---|---|---|
| 启动 | `GET /auth/login?provider=atomgit` | `{login_url, state}`（`login_url` 需去掉 force-login 参数，Atom2Api `stripForceLogin` 做法） |
| 轮询 | `GET /auth/check?state=…` | `{valid: bool}` |
| 换令牌 | `GET /auth/token?state=…` | `{access_token, refresh_token, token_type, expires_in, user:{id, username, name, email, avatar_url}}` |
| 刷新 | `POST /oauth/refresh` body `{"refresh_token"}` | 同上字段（`refresh_token` 可能轮换，缺省沿用旧值） |

注意：会话有效期 10 分钟（Atom2Api `pending` 判定）；换令牌要求 `access_token` 与 `user.id` 非空。UA 统一带 `atomcode/<版本>`。

### 5.2 `atomcode-signing-v1`（纯函数，可单测）
```
time_bucket = floor(ts / 3600)
salt        = user_id || 0x01 || le64(time_bucket) || sha256(oauth_token) || sha256(client_version)
signing_key = HKDF-SHA256(master_key, salt, "atomcode-signing-v1" || 0x01, 32B)
canonical   = "v1\n" + METHOD + "\n" + PATH + "\n" + ts + "\n" + nonce_hex(16B) + "\n" + sha256(body)_hex
sig         = HMAC-SHA256(signing_key, canonical) → "v1:" + hex
headers     = X-AtomCode-Sig / -Ts / -Nonce / -Alg:"1" / -Ver:<client_version>
```
- master key 默认值（Atom2Api 内置，社区两份独立实现互相印证）：
  `e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123`
- `PATH` 是完整请求路径（如 `/v1/chat/completions`，含 `/v1` 前缀）；
- **签名必须对最终发送的字节签名**：若未来加了 body 修补，顺序是"先修补、后签名"。
- 单测用 Atom2Api 的独立测试向量（`core_test.go:435`）：
  `POST /v1/chat/completions`，body `{"model":"deepseek-v4-flash"}`，token `token-fixture`，user `user-fixture`，ver `5.0.2`，ts `1767225600`，nonce `00..0f`
  ⇒ `X-AtomCode-Sig = v1:c5bafa716c0fdc31a6e2738412d0b21a9d9e9d1ca09cc44eb17949a1b4fa4bdd`

### 5.3 LLM 网关（`https://llm-api.atomgit.com/v1`）
- 请求头（缺 UA 会 403 `ATOMCODE_UA_REQUIRED`）：
  `Authorization: Bearer <access>` + `User-Agent: atomcode/<版本>` + `Content-Type: application/json` + 五个 `X-AtomCode-*`；
- 实测（2026-10-16，账号真实调用）：
  - 非流式：200，`choices[0].message.content` 正常，`usage:{prompt_tokens, completion_tokens, total_tokens}`；
  - 流式：`text/event-stream`，`data:` 事件 + `[DONE]`；`delta.reasoning_content` 存在；`stream_options.include_usage` 生效，末包 usage 含 `completion_tokens_details.reasoning_tokens`；
  - `reasoning_effort:"xhigh"` 被接受，message 含 `reasoning_content` 与 `provider_specific_fields`。
- 响应头/正文**不改写**（magpie 逐块流式透传；改写流式正文时必须去掉 content-length/content-encoding —— 本插件不碰，规避）。

### 5.4 CodingPlan REST（`https://api.gitcode.com/api/v5`）
`status-v2` 实测响应（脱敏，2026-10-16 本机账号）：
```json
{
  "codingplan_free": {"plan_name":"CodingPlan Lite-体验版","plan_type":"Lite-beta","status":1,
    "claimed_at":"2026-10-13","expires_at":"2026-10-20","remaining_days":4,"total_days":7},
  "current_usage": {"placeholder":false,"window_token_limit":200,"window_tokens_used":0,
    "usage_percent":0,"window_hours":5,"reset_at":"2026-10-16T18:00:01","seconds_until_reset":4190},
  "rate_limit_windows":[{"window_size_seconds":18000,"window_hours":5,"call_limit":200,"calls_used":0,
    "usage_percent":0,"quota_exhausted":false,"seconds_until_reset":4190}],
  "window_quota_exhausted": false
}
```
`models-v2?plan_type=<Lite|Pro|Max>` 实测目录（该账号三个 tier 返回相同两项）：
```json
{"display_model_name":"qwen3.8-27b","base_url":"https://llm-api.atomgit.com/v1",
 "context_window":262144,"supports_vision":true,"type":"openai","plan_available":true,
 "reasoning_effort_levels":["low","medium","xhigh"],"is_atomcode_exclusive":1}
{"display_model_name":"glm5.3-flash","base_url":"https://llm-api.atomgit.com/v1",
 "context_window":512000,"supports_vision":true,"type":"openai","plan_available":true,
 "reasoning_effort_levels":["low","high"],"is_atomcode_exclusive":1}
```
→ magpie 模型映射：
- key = `display_model_name`（若含 `/` 等则 sanitize，`api.id` 保持原样）；
- `limit: {context: context_window, output: maxOutputTokens(32768 默认)}`；
- `reasoning: levels.length>0`；`variants`: `Object.fromEntries(levels.map(l=>[l,{}]))`（推理档位直接对齐）；
- `capabilities`: `supports_vision → modalities.input 含 "image"`；`tool_call: true`（M3 用真实工具调用复核）；
- 过滤 `plan_available === false`；`status:"deprecated"` 不使用；
- 计划 tier 由 `plan_name` 判（含 max/pro → 对应档，其余 Lite；"Lite-beta" → Lite，与 Atom2Api `planTier` 一致）。

**usage windows 映射**（magpie `auth.usage`）：
```js
{
  plan: plan_name,                       // "CodingPlan Lite-体验版"
  user: username ?? name ?? email,
  until: expires_at,
  windows: [{
    name: "5 小时额度",                    // i18n
    used: usage_percent,                  // 调用口径百分比
    resetSecs: seconds_until_reset,       // 或 resetsAt: reset_at
    span: window_hours * 3600,            // 18000
    display: `${calls_used} / ${call_limit} 次`,
    amount: calls_used, limit: call_limit, unit: "calls",
  }]
}
```
（`window_token_limit` 等 token 口径字段一并读取，若上游语义变化可在窗口 `model`/`display` 上调整；`quota_exhausted` 时 `used` 自然 >100，magpie 原生支持。）

### 5.5 （P1 备选）复用 AtomCode CLI 登录
`~/.atomcode/auth.toml` 结构（本机实测）：`access_token / refresh_token / expires_in(604800) / created_at` + `[user] id/username/name/email/avatar_url`。
- 设计（若做）：作为第二个登录方式"使用本机 AtomCode 登录"；**auth.toml 为唯一事实源**，插件每次读取、接近过期时刷新并原子写回（600 权限），不把 refresh token 另存，避免与 CLI 的刷新轮换互相作废；
- 风险：CLI 与插件同时刷新可能一方失效（需重登），以及写用户文件的边界——故降为 P1，默认不做。

---

## 6. 文件结构与模块草案

```
magpie-atomcode/
├─ package.json            # name magpie-atomcode；type module；main index.mjs；files[]；repository 预留（M5 发布时填）；
│                          # keywords: magpie / magpie-plugin / opencode / opencode-auth / opencode-plugin / atomcode / atomgit；
│                          # （npm 搜索口径「<关键词> opencode」：keywords 需含 opencode 且含 auth/plugin/provider 之一）
│                          # scripts.test: node --test test/*.test.mjs；magpie:{icon, maxConcurrency:4}
├─ index.mjs               # 唯一导出：export async function AtomCodePlugin({client}, options) → hooks
│                          # 导出纪律：入口除插件函数本身外不得 export 任何函数/对象——入口的每个导出
│                          # 都会被当作插件调用（官方指南）；可测内部放独立模块或 export const _internal
├─ internal.mjs            # PROVIDER="atomcode"、ICON(data URI)、readAuth、normalizeOptions、fellBack、单飞刷新
├─ sign.mjs                # signAtomGitRequest(纯函数) + 常量 MASTER_KEY_HEX
├─ oauth.mjs               # broker start/check/token/refresh（fetch 参数化，可注入 mock）
├─ codingplan.mjs          # status-v2 / models-v2 客户端 + planTier + 归一化
├─ quota.mjs               # status → magpie usage windows 映射（纯函数）
├─ version.mjs             # 自动追版本（决策 ⑤）：raw.atomgit.com Cargo.toml → 校验/TTL 缓存/兜底，不阻塞请求
├─ models.mjs              # NPM / DEFAULT_BASE_URL / FALLBACK_MODELS（真实快照）/ sanitizeModelKey /
│                          # toConfigModel / toProviderModel / createCatalog（内存缓存 + TTL）
├─ i18n.mjs                # zh/en 文案（locale option）
├─ assets/atomcode.*       # 图标（内联 data URI，离线可显示）
├─ test/                   # sign / oauth / codingplan(含 claim) / models / quota / i18n / version .test.mjs
├─ README.md (+ README.en.md)
├─ NOTICE.md               # Atom2Api (MIT) 署名；bridge 仅参考事实（无许可证，未复制代码）
└─ LICENSE                 # MIT
```
`FALLBACK_MODELS` 初始快照（登录前可选项；来自本次实测）：
`qwen3.8-27b`（256K、vision、low/medium/xhigh）、`glm5.3-flash`（500K、vision、low/high）。

---

## 7. 里程碑与验收

| 阶段 | 产出 | 验收（命令/标准） |
|---|---|---|
| **M0 脚手架** | 目录、package.json、README/NOTICE 骨架、图标定稿 | `node --test`（空测试）通过；`node -e "import('./index.mjs')"` 可加载 |
| **M1 协议层 + 单测**（离线可完成） | sign.mjs / oauth.mjs / codingplan.mjs / quota.mjs + 全部单测 | ① 签名 fixture 向量一致；② broker/models/status 用 mock fetch 的映射断言全绿；③ 同款探针脚本对真机复跑 status-v2/models-v2 与规划数据一致 |
| **M2 插件接线 + 沙箱** | index.mjs 全 hooks、i18n、fallback 快照 | 沙箱（三件套隔离）`plugin add` 成功、`plugin --json` 列出 atomcode、`plugin login atomcode` 走通浏览器登录 |
| **M3 真机链路** | provider test + Agent 实测 | ① `provider test atomcode` ✓；② 沙箱 `quota` 显示 5 小时窗口；③ magpie 应用里一个 Agent 用 `atomcode/qwen3.8-27b` 完成含流式的对话；④ 工具调用、reasoning 档位、401/403 语义逐项复核（§4.2） |
| **M4 打磨** | README 完整、错误文案、i18n、NOTICE | 按 README 从零安装可走通；日志抽查无 token 泄露 |
| **M5 可选发布**（两条路线二选一） | A. 自建 npm → GitHub 仓库（主题 `magpie-plugin`，package.json 须在仓库根）→ 社区 `registry.json` 提 PR（字段：package / name / icon / providers / summary{en,zh}）；B. 社区包 `@magpie-community/opencode-atomcode-auth`（官方供应商包命名），放 magpie-community/plugins 的 `packages/atomcode`，推版本号即发布、所有 magpie 自动更新 | 按渠道各自验收；不影响本地使用 |

依赖：M1 独立；M2 依赖 M1；M3 依赖真实账号（本机已有）。M3 通过前不建议对外发布。

---

## 8. 测试计划

### 8.1 单元测试（主用 `node --test test/*.test.mjs`，与模板一致；`bun test` 为可选第二通道）
- `sign.test.mjs`：Atom2Api fixture 向量；nonce 长度校验；client_version/salt 变化时签名变化；body 为 Buffer/字符串两种情况。
- `oauth.test.mjs`：start/check/token/refresh 的请求形状与响应解析（mock fetch）；状态超时、非 JSON、字段缺失。
- `codingplan.test.mjs`：planTier 判定（Max/Pro/Lite/Lite-beta/陌生值）；models-v2 归一化（带斜杠 id、缺字段默认值、plan_available 过滤）；status-v2 → windows 映射（超 100%、缺 reset 字段）。
- `models.test.mjs`：sanitizeModelKey、toProviderModel（variants/vision/tool_call/limit）、fallback 标记（`Symbol.for("magpie.fellBack")`）。
- `i18n.test.mjs`：zh/en 文案键完整性。

测试文件写成两个 Runner 都能跑（纯 node:test 写法 bun test 亦可运行）；主用 node --test，`bun test` 作可选第二通道——官方建议单测用 bun test（插件宿主即 Bun），可测内部挂 `export const _internal = {…}` 或放独立模块。

### 8.2 沙箱冒烟（Git Bash，Windows 实测可行）
```bash
SB=$(mktemp -d)
MAGPIE="C:/Users/Robin/Downloads/magpie-windows-amd64.exe"
sb() { env HOME="$SB" USERPROFILE="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
       MAGPIE_ADDR=127.0.0.1:3499 "$MAGPIE" "$@"; }
sb plugin add "C:/Users/Robin/Documents/1111/magpie-atomcode"
sb plugin --json
sb plugin login atomcode
sb provider test atomcode
sb provider test atomcode qwen3.8-27b
sb quota
sb plugin logout atomcode
```
说明：`XDG_CACHE_HOME` 每次指向新沙箱会重新下载 Bun 插件宿主；想省时可把它指到真实缓存目录，其余仍隔离。如需与社区市场完全隔离，给 sb() 预置 `MAGPIE_PLUGIN_MARKET=off`（只用内置推荐副本）。

### 8.3 真机探测清单（M3，每项记录证据）
| 项 | 方法 | 期望 |
|---|---|---|
| 签名被网关接受 | provider test / 探针脚本 | 200 而非 403/签名错误 |
| 流式 + usage | 探针与 Agent 对话 | SSE 逐块、含 usage（若缺 → 触发 §4.1 修补决策） |
| 工具调用 | Agent 发一个工具/函数调用请求 | 上游返回 tool_calls 正常，网关转换无损 |
| reasoning 档位 | 选 xhigh/high 各跑一次 | 网关把档位映射为上游 `reasoning_effort`（或触发 §4.1 修补） |
| 凭证失效 | 手工把 token 改坏 | 账号被标记、Agent 收到明确错误、重登后恢复 |
| 刷新 | 构造 expires 临近 | `auth.refresh` 触发且新 token 持久化 |
| 额度窗口 | `quota`、账号行 | 与 status-v2 实测值一致（当前 0/200 次） |

### 8.4 （P1）离线 mock 回归
一个本地 mock（node 起 http server）模拟 acs/gitcode/gateway 三个域，端到端跑插件不耗额度；用于上游变动后的回归（字段基线见 §5.4）。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 / 降级 |
|---|---|---|
| 上游更换 master key 或 client 版本 | 全部请求 403 | `clientVersion` 默认自动跟随官方仓库版本（决策 ⑤，失败退回常量）；`masterKeyHex` 选项热修（对齐 Atom2Api `signer_url` 思路）；README 写清症状与改法 |
| 上游协议（OAuth/REST）变化 | 登录或额度失效 | 协议层模块化 + mock 回归；最坏降级：改用 Atom2Api 实例 + magpie"自定义供应商"（本规划的非目标路径恰是逃生口） |
| 账号封禁 / ToS 风险 | 账号不可用 | 非官方兼容实现的固有风险（Atom2Api 同款警示）；README 显著声明；只登录用户自己的账号，不绕额度 |
| token 泄露 | 安全问题 | 只在请求头携带，不落日志、不进错误消息；plugin-auth.json 由 magpie 管理（600） |
| refresh 竞态（P1 auth.toml 路线） | 一方凭证作废 | P1 专章设计（单写者纪律）；默认不做 |
| 模型 id 带斜杠 / 特殊字符 | Agent 引用困难 | key sanitize + `api.id` 保真（§5.4） |
| output limit 未知 | 截断或超限报错 | 默认 32768，M3 实测后按模型调；可选项覆盖 |
| magpie 版本差异 | `auth.refresh` 等新钩子 | 最低版本要求写进 README（≥0.1.684；本机 0.1.1267 ✓）；fetch 内兜底刷新保证旧版可用 |

---

## 10. 许可证与署名
- 移植 `atomcode-signing-v1` 的实现依据来自 **Atom2Api（MIT, © 2026 Atom2Api contributors）** → NOTICE.md 与 README 署名（保留版权声明即可）；
- **atomgit-opencode-bridge 无许可证** → 只采用其文档中的协议事实，不复制其代码；
- AtomCode 仓库为 MIT；插件本体建议同样 MIT（与既有插件一致）；
- README 需包含与 Atom2Api 同级别的免责声明（非官方、封号风险、谨慎使用）。

---

## 11. 决策定稿（原待确认问题已按默认决策生效；改口时改这里；不阻塞 M0/M1）
1. **登录方式**：V1 只做"浏览器 OAuth"够吗？还是要同时做"复用本机 AtomCode 登录（读 auth.toml）"（§5.5 的 P1 设计）？
2. **clientVersion 策略**：固定常量（默认 5.2.3，随发布更新）还是 P1 自动探测（拉 AtomCode 仓库 Cargo.toml 版本，对齐 Atom2Api 的 UA checker）？
3. **发布范围**：仅本地使用；还是发布 npm + GitHub（主题 `magpie-plugin`）+ 向 magpie-community `registry.json` 提 PR 进推荐列表？
4. **目标目录确认**：实现落在 `C:\Users\Robin\Documents\1111\magpie-atomcode`（与 sensenova/kilo 同级）——按此执行，如有异议随时可改。

**定稿（2026-10-16，按默认决策生效，改口时改这里）：**
1. **登录方式**：V1 只做浏览器 OAuth；复用本机 AtomCode 登录（读 auth.toml）降为 P1（§5.5）。
2. **clientVersion**：固定常量 5.2.3（随插件发布更新）；上游变更走 options 热修（masterKeyHex / clientVersion，§4.3、§9）。
3. **发布范围**：M0-M4 先本地使用；M5 可选发布（§7 两条路线）；package.json 预留 repository / keywords / files 完整字段。
4. **目标目录**：维持上述路径。

**基线在线核对（2026-10-16 晚）：** Atom2Api HEAD 仍为 2ba2299（2026-08-17；最新 10 条提交全为账号/路由/UI 类，签名 / OAuth / CodingPlan 协议层无变化），README.zh-CN.md 与本地快照逐字一致，3 个 open issue 均为账号风控/偶发 429 类、无协议报障；magpie 官方插件指南现网页面与本地快照全文一致（14 哨兵点 SAME）。协议层无需调整。

**补充定稿（2026-10-16 深夜，决策 ⑤⑥）：**
- **⑤ 自动追版本（默认开）**：官方客户端发新版会强制更新 → 网关大概率拒绝久远版本（版本轨迹 4.23.1 / 4.25.0 / 5.0.2 / 5.2.3 印证它一直在漂移；Atom2Api 单独写 UA checker 印证作者判断）。插件默认拉官方仓库 `Cargo.toml` 的 `workspace.package.version`（TTL 12h、失败 5min 后重试、退回 `clientVersion` 常量、唯一一次冷启动等待、其余绝不阻塞请求）；实现 `version.mjs`，UA / `X-AtomCode-Ver` / 签名盐同一取值。`autoVersion: false` 锁定常量。
- **⑥ 登录闭环补幂等领取（默认开）**：Atom2Api 在换完 token 后立即按 Max→Pro→Lite 领取 `claim-v2`（success/duplicate 即停；错误体解 message）。插件登录 callback 同款（失败只记日志不拦登录）；`autoClaim: false` 关闭。
- 验收快照（2026-10-16 深夜）：`node --test` 17/17 绿（version + codingplan/claim）；签名 fixture MATCH；插件在 magpie 0.1.1267 沙箱重新加载验收通过（provides `atomcode`、2 models、`maxConcurrency:4`、`usage:true`、无加载错误）。测试套件剩余：sign / oauth / models / quota / i18n / plugin hooks。

**M3 真机链路验收记录（2026-10-16 深夜，真实账号实测）**
| 项 | 结果 |
|---|---|
| 真实环境插件状态 | ✓ `plugin --json`：signedIn oauth、账号 anH9…@noreply.gitcode.com、2 模型、usage:true、无加载错误 |
| 签名被网关接受 | ✓ `provider test atomcode` → `✓ chat 1024 ms · qwen3.8-27b` |
| 额度窗口 | ✓ `quota` → `atomcode · CodingPlan Lite-体验版 · until Oct 21 · 5 小时额度 0% (0/200 次) ↻15m`；调用后 2% (4/200) 实时更新 |
| 流式对话（走网关） | ✓ SSE 逐块、reasoning_content 正常、`pong-stream` 完整返回（vllm 上游指纹可见） |
| 工具调用 | ✓ `finish_reason: tool_calls`、参数 `{"city":"Berlin"}` 正确、usage 含 reasoning_tokens |
| reasoning_effort=xhigh | ✓ reasoning 85 字符、答案 391 正确 |
| 401 语义 | ✓ 坏 token 直探上游 → `401 {"error":{"type":"auth_error"}}` 结构化错误体；magpie 默认标记账号（重登恢复） |
| 额度消耗 | 共 4 次真实调用（provider test 1 + 流式 1 + 工具 1 + xhigh 1），窗口 4/200 次 |

**v1.4 签到钩子（2026-10-16，社区移植）**
- 显示名定稿（用户指定）：供应商显示名 **ATOMCODE**（全大写，`config` 钩子的 `name` 字段），provider id 仍为小写 `atomcode`；magpie 签到开关的描述文案由显示名自动拼装。README zh/en 终稿已按 ATOMCODE 命名重写（含模型表、要求、签到、开发/沙箱章节），package.json description 同步。
- 社区调研结论：workbuddy 实际**没有**签到（其 signin 即 OAuth 登录）；真正的"每日签到"是 **magpie 原生 `auth.checkin` 钩子**，由商汤小浣熊 / AutoClaw 等积分制插件使用，契约 `{outcome: claimed|done|failed|inactive, credit?, streak?, message?}`，由 magpie 设置里的签到开关调度。MiniMax 明确"不做签到"。AtomCode 无每日打卡端点；其等价物即套餐领取 `claim-v2`（官方 `/login` 的签到语义）。
- 实现：`claimCodingPlan` 返回值加 `duplicate` 区分（fresh=claimed / duplicate=done）；`auth.checkin` 钩子四分支（有效→done 不打领取接口；过期→级联重领；failed 透出上游 message 如"全平台日限额已满"）；与额度/目录读取时的自动重领（决策⑥，30 分钟冷却）互不冲突。i18n 加 `checkinDone`。
- 验证：`npm test` **27/27 绿**（新增 checkin 六用例 + planNeedsClaim 四用例 + duplicate 断言；stub 全局 fetch 按 URL 分流——教训：插件的 CodingPlan 调用不含 fetchImpl 注入入口，测试须 stub 全局 fetch，同 sensenova 模板）；magpie 0.1.1267 沙箱重载 ✓；**真机 `plugin --json` 显示 `checkin=true`**（原生钩子被识别）。

---

## 附录 A：本次实测证据（2026-10-16）
- 探针脚本（可直接复跑）：
  - `.research/probe/atomcode-probe.mjs` —— 签名 fixture 自检 + 一次真实非流式对话（输出：`fixture sig match: YES`、`chat status: 200`）；
  - `.research/probe/atomcode-probe2.mjs` —— 流式 + `include_usage` + `reasoning_effort=xhigh`（输出：12 事件 + `[DONE]` + usage/reasoning_tokens + reasoning_content）。
- 资料快照：`.research/atom2api-*.go`、`.research/magpie_plugins.txt`、`.research/magpie_start.txt`、`.research/bridge/atomcode-integration-notes.md`、`.research/atomcode-README.md`、`.research/atomgit-favicon.ico`。
- 复跑方式（会消耗真实额度，谨慎）：`node .research/probe/atomcode-probe.mjs`（1 次调用）。

## 附录 B：参考资料索引
- Atom2Api：https://github.com/cnluminous/Atom2Api （MIT）
- magpie 插件开发指南：https://usemagpie.ai/docs/zh/plugins
- magpie 快速上手：https://usemagpie.ai/docs/zh/start
- atomgit-opencode-bridge：https://github.com/zhuguang-ZFG/atomgit-opencode-bridge （无许可证，仅参考）
- AtomCode 仓库：https://atomgit.com/atomgit_atomcode/atomcode （MIT，版本 5.2.3）
- magpie-community 插件清单：https://github.com/magpie-community/plugins （`registry.json`）
