# 下一轮迭代建议（v1.0.0 之后）

> 审查基线：`main`，HEAD `bc61ec3`，工作区干净，版本 `1.0.0`。
> 审查方式：只读静态审查，未运行 typecheck、单元测试或 e2e（当前环境不允许执行这些命令）。文中行号按当前 HEAD，若运行结果与本文不一致，以可复现测试为准。
> 仓库没有 TODO / PROGRESS / CHANGELOG，本文依据 README、近期 git log 与关键源码整理。

## 现状摘要

- 工程底座成熟：Main / Preload / Renderer 隔离、Zod 校验的 IPC、`SafeStorageSecretStore` 的“可写不可读”、ProviderClient 的密钥不外泄、Agent Host 子进程与权限回传、Context Pack 审计、i18n 与布局门禁，都有比较完整的设计和注释。
- 近期提交集中在 1.0.0 发布、更新按钮可访问性、布局门禁、中文 UI 和死样式清理。UI 与合同层投入较多，但真实执行链路还有几处没有闭合。
- 最大的问题不是“缺少功能”，而是 **UI / Main 侧看起来成功，真实 Agent 回合却走了另一条路**：设置里的 API Key 和供应商选择没有进入 Agent Host，工作区切换不会重建代码智能与技能，Context Drawer 的“扩展”因预算账本无记录而永远加不进内容。
- 因此下一轮应先修“真实链路”，再谈工具调用、索引、附件等增量功能。

### 核心链路状态

| 用户可见能力 | 当前结论 | 关键依据 |
| --- | --- | --- |
| Settings 保存 Key → 测试连接 / 模型列表 | 可用 | Main 的 `SafeStorageSecretStore` + `ProviderClient` 正常 |
| Settings 保存 Key → 真实对话 | **断** | Host 内 Universal Adapter 只读环境变量，未读 safeStorage |
| 供应商 / 模型选择 → 回合 | **断** | IPC 丢弃 `providerId`；Adapter 忽略 session 的 provider/model，使用默认值 |
| 打开 / 切换项目 → 代码智能 | **部分可用** | 只在启动时初始化一次 `listWorkspaces()[0]` |
| 打开项目 → 项目内 Skills | **断** | SkillRegistry 使用固定的 userData roots，未包含 `<workspace>/.ucad/skills` |
| Context 预览 | 可用，但依赖上一条 | 未初始化工作区的搜索失败被静默跳过 |
| Context 扩展 | **断** | IPC 伪造 turnId，账本无记录，所有候选都被预算丢弃 |
| 真实 Provider 的工具调用 / 权限回调 | **未实现** | Universal Adapter 为纯聊天，`toolContract: 'none'` |
| 更新检查 / 安装 | 不完整且有完整性风险 | 仅环境变量提供 feed；安装包无 hash/签名校验 |

---

## P0 缺陷 / 风险

### P0-1 Settings 中的供应商凭据和模型没有进入真实 Agent 回合

**现象**

用户在 Settings 里保存 API Key 后，`providers.probe` 会成功，因为探测由 Main 的 `ProviderClient` 完成，读到的是 `SafeStorageSecretStore`。但真正发送消息时，Agent Host 里的 `createAdapter()` 只读 `UCAD_PROVIDER_API_KEY` / `OPENAI_API_KEY`，供应商和模型也只读 `UCAD_PROVIDER_ID` / `UCAD_MODEL_ID`；没有环境变量时固定为 `openai` / `gpt-4o-mini`。

结果是三种“看起来能用、实际不对”的情况：

- 没设环境变量：Settings 探测成功，聊天 401。
- 设了另一家的环境变量：用户在 Composer 选了 DeepSeek，实际仍调用环境变量指定的供应商，供应商选择被静默忽略。
- 会话模型与显示不一致：Provider 卡片展示 `effectiveProviderId`，Adapter 实际使用自己的默认模型。

**证据**

- `packages/adapter-universal/src/index.ts:318-347`：`createAdapter()` 从环境变量取 Key、Provider、Model；传给 Adapter 的 `secrets` 只是环境变量的内存包装。
- `packages/adapter-universal/src/index.ts:193-194`：`UniversalSession.send()` 使用 `opts.defaultProviderId` / `opts.defaultModelId`，完全忽略会话或回合上的 provider/model。
- `packages/adapter-universal/src/index.ts:108-117`：`listModels()` 也只使用 `defaultProviderId`。
- `apps/desktop/src/main/app-container.ts:688-701`：`registerAgent()` 创建 `AgentHostProcess` 时没有传 secret resolver，也没有传供应商凭据。
- `packages/agent-host/src/agent-host-process.ts:158-184`、`234-242`：fork 只传 `process.env` 和 `extraEnv`；`initialize` 的 `env` 只是脱敏后的 `extraEnv`，不包含 safeStorage 内容。
- `packages/agent-host/src/agent-host-runner.ts:58-63`、`132`：`secretResolver` 默认实现是“永远返回 null”，当前也没有真实注入方。
- `apps/desktop/src/main/ipc.ts:317-348`：`sessions.send` 的 Zod schema 只接受 `sessionId / objective / attachments / override`，没有 `providerId`；Renderer 发来的字段被直接剥掉。
- `apps/desktop/src/renderer/src/App.tsx:310-346`、`354-379`：创建会话时没有传 `providerId/modelId`，发送时虽然传了 `providerId`，但上游 schema 不接收。
- `packages/agent-core/src/agent-runtime-manager.ts:667-679`：`create_session` 已经带上了 `providerId/modelId`，但 Universal Adapter 不消费它们，说明修在 Adapter 侧即可接上这条链路。
- `packages/providers/src/client.ts`：Main 侧 Client 本身已从注入的 `SecretLike` 读取凭据，问题不在 ProviderClient，而在 Host 侧的注入与 Adapter 使用方式。

**影响**

- README 中“任意 OpenAI 兼容供应商”和“Settings 配置凭据”的主路径实际不可用；探测成功反而会误导用户。
- 可能把 A 供应商的 Key 发给 B 供应商，属于凭据用途与计费归属错误，不只是功能缺陷。

**修复方向**

1. 建立 Host 侧的受控凭据通道。推荐由 Host 通过 host protocol 向 Main 按需请求 `SecretRef`，Main 校验 ref 后返回明文，Host 只在内存中使用；不要在 fork 时把 Key 放进 `process.env`，也不要放进会进日志的 `initialize.env`。`AgentHostRunner` 已有 `secretResolver` 注入点，可作为落点，但需要补上 Host → Main 的请求/响应帧。
2. Universal Adapter 不再把环境变量作为主来源。初始化时保存 Host 注入的 resolver，构造一个 `SecretLike` 包装它供 `ProviderClient` 使用；环境变量仅保留为开发/CI 的显式 fallback，并在日志中标注。
3. UniversalSession 从 `CreateAgentSessionInput.providerId/modelId` 取值并用于每一回合；如果允许回合级切换，再补 `AgentTurnInput` 的显式覆盖。不要继续依赖 Adapter 级默认值。
4. `sessions.create` 把 Renderer 已选中的 provider/model 写入会话；`sessions.send` 要么接受显式覆盖，要么只使用会话绑定值。二者只能有一个事实来源，避免 UI 显示与实际执行再次分叉。
5. 增加端到端测试：通过 Settings IPC 写入测试 Key，创建会话并发送一轮，使用本地假 OpenAI 服务断言 `Authorization`、`model` 和 base URL 都来自用户选择。

**验收**

- 仅通过 Settings 保存 Key（不设置环境变量）即可完成一轮真实流式对话。
- 在 Composer 切换供应商后，请求确实落到该供应商；Provider 卡片展示与实际请求一致。
- 日志、错误、IPC 返回值中都不出现密钥明文。

---

### P0-2 打开或切换工作区时没有初始化代码智能与 Skills

**现象**

代码智能只在应用启动后调用一次 `initCodeIntelligence()`，而且只取 `listWorkspaces()[0]`。首次安装、启动时还没有工作区，或者用户随后打开/切换项目时，都不会为新工作区初始化。工作区打开/激活的 IPC 只做 `upsertWorkspace`，没有触发任何重建。

Skills 也在构造时固定了一次：`workspaceRoot` 取启动时的第一个工作区，`roots` 被显式覆盖为 `userData/skills`。`SkillRegistry` 的构造函数在 `roots` 存在时不会再调用 `defaultSkillRoots()`，因此 `<workspace>/.ucad/skills` 永远不会被发现，`~/.ucad/skills` 的文档约定也没有兑现。

**证据**

- `apps/desktop/src/main/bootstrap.ts:312-315`：启动时只调用一次 `initCodeIntelligence()`。
- `apps/desktop/src/main/app-container.ts:258-282`：只初始化 `listWorkspaces()[0]`，没有工作区就返回。
- `apps/desktop/src/main/ipc.ts:106-122`、`135-154`：`workspace.open` / `workspace.activate` 只做 `upsertWorkspace`，没有初始化或重建。
- `packages/code-intelligence/src/basic-provider.ts:161-167`：初始化只是写入 `workspaceId -> root`。
- `packages/code-intelligence/src/basic-provider.ts:433-446`：未初始化的工作区直接抛 `INTELLIGENCE_UNAVAILABLE`。
- `packages/context/src/broker.ts:856-867`：搜索失败只写 warning 并 `continue`，Context Pack 会安静地缺少代码项。
- `apps/desktop/src/main/app-container.ts:245-249`：Skills 使用固定的 userData root。
- `packages/skills/src/registry.ts:203-207`：显式 `roots` 会绕过 `defaultSkillRoots(workspaceRoot)`。
- `packages/skills/src/discovery.ts`：声明的根目录包含 `<workspace>/.ucad/skills` 与 `~/.ucad/skills`，与上面的构造方式不一致。
- `packages/skills/src/registry.ts:220-222`：`invalidate()` 存在，但当前没有工作区切换等调用点。

**影响**

- 首次打开项目后，Context Pack 没有搜索/概览项，用户会以为“代码智能坏了”。
- 项目 A 切到项目 B 后，B 的查询仍会报未初始化，A 的 provider 状态可能继续被展示。
- 项目级 Skills 完全不生效，用户放在 `.ucad/skills` 的规则得不到注入。

**修复方向**

1. 在 Main 增加单一的 `activateWorkspace(workspaceId)` 入口，由 `workspace.open`、`workspace.activate` 和启动恢复共同调用；内部负责代码智能初始化、Skills 根目录更新、必要的缓存失效。
2. 不要只初始化 `[0]`。按 workspace id 维护 intelligence provider 的 root；至少保证“当前工作区”在每次切换后已初始化。
3. Skills 改为按工作区重建或在 `invalidate()` 前更新 roots。根目录应与 `packages/skills/src/discovery.ts` 的约定一致；如果 userData 路径是产品决策，需要同步改文档和 UI 说明，不能代码与文档各说一套。
4. Context Broker 在 intelligence 不可用时，不要把失败只留在日志里。把“代码搜索不可用/未初始化”作为 pack 的可见降级信息或 UI 提示，避免一个空 pack 看起来像“没有相关内容”。
5. 增加三个场景的测试：首次安装后打开项目、切换两个项目、项目内 `.ucad/skills` 与用户 Skills 同名时的覆盖关系。

**验收**

- 首次打开任意项目后，Context Preview 能出现该项目的搜索结果。
- 切换项目后，新项目的 intelligence 状态为已初始化，旧项目结果不会串入。
- 项目内 `.ucad/skills` 能被发现，并按文档规则覆盖用户级同名 Skill。

---

### P0-3 Context Drawer 的“扩展”永远加不进内容

**现象**

`context.extend` 在 Main 里没有使用 pack 自己的会话与回合，而是取 `listSessions()[0]` 并伪造 `turnId: turn_preview_${Date.now()}`。预算账本没有这个 turn 的记录，`remaining()` 返回 0，Broker 对每个候选都按 `budget` 丢弃。UI 显示“扩展成功”但 `addedItems` 为空，用户无法判断是没搜到还是预算不够。

同时，预览 pack 本身使用 `preview_...` 的 turnId，并且明确不写账本；所以即使改成使用 `pack.turnId`，也不能假设一定存在 live ledger。

**证据**

- `apps/desktop/src/main/ipc.ts:812-833`：使用 `listSessions()[0]` 和 `turn_preview_${Date.now()}`。
- `packages/context/src/broker.ts:407-411`、`413-425`：预览使用 `ulid('preview_')`，且“不写行、不碰活动回合账本”。
- `packages/context/src/ledger.ts:190-193`：`remaining()` 对没有记录的 turn 返回 0。
- `packages/context/src/broker.ts:1118-1127`：候选预算判断与扣费直接依赖该 `remaining()`。
- `packages/context/src/broker.ts:1473-1491`：fallback 计算把 `pack.budget.usedTokens` 与 `pack.items` 的 token 再相加，`usedTokens` 本身已经包含这些 item，存在重复计数。
- `packages/contracts/src/context.ts:87-103`：`ContextPack` 已带 `sessionId` 与 `turnId`，不需要从全局会话猜测。

**影响**

- 用户可见功能确定失效，而且失败是“静默成功”，比报错更伤信任。
- 即使只修 turnId，扩展后的预算显示仍可能偏高，导致后续注入空间被错误压缩。

**修复方向**

1. 删除 `listSessions()[0]` 与 `turn_preview_${Date.now()}`。从 `ContextPack.sessionId` / `pack.turnId` 取得归属；`context.extend` 的输入契约可以保留 `packId`，但不要由 IPC 层另造会话和回合。
2. 明确两种预算语义：
   - 真实回合仍在进行：继续使用该 turn 的 ledger，扩展不能绕过 build 的预算。
   - 预览包或回合已释放：使用 pack 级预算/扩展账本，不把“无 ledger”解释为“预算为 0”。
3. 修正 `budgetAfterExtend`：无 live ledger 时，`usedTokens = pack.budget.usedTokens + 本次新增 item 的 estimatedTokens`，不要再叠加 pack 内已有 item。
4. 将 `dropped` 的原因透出到 UI（预算不足、无匹配等），不要只返回一个空 delta。
5. 增加测试：预览 pack 扩展、回合结束后扩展、扩展后预算上限不被突破。

**验收**

- 对一个有可检索内容的 pack 执行扩展，`addedItems` 非空。
- `usedTokens` 的增量等于实际新增 item 的 token 和。
- 扩展不会超过 `limitTokens`，超出时 UI 能看到 `dropped: budget` 的原因。

---

### P0-4 更新链路：没有默认 feed，且安装包没有完整性校验

**现象**

- `readUpdateFeed()` 的注释声称“发布构建从打包配置读取”，实际只读 `UCAD_UPDATE_FEED` 环境变量，没有任何打包配置或默认值。普通安装用户看到的只会是“未配置更新源”，所以更新入口在发布版里事实上不可用。
- `download()` 会再次请求 feed，`fetchLatest()` 没有超时、没有检查 `response.ok`；下载重定向没有跳数上限。
- 下载完成后直接 `state: 'ready'`，`installAndRestart()` 用 `shell.openPath` 启动安装包并退出。没有 SHA-256、大小或签名校验。README 已说明安装包未签名，这使“feed 被篡改/下载被替换”直接变成任意代码执行。

**证据**

- `apps/desktop/src/main/bootstrap.ts:417-426`：`readUpdateFeed` 只读环境变量。
- `apps/desktop/src/main/update-service.ts:132-198`：`check()` 有超时和 `response.ok` 检查。
- `apps/desktop/src/main/update-service.ts:258-268`：`fetchLatest()` 没有超时，也没有 `response.ok`/内容类型检查，但 `download()` 依赖它。
- `apps/desktop/src/main/update-service.ts:271-289`：未校验即启动安装包。
- `apps/desktop/src/main/update-service.ts:298-333`：重定向无限递归，仅强制 HTTPS。
- `README.md`：Windows NSIS 安装包未签名；更新 feed 通过环境变量指定。

**影响**

- 自动更新功能对绝大多数用户不可用，或只在开发者手动设置环境变量时可用。
- 一旦启用，feed/下载链路被攻破即可执行任意安装包；这不是普通 UI 缺陷。

**修复方向**

1. 在打包配置中写入默认 feed URL（例如 release 的 `latest/download/update-feed.json`），环境变量只作为开发覆盖；`check()` 对 feed URL 做 HTTPS/主机白名单校验。
2. feed 增加 `sha256`（可选 `size`），下载完成后在写入 `downloadedPath` 前校验；校验失败删除暂存文件并回到 `error`。
3. Windows 发布流程接入 Authenticode 签名；若本轮无法签名，至少不要把“下载即安装”作为默认行为，改为显式打开下载页/确认安装。
4. `fetchLatest` 加超时与 `response.ok` 检查；feed 请求与下载重定向都设置最大跳数。
5. 更新测试：错误 hash、超大文件、重定向循环、feed 返回 404、版本号回退。

**验收**

- 发布版在不设环境变量时也能检查更新。
- 篡改安装包后校验失败，应用不会启动它。
- 下载链路在超时、404、重定向循环下都能在有限时间内失败并给出可读错误。

---

## P1 功能

### P1-1 Universal Adapter 的真实工具循环与权限接入

**问题**

当前 Universal Adapter 的能力声明是 `fileTools: false`、`shellTools: false`、`permissionCallbacks: 'none'`、`toolContract: 'none'`，`ProviderClient` 的请求体也没有 tools 字段。它只能聊天，不能像 Coding Agent 一样读写文件、执行命令或请求权限；因此 README 中的“权限门禁”在真实 Provider 路径上并没有被使用。

**证据**

- `packages/adapter-universal/src/index.ts:56-71`：工具与权限能力全部关闭。
- `packages/providers/src/client.ts:804-825`：请求体不发送 tools。
- `packages/adapter-universal/src/index.ts:206-221`：只构造 system/user 两条消息。
- `apps/desktop/src/main/ipc.ts:924-935`：工具列表依赖 host manifest，Universal 的 manifest 会把工具能力报成不可用。

**建议**

分三阶段，不要一次做成完整编码 Agent：

1. 只读工具：`files.list/read/search`，在 Host 内执行，返回值作为 tool result 回灌模型；先把 `toolContract` 和 UI 卡片打通。
2. 写入工具：`files.write` 必须带 `expectedRevision`，沿用现有文件服务的版本冲突处理。
3. Shell 工具：必须在执行前经过 `PermissionEngine`，`permissionCallbacks` 改为真实回调；拒绝、超时、审计链都要覆盖。

**验收**

用本地假 Provider 返回一个 tool call，分别测试：只读工具成功、写文件前权限拒绝、命令执行前权限拒绝、tool result 正确回灌。任何未授权的副作用都不能发生。

### P1-2 模型选择器与会话级模型绑定

**问题**

Composer 有供应商选择器，但没有模型选择器；`sessions.create` 虽然接受 `providerId/modelId`，Renderer 不传；Universal Adapter 也不消费。模型注册表、`providers.models` IPC 和每个 Provider 的 seed 模型都已存在，缺的是 UI 与会话绑定。

**证据**

- `apps/desktop/src/renderer/src/components/Composer.tsx:252-274`：只有供应商下拉框。
- `apps/desktop/src/main/ipc.ts:169-185`：`sessions.create` 已接受 `providerId/modelId`。
- `apps/desktop/src/main/ipc.ts:1009-1022`：`providers.models` 已能返回模型列表。
- `packages/providers/src/registry.ts`：`ModelRegistry` 已按 `providerId + modelId` 维护复合身份。

**建议**

在 Composer 增加模型下拉框，数据来自 `providers.models`；选择结果写入会话而不是只写全局设置。切换供应商时清理不兼容的模型 id。显示层必须同时显示 provider 与 model，避免同名模型跨供应商混淆。

### P1-3 代码智能查询的 operationId 与 provider 选择

**问题**

`intelligence.query` 把 `result.providerId` 当作 `operationId` 返回，而 Manager 实际分配的 operation id 被丢掉，取消永远找不到对应操作。查询还把 `providerId` 硬编码为 `'basic'`，忽略设置或调用方选择。IntelligencePanel 目前也没有查询取消入口。

**证据**

- `apps/desktop/src/main/ipc.ts:750-767`：`return { operationId: result.providerId, result }`，并固定 `providerId: 'basic'`。
- `apps/desktop/src/main/ipc.ts:769-774`：`intelligence.cancel` 按 operation id 取消。
- `packages/code-intelligence/src/basic-provider.ts:425-431`：provider 自己生成 `iop_...` operation id。
- `apps/desktop/src/renderer/src/components/IntelligencePanel.tsx:204-240`：index/refresh 可取消，query 没有取消 UI。

**建议**

让 manager 的 query 结果显式返回 `{ operationId, providerId, result }`，IPC 不再用 provider id 冒充 operation id；把用户/设置选择的 provider 传入；查询请求支持取消并在 UI 暴露。补一个“发起查询后取消”的契约测试。

### P1-4 “全局最近会话”被当作当前会话，导致归属与审计错位

**问题**

多个 IPC handler 用 `sessionStore.listSessions()[0]` 作为“当前会话”。这是全局最近会话，不一定是当前工作区、当前窗口或当前操作对应的会话。文件写入、Git 危险操作、终端、PTY、工具列表都可能把操作记到另一个会话上。

**证据**

- `apps/desktop/src/main/ipc.ts:531`：`files.write` 的 `sessionId`。
- `apps/desktop/src/main/ipc.ts:591`、`604`：`git.discard` / `git.commit` 的权限请求与审计会话。
- `apps/desktop/src/main/ipc.ts:620`、`670`：`terminal.create` / `terminal.ptyCreate`。
- `apps/desktop/src/main/ipc.ts:822`：`context.extend`（由 P0-3 一并修复）。
- `apps/desktop/src/main/ipc.ts:928`：`tools.list` 用最近会话决定 host 与 workspace。
- `apps/desktop/src/main/ipc.ts:156-167`：`workspace.setTrust` 也直接取 `list[0]`。

**建议**

由调用方传入 `sessionId`；确实无法传的界面操作，由 Main 维护“当前活动会话”状态，而不是从“所有会话按时间排序的第一条”推断。每个危险操作在发起权限请求前校验 session 的 workspace 与目标 workspace 一致，审计记录同时落 sessionId 与 workspaceId。增加两个工作区、多个会话交错操作的测试。

---

## P2 可选优化

- **托盘图标是 1x1 透明 PNG**：`apps/desktop/src/main/bootstrap.ts:338-347` 使用内联透明图；仓库已有 `apps/desktop/resources/icon.png` / `icon.ico`，应改为真实图标并在打包产物中验证。
- **Changes 徽标只读一次且可能读错工作区**：`apps/desktop/src/renderer/src/App.tsx:1142-1165` 在挂载时用 `workspace.listRecent()[0]` 取一次；切换项目或文件变化后不会刷新。应基于当前 workspace 订阅事件或按需重取。
- **默认 Agent 选择会被设置刷新覆盖**：`apps/desktop/src/renderer/src/App.tsx:250-256` 在 `settings/agents` 变化时重新写入默认 agent；用户手动选择后，下一次设置刷新可能被重置。应区分“初始默认”和“当前会话选择”。
- **附件能力仍被显式拒绝**：`apps/desktop/src/main/ipc.ts:324-338` 对 attachments 直接抛错。若 UI 已暴露附件入口，应先隐藏；若要支持，需定义 Adapter 的附件契约与 Provider 的 image/file 消息格式，避免只在 IPC 层“支持”。
- **导航允许列表使用字符串前缀**：`apps/desktop/src/main/bootstrap.ts:197-201` 的 `url.startsWith(own)` 会接受同前缀但不同路径的 URL（开发态尤其明显）。改为比较 `URL.origin`，生产环境 file URL 再做规范化路径/精确匹配，保持 fail-closed。
- **代码智能始终是 `not_indexed` / `stale: true`**：`packages/code-intelligence/src/basic-provider.ts:169-179` 明确如此。若产品对外宣称“代码智能”，需要补持久索引与新鲜度状态；若坚持 basic，应在 UI 与 README 中如实标注“即时扫描、无索引”，不要让用户误以为有后台索引。
- **发布工程仍只有 Windows NSIS 且未签名**：README 已声明。结合 P0-4，下一版发布前应明确签名、哈希、更新回滚与下载页兜底策略。

---

## 建议本轮只做的 1–3 件事

### 1. 打通 Settings → Agent Host → Universal Adapter 的供应商链路（P0-1）

这是唯一一件“不做，产品主路径就不成立”的事。建议拆成两个 PR，避免一次改太多：

- PR A：Host 侧凭据解析通道 + Universal Adapter 使用注入的 resolver；删除环境变量作为主路径。
- PR B：`sessions.create/send` 的 provider/model 契约 + Renderer 传值 + 本地假 OpenAI 服务集成测试。

完成标准：不设环境变量，仅用 Settings 保存的 Key 能完成一轮真实对话；Composer 选择的供应商和模型与请求实际使用的一致。

### 2. 用统一的工作区激活入口重建代码智能与 Skills（P0-2）

在 Main 增加 `activateWorkspace(workspaceId)`，由打开、切换、启动恢复共同调用；Skills 根目录与 `discovery.ts` 的约定对齐，并在工作区变化时失效缓存。完成标准：首次打开、切换项目、项目内 `.ucad/skills` 三个场景都有可验证结果，Context Pack 不再静默丢失代码项。

### 3. 修正 Context 扩展的归属与预算（P0-3）

删除伪造的 `turn_preview_*` 和 `listSessions()[0]`，从 pack 取 `sessionId/turnId`；为预览包/已释放回合提供 pack 级预算；修正 `budgetAfterExtend` 的重复计数。完成标准：扩展能实际新增 item，预算增量准确，超预算时 UI 能看到原因。

> 如果下一个公开版本就在本迭代发布，请把 **P0-4** 提到本轮第 3 件，替换 P0-3；Context 扩展可以作为一个独立的小补丁随后合入。
>
> 不建议本轮同时启动 P1-1。它需要新的工具契约、权限路径和测试体系，适合在 P0-1 把真实 Provider 链路打通后单独规划。

---

## 本轮进展

### P0-4（部分落地）：更新链路可用，且只安装校验过的安装包

本轮只做了一件事：把更新通道从"发布版里点不动"变成"发布版可用、且不会装错文件"。

已落地：

- **发布版自带 feed。** `apps/desktop/resources/update-config.json` 随打包进入
  `process.resourcesPath`，`UCAD_UPDATE_FEED` 退为开发覆盖。原先发布版只能读环境变量，
  普通用户看到的永远是"未配置更新源"。
- **安装包必须带 SHA-256。** feed 无 `sha256` 时**不下载**——无法校验的安装包不碰磁盘；
  下载后哈希对不上则删除该文件并报错，绝不启动。`installAndRestart()` 在启动前再校验一次，
  覆盖"下载与点击之间被替换"的情形。
- **下载与检查读同一份 feed。** 不再二次请求，避免 feed 在两次读取之间变化导致
  URL 与哈希来自不同文档。
- **网络边界收紧。** `fetchLatest()` 补超时与 `response.ok` 检查；下载重定向跳数上限为 5。
- **发布侧有工具。** `scripts/make-update-feed.mjs` 由安装包直接生成 feed（摘要 + 大小），
  默认 URL 指向该版本自己的 release（`releases/download/v<版本>/`），而不是 `latest/download`
  ——后者在下一个版本发布后就会 404，已发布的 v1.0.0 feed 正是这个形状。
- **界面说实话。** 设置页订阅更新状态推送，安装包校验通过时显示"已通过 SHA-256 校验"。

尚未落地（下一轮）：

- **Authenticode 签名**：安装包仍未签名，SHA-256 只防篡改，不防"发布账号被盗"。
- **feed 主机白名单**：目前只强制 HTTPS，未限制 feed 主机。
- **回滚策略**：版本号回退（feed 版本低于当前版本）目前按"已是最新"处理，未做显式回退判断。
- **P0-1 / P0-2 / P0-3 未动**：本轮未触碰凭据链路、工作区激活与 Context 扩展。

> 发布新版本时，请用 `scripts/make-update-feed.mjs` 生成 feed 并把 `sha256` 一起发布，
> 否则应用会拒绝下载——这是刻意的：无法校验的安装包不安装。

