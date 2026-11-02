# 主链路手工验证

这份清单回答一个问题：**装好的 UCAD，六件核心的事是不是真的能做**。
自动化门禁覆盖不到托盘、系统钥匙串和真实厂商网络，所以这一步只能由人在桌面上跑。

- 它不是发布门禁的替代：`npm run typecheck && npm run lint && npm run knip && npm test && npm run test:e2e` 仍然要先绿。
- 它不测新功能：只跑已经发布过的那条主链路。发现问题就记下来，别在验证途中顺手改行为。
- 每一步都写「操作 → 期望 → 实测」。只写“OK”的记录不算记录。

## 运行前提

- 一个**有桌面会话**的机器，且系统钥匙串可用：Windows 用 DPAPI；Linux 需要 Secret Service。
  Linux 上还有一个真机跑出来的前提：Chromium 是按**声明的桌面环境**（`XDG_CURRENT_DESKTOP`）
  决定用不用钥匙串后端的，所以「会话总线应答 `org.freedesktop.secrets`、`secret-tool` 能存能取」
  仍然不够——没有声明时后端根本不会被选中，应用会在启动处停下。
  停下时打的是 `[ucad] startup stopped: <原因>`，后面跟着该平台能照做的补救话，
  而不是深入保险库的 `safeStorage.encryptString` 堆栈。
  这是**阻塞**，不是通过——headless CI 机器与容器不能当这一步的证据。
- Node.js 22.12 或更新，已 `npm install`；要么 `npm run dev`，要么装 `UCAD-Setup-<版本>.exe`。
- 至少一个项目目录。没有厂商 key 也能跑：选 `mock` 智能体，它不调用任何厂商；
  它给的是协议演示，不是真实模型的回答。

## 用命令跑，而不是用眼睛跑

步骤 1–5 有了一条可复现的命令（步骤 6 是五个界面状态的人工走查，仍然靠眼睛）：

```bash
npm run package
xvfb-run -a node scripts/verify-main-chain.mjs        # 或 --exec release\win-unpacked\UCAD.exe
```

它启动构建产物，用 DevTools 驱动真人会点的那些界面，并把这张表要的证据打出来：
一轮对话的 `renderedHash` 与注入原文、决策行的 rationale/confidence/引擎、
生成的交接与它的历史、**真实网络**下的更新检查（外加两条被拒的 feed 与一条失败的 feed）、
以及两种「关闭窗口时」设置下的进程寿命。`--steps 1,4` 只跑其中几步。

它替代不了两件事，输出里也照实写着：项目是直接写 `workspaces` 行打开的
（没有任何 DevTools 方法能碰到原生目录选择器，所以**信任弹窗不在屏上**）；
Xvfb 上没有托盘宿主，所以托盘只能作为「进程还活着、窗口不见了」被观察，不是一张看得见的菜单。

## 记录方式

在下面的表里**追加**一行，不要覆盖旧行。`结果` 写三件事：跑到了哪一步、结论、证据
（日志里的原文、界面上的 `renderedHash` 前 12 位、错误提示原文）。卡住就写
`阻塞：<原文>` 以及原因；空着或写 `TODO` 的记录不能当作验证。

| 日期 | 平台 | 构建 | 覆盖步骤 | 结果 / 证据 |
|---|---|---|---|---|
| 2026-11-02 | Linux x64（Ubuntu 26.04，headless + xvfb） | `npm run package` 产物 `release/linux-unpacked` | 打包适配器解析 | **通过**：`node scripts/verify-packaged-adapters.mjs` 输出 `adapters resolved: universal, mock`，退出码 0，退出后无残留 `ucad` 子进程 |
| 2026-11-02 | Linux x64（Ubuntu 26.04，headless + xvfb） | 同上 | 步骤 1–5 真机 | **阻塞**：应用在 `safeStorage.encryptString` 处退出，`Error: Encryption is not available`。该主机没有 Secret Service，启动不到窗口；Windows 上这条路径走 DPAPI，仍需在 Windows 桌面补跑 |
| 2026-11-02 | Linux x64（Ubuntu 26.04） | `HEAD` 源码 | 步骤 1、2、3、5、6 的渲染层等价路径 | 见 `npm run test:e2e`；它用内存 fixture 驱动同一批界面，但不经过真实托盘与钥匙串 |
| 2026-11-02 | Linux x64（Ubuntu 26.04，headless + xvfb） | 同上 | 步骤 4 的拒绝路径 | 见合约测试：明文/非 URL 的 `UCAD_UPDATE_FEED` 被拒且原因进日志；真实网络下的“发现新版本”未跑 |
| 2026-11-03 | Linux x64（Ubuntu 26.04，**桌面会话**：`dbus-run-session` + `gnome-keyring`（Secret Service）+ `xvfb-run`，`XDG_CURRENT_DESKTOP=GNOME`） | `npm run package` 产物 `release/linux-unpacked/ucad`（asar） | 步骤 1、2、3、4 | **通过（1–4）**：`node scripts/verify-main-chain.mjs` 退出码 0 之前各步 `[ok]`。步骤 1：`renderedHash=80e256b63523731c…`，同一轮换面板重读仍是同一哈希；任务描述多一个字符后 `673b97ec35b5…`；注入原文 `<ucad-context pack="cp_01M6EXDMQTDJMBTVNP3NX8N9B6" revision="1" tokens="401" estimate="heuristic_chars_div_4" strategy="hybrid" stale="true">`，估算来源 `heuristic_chars_div_4`。步骤 2：7 行决策带 rationale/confidence/引擎，样例 `route 路由 → universal route -> 'universal' (isDefaultRuntime). signals: git facts unavailable…`。步骤 3：交接带 `confidence=` 决策，`带着它开新会话` 后输入框以 `# 继续上一个会话的交接` 开头，历史 `#4 无人认领 / #3 #2 #1 已被更新的取代`。步骤 4：真实 https feed 返回 `已是最新版本`；明文覆盖 `检查更新失败: 更新源必须使用 https，请检查 UCAD_UPDATE_FEED 或 update-config.json`，日志 `update feed ignored: UCAD_UPDATE_FEED or update-config.json must be an https URL`。**注意**：本机到 `github.com` 不通（`curl https://github.com` 20s 超时），随包 feed 的地址因此取不到，步骤 4 的“有网”分支是用 `--feed-url` 指向真实 https 文档（本仓 `package.json`，version 1.0.0）跑的；随包 feed 本身仍需在能连 `github.com` 的机器上补一次。步骤 5、6 本轮未跑 |

**Windows 真机六步仍未跑。** 发布前必须在 Windows 桌面补一次完整记录；上面几行不能替代它。
Linux 桌面会话那一行（2026-11-03）是第一次在**有钥匙串的桌面会话**里跑通步骤 1–4，
它证明的是「这条链路在真机上成立」，不是「Windows 上成立」——平台差异（DPAPI、托盘、NSIS）仍要单独跑。

## 1. 一轮对话，读回注入原文与哈希

**操作**

1. 打开一个项目（「项目」→ 打开目录）。
2. 在 Composer 把智能体切到 `mock`；供应商保持「跟随 Agent / 会话」。
3. 输入一句任务（例如：分析登录失败的原因并运行相关测试），发送，等回答结束。
4. 打开「上下文」。

**期望**

- 「注入预览」显示本轮真正渲染出的原文，旁边是 `renderedHash`；不是“大概注入了哪些文件”的摘要。
- token 数与「估算来源」出现在同一处：厂商 tokenizer 或启发式估算，不能只给数字。
- 改变注入内容（例如换一个项目、在 `<project>/.ucad/skills/<name>/SKILL.md` 改一个字、
  或在任务描述末尾多打一个字符）后，哈希随之改变——这是「哈希就是这段字节」的证明。
- 同一轮的重读（换到「上下文」再换回来）哈希不变。注意渲染出的字节里带着 pack id，
  **每一轮都是新的 id**，所以「两轮输入一样、哈希应该一样」不是本应用的承诺；
  承诺是界面写的那句：同一个 Pack 渲染同一段字节、同一个哈希。

**实测**：2026-11-03 Linux 桌面会话（见上表）**通过**：`renderedHash=80e256b63523731c…`，
重读同哈希，多一个字符变 `673b97ec35b5…`，注入原文与 `estimate="heuristic_chars_div_4"` 同屏。
渲染层等价覆盖：`tests/e2e/critical-path.e2e.test.tsx`、`tests/contract/injection-contract.test.ts`。

## 2. 决策审计：为什么走这条路由

**操作**

1. 打开「决策」。
2. 看引擎表：哪些引擎在链上、各自声明能决定什么。
3. 用面板里的预览发一次决策；再真实发送一轮，让路由发生一次。
4. 调换引擎顺序后重跑，确认设置里看到的链就是实际跑的链。

**期望**

- 每条决策都有 `rationale`、`confidence` 和产出它的引擎；不是只写“已路由”。
- 回落被记为回落（哪个引擎没答、为什么），而不是伪装成正常结果。
- 本版本不认识的引擎被忽略，且不会偷偷出现在链里。

**实测**：2026-11-03 Linux 桌面会话**通过**：7 行决策各带 rationale/confidence/引擎，
样例 `route 路由 → universal route -> 'universal' (isDefaultRuntime)`。
渲染层等价覆盖：`tests/e2e/critical-path.e2e.test.tsx`、
`tests/contract/decision-contract.test.ts`、`tests/contract/decision-chain.test.ts`。

## 3. 交接：下一个 Agent 能读到

**操作**

1. 在一轮有内容的会话里打开「交接」。
2. 点「生成交接摘要」，读目标、状态、相关文件、已做的决定、未完成的工作。
3. 点「带着它开新会话」；确认新会话的输入框里带着这些段落。
4. 回到「交接」→「交接历史」，确认记录只追加、旧的仍可读；点「我来接手」再「标记完成」。

**期望**

- 交接是**可读记录**，不是一段空泛的总结。每一段都要出现：没有内容时显示「0 / 无」，
  而不是把段落抹掉。「未完成的工作」只有在会话里确实留下了未完成事项时才应有内容——
  一轮 `mock` 对话做完之后它是空的，这不是缺陷。
- 历史里新的取代旧的，旧的不会消失；认领/完成的状态改变会留在链上。
- 复制为 Markdown 得到的是整份记录，不随勾选变化。

**实测**：2026-11-03 Linux 桌面会话**通过**：交接带 `confidence=` 决策，`带着它开新会话` 后
输入框以 `# 继续上一个会话的交接` 开头，历史 `#4 无人认领 / #3 #2 #1 已被更新的取代`。
渲染层等价覆盖：`tests/e2e/handoff-history.e2e.test.tsx`、`tests/contract/handoff-chain.test.ts`。

## 4. 更新检查不是静默失败

**操作**

1. 打开「设置」→「更新」，点「检查更新」。
2. 分别在三种情况下重复：出厂构建（自带 feed）、`UCAD_UPDATE_FEED` 指向合法 `https` feed、
   `UCAD_UPDATE_FEED=http://example.com/update-feed.json`（明文）。
3. 再试一个根本不是 URL 的值（例如 `not-a-url`）。
4. 查看应用日志。

**期望**

- 出厂构建不需要用户配置就能读到 feed；dev 构建读源码树里的 `resources/update-config.json`。
- 有网时：`发现新版本`（带 notes）或 `已是最新版本`；断网/feed 出错时：
  `检查更新失败: <原因>`，按钮不会看起来“没反应”。
- 明文与非 URL 覆盖值都被拒绝，日志里有原因和变量名；**不走**随包 feed。
- 完全没有 feed 时显示 `未配置更新源`，与“检查失败”分开。

**实测**：2026-11-03 Linux 桌面会话**部分通过**：真实 https feed → `已是最新版本`；
明文覆盖 → `检查更新失败: 更新源必须使用 https…` 且日志有 `update feed ignored: …`。
**未覆盖**：随包 feed（`github.com/.../releases/latest/download/update-feed.json`）——本机到
`github.com` 不通，这一条要在能连它的机器上补。拒绝路径另有合约测试
（`tests/contract/update-feed.test.ts`、`tests/contract/readme-update-parity.test.ts`）。

## 5. 关窗、托盘，以及托盘坏掉时

**操作**

1. 保持默认「设置 → 关闭窗口时 → 隐藏到托盘」，点窗口的 ×。
2. 从托盘图标恢复窗口（「显示主窗口」），再关闭；从托盘选「退出 UCAD」。
3. 把「关闭窗口时」改成「退出应用」，重复一次。
4. 故障路径：在 dev 构建里临时重命名 `apps/desktop/resources/icon.png`
   （打包构建里是 `resources/icon.png`），重启后点 ×。

**期望**

- 默认关窗只是隐藏：进程仍在，托盘菜单同时有「显示主窗口」和「退出 UCAD」。
- 选「退出应用」后点 × 直接退出，不留在托盘。
- 图标读不出来时应用**退出**，而不是藏到一个看不见的地方；日志出现
  `tray unavailable; closing the window will quit` 及原因（`icon-empty` / `no-tray`）。
- 测完把图标文件改回来，确认托盘重新可用。

**实测**：未在真机跑（headless 主机没有真实通知区）。纯逻辑分支由
`tests/contract/tray-icon.test.ts` 固定。

## 6. 五个界面状态逐一可见

**操作**

```bash
npm run dev:web
```

依次打开（默认是 happy path，不需要参数）：

- `http://localhost:5173/?scenario=empty`：没有项目、没有会话的首启状态。
- `http://localhost:5173/?scenario=loading`：所有读取变慢，骨架/加载态可见。
- `http://localhost:5173/?scenario=error`：核心读取失败，错误原文上屏，不是空面板。
- `http://localhost:5173/?scenario=partial`：部分面板正常、部分失败——真实故障的样子。
- `http://localhost:5173/?scenario=permission`：一条待处理的权限请求，允许/拒绝都能走。

**期望**：每个状态都不是空白页；失败有原因；加载态不假装已经加载完；
权限弹窗能看清在请求什么，再做决定。

**实测**：未逐个人工走查。fixture 本身由 `tests/contract/fixture-bridge.test.ts` 校验，
界面状态由 `tests/e2e/critical-path.e2e.test.tsx` 覆盖。

## 发布前必须满足

- 上表至少有一行来自 **Windows 桌面**，覆盖步骤 1–6。
- 任何一步写的是「阻塞」或「未跑」，发布说明里就得如实写出来，不能当作通过。
