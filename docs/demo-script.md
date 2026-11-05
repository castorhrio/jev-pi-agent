# UCAD 一页定位与演示脚本

给初审答辩用：**30 秒说清它是什么，3 分钟跑完三条主链路，再 90 秒走完五个界面状态**。
这里没有任何未实现的能力——每条都能在仓库里找到界面、门禁与记录。

## 一句话主张

同时跑多个编码 Agent 时，UCAD 是唯一能让你**核对**「上一轮到底注入了哪些字节」（内容哈希）
和「为什么走这条路由」（引擎 / 置信度 / 回落如实记录）的控制面——不做又一个编辑器，也不做模型厂商。

**本次现场只走 `mock` 智能体。** 厂商协议已经实现（`packages/providers` + `adapter-universal`），
现场不接网络、不填 key，是为了让不确定性可控：演示要能一次跑完、每次一样。真实厂商路由不在这次演示里，
也不假装在——被问到就照这句说。

## 目标用户

已经在用两个以上编码 Agent 的工程师与团队：Cursor 一类编辑器 + 裸 CLI agent + 自研 host。
他们的三个痛点正是 UCAD 要解决的：上下文到底塞了什么没法证明、路由为什么这样没法解释、
跨 Agent 交接靠复制粘贴。

## 五个演示动作

现场按顺序做，每一步都**在屏幕上留下可读的证据**，不靠讲解。

这五步不是为答辩编的：它们就是 `scripts/verify-main-chain.mjs` 在真机上驱动的步骤 1–5，
一步不多、一步不少。演示时屏幕上出现的东西，和那条命令在 Windows 机器上跑出来的 `[ok]` 行
是同一件事——所以「演示的」和「跑过的」不会变成两套说法。

| 演示动作 | `verify-main-chain.mjs` | 该步判绿时打印的那一行 |
|---|---|---|
| 1. 注入原文与哈希 | 步骤 1 | `[ok] step 1: the same turn reads the same hash in both surfaces` |
| 2. 决策平面 | 步骤 2 | `[ok] step 2: … decisions carry rationale + confidence + engine` |
| 3. 交接 | 步骤 3 | `[ok] step 3: the handoff lands in the new session input` |
| 4. 更新检查 | 步骤 4 | `[ok] step 4: the real feed answered over the network: …` |
| 5. 托盘与退出 | 步骤 5 | `[ok] step 5: the tray menu carries …` |

`tests/contract/demo-script.test.ts` 钉住这张表：上面每一行引用的 `[ok]` 片段都必须还在
`scripts/verify-main-chain.mjs` 的源码里，五个步骤一个都不能少，而且**不许出现步骤 6 的 `[ok]` 行**
——步骤 6 是人眼走查，没有命令能替它收口（见文末「演示之外」）。

### 1. 一轮对话，读回注入原文与哈希（约 60 秒）

- 打开一个项目目录 → Composer 把智能体切到 `mock`（不调任何厂商，不需要 key）→ 发送一句任务 → 打开「上下文」。
- 看点：`注入的原文`是整段真正渲染出的字节；旁边是 `renderedHash`；token 数与**估算来源**同处显示
  （`heuristic_chars_div_4` 或厂商 tokenizer，绝不只给数字）。
- 收尾一句：往项目里加一个字节再发一轮，哈希就变——这就是「可证明注入」。
- 真机那一行：`[ok] step 1: the same turn reads the same hash in both surfaces`；往项目里加一个字节
  再发一轮，那一行变成 `[ok] step 1: one injected byte moved the hash`。
- 依据：DoD「可证明注入」「诚实估计与凭据」；真机记录见 `docs/manual-verification.md` 步骤 1。

### 2. 决策平面：为什么走这条路由（约 45 秒）

- 打开「决策」→ 引擎表里写清每个引擎**声明能决定什么**、超时多少 → 先「运行决策预览」→ 再真实发一轮。
- 看点：每条决策带 `rationale`、`confidence`、产出它的引擎；没答上的引擎被记为**回落**，不伪装成正常结果。
- 真机那一行：`[ok] step 2: … decisions carry rationale + confidence + engine`——省略号处是这一轮
  真的产出决策的引擎数，不是引擎表的总数。
- 依据：DoD「可解释路由」；`docs/manual-verification.md` 步骤 2。

### 3. 交接：下一个 Agent 读得懂的记录（约 45 秒）

- 打开「交接」→「生成交接摘要」→「带着它开新会话」→ 回「交接历史」看 #1 被 #2 取代、点「我来接手」。
- 看点：交接是**只追加的记录**（目标 / 当前状态 / 已做的决定 / 未完成的工作），不是一段空泛总结；
  新会话的输入框里直接带着这些段落。
- 真机那两行：`[ok] step 3: the handoff lands in the new session input` 与
  `[ok] step 3: history appends: the superseded record is still listed and readable`——
  第二行是「只追加」这三个字的证据：被取代的那条还在，且还读得出来。
- 依据：DoD「权限门不可绕」之外的交接链；`docs/manual-verification.md` 步骤 3。

### 4. 更新检查：它说的是「已是最新」还是「检查失败」（约 30 秒）

- 打开「设置」→ 点「检查更新」→ 等那一行状态出现。
- 看点：屏幕上出现的是 `已是最新版本` 或 `发现新版本`，**不是**一句没有原因的
  `检查更新失败`。失败也要带原因——「连不上」和「更新源被拒」是两件事，用户要能分清。
- 收尾一句：更新源只认 `https`，明文地址会被**拒绝并说明理由**，不会静默回落到内置源。
- 真机那一行：`[ok] step 4: the real feed answered over the network: …`，省略号处是屏幕上那一行状态。
  真机上网络不通时这一步会记 `检查更新失败…` 并**不判绿**——失败路径也是结果，不是跳过。
- 依据：DoD「更新通道可信」；`docs/manual-verification.md` 步骤 4。

### 5. 托盘与退出：关窗之后应用还在不在（约 30 秒）

- 打开「设置」→ 把「关闭窗口时」切到 `隐藏到托盘` → 关窗 → 看通知区；再切到 `退出应用` → 关窗 → 看进程。
- 看点：`隐藏到托盘` 下窗口消失而进程还在（通知区有图标，菜单三项可读）；`退出应用` 下进程真的退出。
  这两个答案**必须相反**——同一个开关给出同一个答案，就是那个开关没接上。
- 真机那三行：`[ok] step 5: the tray menu carries …`（菜单三项由应用自己写的 `tray menu built`
  日志断言，不是靠人读屏幕）、`[ok] step 5: the window is hidden and the process is alive`、
  `[ok] step 5: the process exited on close, as the setting says`。
- 依据：DoD「关闭窗口的行为与设置一致」；`docs/manual-verification.md` 步骤 5。

## 演示之外：五个界面状态的人眼走查

前五个动作走的是「有数据、一切正常」的那条路。真实用户第一次打开时看到的不是它，
读失败时看到的也不是它。这一节把五个状态逐个走一遍，**每个状态都有一句「失败长什么样」**——
演示时如果屏幕上出现的是那一句，说明这个状态坏了，不要往下讲。

**这一节不是 `verify-main-chain.mjs` 的步骤。** 它是那份清单的第 6 步，而第 6 步没有命令能驱动：
五态被断言、被测量、被拍照，但「读起来像不像首启 / 像失败 / 像权限请求」只有人眼能答。
所以这里没有任何步骤 6 的 `[ok]` 行可引——`tests/contract/demo-script.test.ts` 会拒绝出现那一行，
免得演示脚本把一件人做的事说成一条跑过的命令。

```bash
npm run dev:web          # 默认 http://localhost:5173
```

| 状态 | 做什么 | 屏幕上应看到什么 | 失败长什么样 |
|---|---|---|---|
| 首启 `?scenario=empty` | 打开 `http://localhost:5173/?scenario=empty` | 对话区有引导语「还没有对话。在下方描述你的任务…」和「发送之后会发生什么」三步；会话列说 `还没有会话。点上面的「新建会话」就能开始。`；**屏幕上没有任何「加载中…」** | 空白页；或已经加载完了还在转圈；或会话列说「还没有会话」而项目其实没打开（该说的是「先打开一个项目」） |
| 加载 `?scenario=loading` | 打开 `?scenario=loading`，在读取**还没回来**的那一帧看 | 会话列与对话区都在说「加载中…」 | 出现「还没有对话」——把还没读到的历史当成「空」下结论；或骨架闪一下就变成空面板 |
| 失败 `?scenario=error` | 打开 `?scenario=error` | 标题「出错了」+ 原始失败文本 `[fixture:error] workspace.listRecent failed` + 「重试」按钮 | 只有一句「出错了」没有原因；或干脆是空面板；或重试按钮点了没反应 |
| 部分失败 `?scenario=partial` | 打开 `?scenario=partial` | 项目名在屏上（工作区读成功），会话列说「会话列表读取失败（不是空的）」并带原因 `[fixture:partial] sessions.list failed` | 把读失败渲染成「没有会话」——用户会以为数据没了；或整页都变成错误页（一个面板坏了不该拖垮全部） |
| 权限 `?scenario=permission` | 打开 `?scenario=permission`，读弹窗，然后点「拒绝」 | 弹窗标题「Agent 请求权限」，正文五件可读：类别 `SHELL`、风险 `high`、资源、命令、原因；四个回答都在（允许一次 / 本次会话允许 / 本项目允许 / 拒绝）；点「拒绝」后弹窗**消失** | 弹窗不动（点了没反应）；或只有「允许」没有「拒绝」；或弹窗消失但事件流里没有 `permission.resolved`——决定没被记下来，等于没发生 |

**这十张图在仓库里**（真实 Chromium 拍的，五态 × 两个尺寸）：

- 1440×900（产品开窗尺寸）：首启 `docs/screenshots/empty.png` · 失败 `docs/screenshots/error.png`
  · 加载 `docs/screenshots/states/loading.png` · 部分失败 `docs/screenshots/states/partial.png`
  · 权限 `docs/screenshots/states/permission.png`
- 768×700（产品允许的最小窗口）：`docs/screenshots/states/{empty,loading,error,partial,permission}-768x700.png`

窄窗口那一批是同一批 target 在最小窗口下拍的，用来回答「挤到最小时还读不读得下去」——
现场演示时把窗口拖到 768×700 再看一遍，比只看宽图有说服力。

**依据**：DoD「权限门不可绕」；`tests/e2e/scenarios.e2e.test.tsx` 把上表每一行变成断言，
`tests/contract/layout.test.ts` 在真实布局引擎里量这五态（1440×900 与 768×700 两个尺寸），
`tests/contract/screenshots.test.ts` 保证上面五张图与渲染层源码同步。
人眼走查的记录在 `docs/manual-verification.md` 步骤 6。

**现场怎么判「这一屏对不对」**：不要凭感觉。`docs/state-walkthrough.md` 给每一态写了三条
能用「是 / 否」回答的判据（例如首启态「第一眼落在引导语上而不是空列头上」「三步一眼能数出」），
每条都锚在屏幕上真的会出现的字上。文件顶部还有一份**5 分钟走查脚本**：十张图按顺序排好，
每张图写明要回答哪三条判据，末尾给一行签字模板——照着念、照着答，答「否」就停在那一条，别往下讲，
那正是这个状态坏了的样子。走查完在记录表里签一行（日期 / 看了哪几张 / 结论），
签了字之后 README 里「还没被人眼走查过」那句才该改。

**被问到「这五个状态是真机跑的吗」**：图是 `npm test` 的布局门禁在真实 Chromium 里拍的，
不是手绘也不是 mock 图；但**观感**（引导语够不够醒目、失败信息压不压过内容）仍然要人眼看，
这一条在 `docs/manual-verification.md` 里如实写着「仍未做」，判据与签字表在 `docs/state-walkthrough.md`。

## 凭什么只有它能做

编辑器把上下文当内部实现，CLI 编排把路由当脚本分支——两者都不把它做成**用户可以核对的界面产物**。
UCAD 把这两件事做成屏幕上的字节与记录，再配上只追加的交接链、执行前有记录的权限门、
以及只写进 OS 钥匙串的凭据：全部落在本地，不上传。

30 秒版本：**内容哈希 + 类型化决策记录 + 只追加的交接链**，同一屏可读，且每一条都有能变红的门禁。

## 现场不要说成什么

- 不是 IDE，不是终端 Agent，不托管模型（这是 `docs/PRODUCT-DOD.md` 的停手清单，不是缺点）。
- `mock` 智能体给的是**协议演示**，不是真实模型的回答——自己先说出来，别等评委问。
- 窗口没配置厂商 key，所以真实路由到某家的效果不在这次演示里。

## 被问到「真机跑过吗」

- 主链路的记录在 `docs/manual-verification.md`，一行一条：平台、构建、覆盖步骤、结果与证据（哈希前 12 位、日志原文）。
- 复现方式是一条命令：`npm run package` 之后 `node scripts/verify-main-chain.mjs`（Linux 需有桌面会话与系统钥匙串；
  Windows 加 `--exec release\win-unpacked\UCAD.exe`）。
- 自动化门禁（`npm run typecheck && npm run lint && npm run knip && npm test && npm run test:e2e`）先绿，
  真机记录才算数；两者不能互相替代。
