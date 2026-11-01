# magpie-atomcode

简体中文 | [English](README.md)

把 **ATOMCODE（AtomGit CodingPlan）** 接入 [magpie](https://usemagpie.ai) 的供应商插件（非官方）。

浏览器登录 AtomGit 账号后，CodingPlan 的模型会以供应商 **ATOMCODE** 出现在 magpie 里；Claude Code、Codex、OpenCode 等任何 Agent 都能选 `atomcode/<模型>` 使用。套餐信息、每日签到与 5 小时滚动额度，都显示在 magpie 的账号行、`magpie quota` 和设置里。

```
Agent (Claude Code / Codex / OpenCode / …)
   │ 任意 API
   ▼
magpie 网关 ──► magpie-atomcode（补 atomcode-signing-v1 签名 + UA）
   ▼
https://llm-api.atomgit.com/v1（OpenAI 兼容，SSE 原样流回）
```

## 功能

- **浏览器 OAuth 登录**：一次授权完成登录，并在后台启动官方 `/login` 同款套餐申领；多账号可重复登录，token 由 magpie 保管并自动续期（magpie ≥ 0.1.684；旧版在请求时兜底刷新）。
- **直连 AtomGit**：不需要 Atom2Api 常驻；流式、工具调用、推理档位（`reasoning_effort`）全部可用（M3 真机逐项验证）。
- **每日签到（checkin）**：magpie 原生签到开关调度。套餐有效 → done；到期/缺失 → 按官方 Max→Pro→Lite 级联自动重领；名额满 → failed 并显示上游原因。
- **额度窗口**：账号行与 `magpie quota` 显示套餐名、到期时间、5 小时窗口（调用次数口径），实时更新。
- **自动追版本**：默认跟随 AtomCode 官方仓库的最新版本号（官方客户端会强制更新），拉取失败退回内置版本，绝不阻塞请求。
- **模型目录动态拉取**：每个账号自己的目录（随套餐/档位而变），离线时用内置快照兜底。

## 当前模型（2026-10-16 实测快照）

| 模型 | 上下文 | 推理档位 | 视觉 |
|---|---|---|---|
| `qwen3.8-27b` | 256K | low / medium / xhigh | ✓ |
| `glm5.3-flash` | 500K | low / high | ✓ |

目录随账号与套餐动态变化，以登录后拉取的为准。

## 安装

```bash
# 文件夹方式（就地加载）
magpie plugin add C:\path\to\magpie-atomcode
# npm 方式（发布后）
magpie plugin add magpie-atomcode
```

应用（GUI）里在「插件 → 添加插件」填入本目录路径。

## 登录与签到

```bash
magpie plugin login atomcode   # 浏览器完成 AtomGit 授权，自动回到终端
```

- 签到：magpie 设置 → 插件里的签到开关（「每天让 ATOMCODE 插件给每个已登录的账号签到一次」）。即使不开，套餐到期后额度/目录读取时也会自动补领（30 分钟冷却）。
- 套餐名额：Lite 限量 1000 人/日；Pro 体验版每日 10:00 放 100 个名额。抢满时签到会失败并显示原因，明天再试即可。

## 选项（`plugins.json` 的 options；都有默认值）

| 选项 | 默认 | 说明 |
|---|---|---|
| `locale` | auto（跟机器） | `zh` / `en` |
| `autoVersion` | `true` | 自动跟随 AtomCode 官方仓库的最新版本号 |
| `clientVersion` | `5.2.3` | 兜底版本号（`autoVersion` 拉取失败或关闭时用） |
| `autoClaim` | `true` | 登录后幂等领取 + 到期自动重领（关闭后只剩手动签到） |
| `masterKeyHex` | 内置 | 上游更换签名密钥时的热修逃生口（64 位 hex） |
| `platformBaseURL` | `https://acs.atomgit.com` | OAuth broker 地址 |
| `codingPlanAPIURL` | `https://api.gitcode.com/api/v5` | CodingPlan REST 地址 |
| `quotaTtlMs` | `60000` | 额度缓存时长 |
| `maxOutputTokens` | `32768` | 模型 output 上限兜底 |

## 安全边界

下面这些都在代码里强制，`npm test` 逐一覆盖：

- **只有官方网关是目的地。** `loader.fetch` 会把请求的 origin 与 `https://llm-api.atomgit.com` 比对，不一致就直接报错拒绝——**在**加任何凭证与签名头**之前**。`origin` 含协议，所以 `http://` 明文降级同样被拒。
- **上游改不动目的地。** 模型行里的 `base_url` 只有 origin 与签名网关完全一致时才被采纳，否则该模型回退官方网关并记录日志。
- **端点选项走白名单。** `platformBaseURL`、`codingPlanAPIURL` 必须是 `atomgit.com` / `gitcode.com` 下的 https 地址，否则回退官方端点并告警。被塞改的 `plugins.json` 因此无法把你的 bearer / refresh token 引到别处。
- **读取有上限、跳转被拒绝。** 版本、OAuth、CodingPlan 的响应体都在流式读取时限制为 1 MiB；所有元数据请求都有超时且拒绝跳转。broker 返回的登录地址也必须位于 AtomGit。

凭证存在 magpie 自己的 `plugin-auth.json` 里：本插件不写、不打印、不进日志，只会发往上面那两组官方域名。

### 装完就在跑的默认行为

两个默认开关都是开的，且都会在没被要求的情况下动手：

| 默认 | 实际动作 | 关闭方式 |
|---|---|---|
| `autoClaim: true` | 登录后在后台启动 CodingPlan `claim-v2`；套餐到期时再执行幂等重领 | `magpie plugin options atomcode '{"autoClaim":false}'` |
| `autoVersion: true` | 后台刷新 `raw.atomgit.com` 的版本清单（缓存 12 小时）。请求立即使用当前缓存版本，拿不到时使用内置兜底 | `magpie plugin options atomcode '{"autoVersion":false}'` |

## 排障

登录或 `provider test` 遇到 401 时：

1. 运行 `magpie version`，确认失败阶段是 OAuth 回调、模型目录、额度还是真实对话请求。
2. 用同一账号运行官方 AtomCode 客户端的 `atomcode login`。若官方客户端也返回 401，更可能是上游账号风控，而不是插件。
3. 提交 Bug 时附上脱敏日志。不要提供 access token、refresh token、OAuth state、`plugin-auth.json`、邮箱、账号 ID 或未脱敏的用户目录。

安全问题请按 [SECURITY.md](SECURITY.md) 私密报告；开发与审查约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

```bash
npm test                    # node --test，85 用例
npm run test:coverage       # Node 内置覆盖率报告
npm run pack:check          # 检查 npm 发布包内容
```

CI 会在 Node 20、22、24 与 Bun 上运行测试，执行覆盖率门禁，并对 npm 包做导入和打包冒烟。

沙箱验证（不碰真实配置）：

```bash
SB=$(mktemp -d)
PLUGIN_ROOT="$(pwd)"
sb() { env HOME="$SB" USERPROFILE="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
  MAGPIE_ADDR=127.0.0.1:3499 MAGPIE_PLUGIN_MARKET=off magpie "$@"; }
sb plugin add "$PLUGIN_ROOT"
sb provider test atomcode
sb quota
```

同一份代码兼容 OpenCode（v1 插件形态）；magpie 自有的 `auth.usage` / `auth.refresh` / `auth.checkin` 钩子会被 OpenCode 忽略。

## 免责声明与署名

本插件是非官方的兼容实现，不隶属于 AtomGit / AtomCode，也未获其认可。上游协议（签名密钥、OAuth、接口）可能随时变化；使用方式可能违反服务条款，存在账号受限或封禁风险——Atom2Api 项目有同类警示。请仅凭自己的账号、在了解风险的前提下使用。实现依据与署名见 [NOTICE.md](NOTICE.md)。
