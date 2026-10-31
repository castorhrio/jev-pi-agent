# UCAD（jev-pi-agent）产品标准锁定稿（writable draft）

> 状态：**writable draft**（2026-10-31 Asia/Shanghai）；**尚未**授权同步进 live scheduler / control prompts  
> 用途：给 agent 下一刀 / TODO / next-iteration 的 **下一轮合法输入源**（待 GIN 批准后锁定）  
> 产品名：**UCAD**（仓库 `jev-pi-agent`）——多编码 Agent 控制面：可证明的上下文注入 + 可解释路由  
> 航运：Windows NSIS 安装包（`UCAD-Setup-<ver>.exe`）+ `update-feed.json`（须 `sha256`）在 GitHub Releases  
> 代码：`/opt/jev-pi-agent` · GitHub `castorhrio/jev-pi-agent`  
> **不改** live scheduler、config.yaml、产品业务代码；本文件仅 box `/workspace/product-dod/` 可写草稿

---

## 一句话黑核心竞争力

同时跑多个编码 Agent 时，能**核对**「上一轮到底注入了哪些字节」（内容哈希）以及「为什么走这条路由」（引擎 / 置信度 / 回落如实记录）——不做又一个编辑器或模型厂商。

---

## 竞品对照（1–3）

| 对手 | 对方强在 | 我们的差异 |
|---|---|---|
| Cursor / 其它 AI IDE 多智能体编排 | 编辑体验、生态 | 我们专注控制面：注入可哈希核对、决策可审计，而非取代编辑器 |
| 裸 CLI Agent 编排脚本 | 灵活 | GUI：Context Drawer、决策平面、交接链、权限门、钥匙串凭据 |
| 【待核验】其它「Agent 控制面 / router」开源项目 1 个 | — | 只对照「可证明注入 + 可解释路由」两句，不做 IDE 功能对等 |

---

## Definition of Done（可航运控制面）

- [ ] **可证明注入**：Context Pack 纯函数 + 内容哈希；界面可展示上一轮注入原文；改一字节哈希失配
- [ ] **可解释路由**：每次决策记录 rationale / confidence / 引擎；回落记为回落；设置里引擎链与实跑一致
- [ ] **权限门不可绕**：执行前有记录在案的允许/拒绝；审计可查
- [ ] **Windows 安装包航运**：Releases 上 NSIS 可装；更新 feed `https` + `sha256` 校验；明文/非 URL 覆盖被拒并打日志；未签名 SmartScreen 有说明
- [ ] **门禁即 DoD**：`npm run typecheck && lint && knip && test && test:e2e`（及 CI 等价）绿；注入/交接/凭据/更新合约测试能打红
- [ ] **诚实估计与凭据**：token 来源（厂商 tokenizer vs 启发式）上屏；凭据进 OS 钥匙串，不经环境变量/日志泄露

---

## 停手清单

- 做成全功能 IDE / 终端 Agent / 自有模型托管
- 弱化哈希展示或「大概注入了那些文件」的模糊文案替代可核对原文
- 无 `sha256` 的更新 feed 仍执行安装
- 为冲功能关掉权限门或交接认领合约
- 大范围换 Electron/状态框架无门禁失败证明

DoD 后只修回归、更新/签名供应链、安全/密钥、反馈点名卡点。

---

## 代理反馈回路（每周，各 ≤5 条）

### A. 陌生人 / 真用户（≤5）

1. 能否在 Context 面板指出「上次到底塞了什么」
2. 决策平面是否看懂「为什么选这个引擎」
3. 权限弹窗是否可信（会不会无脑点允许）
4. 多 Agent 交接是否减少重复提问
5. SmartScreen / 托盘「出得来吗」是否劝退

### B. 竞品对照（≤5）

1. IDE 内多智能体是否已提供可哈希注入——我们差异是否仍立得住
2. 本周只记 1 条路由可解释性缺口
3. 更新/供应链竞品事故——只强化我们 feed 合约
4. 最多吸收 1 个 UX 优点
5. 禁止做成编辑器对等清单

---

## 代理下一刀只能从哪里拉

1. DoD 未勾选
2. 当周反馈浓缩
3. 回归 / 安全 / 密钥 / 更新 feed 合约

**禁止**：改 scheduler；静默安装无哈希包；在日志打印 key。

---

## Repo path anchors

| 项 | 路径 |
|---|---|
| 阿里云 | `/opt/jev-pi-agent` |
| README | `README.md`（英/中） |
| 贡献/门禁 | `CONTRIBUTING.md` |
| 截图 | `docs/screenshots/` |
| 应用 | `apps/` |
| 包 | `packages/` |
| 测试 | `tests/contract` · `tests/e2e` |
| 更新脚本 | `scripts/make-update-feed.mjs` |
