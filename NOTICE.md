# NOTICE / 署名

本插件的实现依据（只参考事实与算法，不复制代码）：

- **[Atom2Api](https://github.com/cnluminous/Atom2Api)** — MIT License, © 2026 Atom2Api contributors。
  `atomcode-signing-v1` 签名算法（HKDF 派生与 HMAC 正则结构）、OAuth broker 端点形状、
  CodingPlan REST 用法与 `planTier` 判定均取自该 MIT 项目的源码事实；
  版本自动追踪依据其 `ua.go`（raw.atomgit.com 的 Cargo.toml URL 与 manifest 解析同源），
  登录后按 Max→Pro→Lite 幂等领取依据其 `codingplan.go` 的 `claim()` 与 `oauth.go` 的
  ClaimAndSync 触发点；
  其 `core_test.go` 的独立签名测试向量被 `test/sign.test.mjs` 作为对照基准原样使用。
  依据 MIT 许可证使用，特此署名。
- **[atomgit-opencode-bridge](https://github.com/zhuguang-ZFG/atomgit-opencode-bridge)** — 无许可证。
  仅参考其公开文档记录的协议事实（如 `403 ATOMCODE_UA_REQUIRED`、UA 必须 `atomcode/<版本>`），
  未复制其任何代码。
- **[AtomCode](https://atomgit.com/atomgit_atomcode/atomcode)** — MIT，版本 5.2.3。
  仅用作 UA / 签名 `X-AtomCode-Ver` 的版本号锚点；本插件不是它的官方组件。
- **[magpie-sensenova](https://github.com/aqiu817/magpie-sensenova) / [magpie-kilo-gateway](https://github.com/aqiu817/magpie-kilo-gateway)** — MIT, aqiu817。
  同作者的 magpie 插件工程范式（单函数入口、i18n 表、quota 缓存策略）参考对象。

## 免责声明

本插件是非官方的兼容实现，不隶属于 AtomGit / AtomCode，也未获其认可。
上游协议（签名密钥、OAuth、CodingPlan 接口）可能随时变化导致不可用；
使用方式也可能违反服务条款，存在账号受限或封禁的风险。
请仅凭自己的账号、在了解风险的前提下使用。
