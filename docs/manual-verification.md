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
以及两种「关闭窗口时」设置下窗口是否真的离开屏幕、进程是否仍活。`--steps 1,4` 只跑其中几步。

它替代不了一件事，输出里也照实写着：项目是直接写 `workspaces` 行打开的
（没有任何 DevTools 方法能碰到原生目录选择器，所以**信任弹窗不在屏上**）。

`--steps` 只接受 1–5。步骤 6 是人在 `npm run dev:web` 里逐个走查的五个界面状态，
脚本驱动不了它，所以 `--steps 6` 现在会**停下并给出原因**（退出码 1），
而不是启动一次、什么都不驱动、再用 `PASS` 结尾——那种「沉默即通过」的记录比没有记录更糟。
同理，某个被请求的步骤若既没有 `[ok]` 也没有 `[FAIL]`，结尾会按失败计（脚本里叫 stepCoverage）。

托盘菜单以前是第二件：原生对象，DevTools 碰不到，所以脚本只把三个菜单项**打印**出来，
让人自己去看。现在应用把建好的菜单写进自己的日志（`tray menu built`，带 `items` 数组），
脚本读那一行**断言**三项都在——菜单是被检查的，不是被描述的。
宿主上根本没有托盘时（没有通知区），脚本记下应用自己说的原因（`tray unavailable`）而不是打红，
因为那种机器上确实没有菜单可查。

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
| 2026-11-03 | Linux x64（Ubuntu 26.04，桌面会话：`dbus-run-session` + `gnome-keyring` + `xvfb-run`） | `npm run package` 产物 `release/linux-unpacked/ucad` | 步骤 5 | **部分通过**：`--steps 5` 打印托盘菜单项 `显示主窗口 / 打开项目… / 退出 UCAD`（读自 `i18n.ts`）；「隐藏到托盘」关窗后进程仍活、窗口不在屏上（`[ok]`）；**「退出应用」打红**：进程没退出——`window-all-closed` 只在没有托盘时 `app.quit()`，有托盘时窗口关掉、进程留在后台且没有窗口可恢复。缺陷待修 |
| 2026-11-03 | Linux x64（Ubuntu 26.04，**桌面会话**：`dbus-run-session` + `gnome-keyring`（Secret Service）+ `xvfb-run`，`XDG_CURRENT_DESKTOP=GNOME`） | `npm run package` 产物 `release/linux-unpacked/ucad`（asar） | 步骤 1、2、3、4 | **通过（1–4）**：`node scripts/verify-main-chain.mjs` 退出码 0 之前各步 `[ok]`。步骤 1：`renderedHash=80e256b63523731c…`，同一轮换面板重读仍是同一哈希；任务描述多一个字符后 `673b97ec35b5…`；注入原文 `<ucad-context pack="cp_01M6EXDMQTDJMBTVNP3NX8N9B6" revision="1" tokens="401" estimate="heuristic_chars_div_4" strategy="hybrid" stale="true">`，估算来源 `heuristic_chars_div_4`。步骤 2：7 行决策带 rationale/confidence/引擎，样例 `route 路由 → universal route -> 'universal' (isDefaultRuntime). signals: git facts unavailable…`。步骤 3：交接带 `confidence=` 决策，`带着它开新会话` 后输入框以 `# 继续上一个会话的交接` 开头，历史 `#4 无人认领 / #3 #2 #1 已被更新的取代`。步骤 4：真实 https feed 返回 `已是最新版本`；明文覆盖 `检查更新失败: 更新源必须使用 https，请检查 UCAD_UPDATE_FEED 或 update-config.json`，日志 `update feed ignored: UCAD_UPDATE_FEED or update-config.json must be an https URL`。**注意**：本机到 `github.com` 不通（`curl https://github.com` 20s 超时），随包 feed 的地址因此取不到，步骤 4 的“有网”分支是用 `--feed-url` 指向真实 https 文档（本仓 `package.json`，version 1.0.0）跑的；随包 feed 本身仍需在能连 `github.com` 的机器上补一次。步骤 5、6 本轮未跑 |
| 2026-11-03 | Linux x64（Ubuntu 26.04，headless） | `npm run package` 产物 `release/linux-unpacked`（`app.asar` 内 `apps/desktop/dist/main/bootstrap.js` 确认含新判定） | 步骤 5 的代码侧 | **缺陷已修，真机记录顺延**：`window-all-closed` 改由 `decideAllWindowsClosed()` 判定，`quit` 压过托盘；`before-quit` 在没有容器时不再 `preventDefault()`。证据是门禁而不是人眼：`tests/contract/tray-icon.test.ts` 的 `the last window is gone`（5 条）与 `the last-window rule is wired into the lifecycle`（3 条）全绿，且「只问托盘」那句旧表达式被断言**不许再出现**。**本轮没有真机行**：`electron-builder --dir` 在产物写完后卡住未退出（`release/linux-unpacked/ucad` 与 `app.asar` 已是 07:24 的新产物），`--steps 5` 的实跑因此没跑成，下一轮补 |
| 2026-11-03 | Linux x64（Ubuntu 26.04，**桌面会话**：`dbus-run-session` + `gnome-keyring`（Secret Service）+ `xvfb-run`，`XDG_CURRENT_DESKTOP=GNOME`） | `npm run package` 产物 `release/linux-unpacked/ucad`（`app.asar` 内 `bootstrap.js` 含 `tray menu built`） | 步骤 5 | **通过（两条分支都过）**：`node scripts/verify-main-chain.mjs --steps 5` 退出码 0。托盘菜单不再靠目视——应用日志 `tray menu built` 的 `items` 为 `["显示主窗口","打开项目…","设置","退出 UCAD"]`，脚本断言三项都在（`[ok] step 5: the tray menu carries 显示主窗口 / 打开项目… / 退出 UCAD`）。「隐藏到托盘」：关窗后 `process still running`、窗口 `gone (the page target no longer exists)`，`[ok]`；「退出应用」：`process exited, code 0`，`[ok]`——上一轮那个「点了退出但没退」的缺陷在真机上确认已修。本轮 `electron-builder --dir` 正常退出（上一轮的卡住未复现） |


**Windows 真机六步仍未跑。** 发布前必须在 Windows 桌面补一次完整记录；上面几行不能替代它。
Linux 桌面会话那两行（2026-11-03）是第一次在**有钥匙串的桌面会话**里跑通步骤 1–5，
它证明的是「这条链路在真机上成立」，不是「Windows 上成立」——平台差异（DPAPI、托盘、NSIS）仍要单独跑。
步骤 5 的两条分支（隐藏到托盘 / 退出应用）现在都有真机 `[ok]`，托盘菜单也从「目视」变成了
「读应用自己写的 `tray menu built` 再断言」，所以下一轮复跑不需要有人盯着托盘看。

**环境备注（2026-11-03）**：`electron-builder --dir` 在 07:24 那次产物写完后**卡住未退出**，
下一轮同一命令正常退出。这是环境 flake，不是产品问题；若再复现，先看 `release/linux-unpacked` 的时间戳
（产物已是新的就说明打包其实完成了），不要当产品缺陷查。

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

**实测**：2026-11-03 Linux 桌面会话（`--steps 5`）**部分通过**，见上表那一行。
脚本现在断言两件事而不是一件：进程仍活，**并且**窗口不在屏上（`document.visibilityState`，
读不到时退回「页面目标还在不在」）。只断言「进程还活着」会被「藏进一个不存在的托盘」骗过去——
那正是用户只能靠任务管理器才能恢复的状态。

**「退出应用」分支打红**，这是本轮新断言抓到的产品缺陷：`window-all-closed` 只在
`!trayUsable` 时 `app.quit()`，所以有托盘时选「退出应用」点 ×，窗口关掉、进程留在后台。
修在 `apps/desktop/src/main/bootstrap.ts`，下一刀连同 Windows 真机一起验。

**限制**：脚本只能用渲染层的 `window.close()` 触发关闭，而它会连页面目标一起销毁；
真机上点 × 是原生关闭，页面会活下来。所以脚本断言到的是「窗口不在屏上 + 进程仍活」，
托盘菜单项本身仍要人工目视（脚本把该看的三个标签打出来，不靠记忆）。
纯逻辑分支由 `tests/contract/tray-icon.test.ts` 与 `tests/contract/verify-main-chain.test.ts` 固定。

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

**实测（自动化部分，2026-11-03）**：`tests/e2e/scenarios.e2e.test.tsx` 把上面四句话变成了断言，
每个状态各自回答一句，`npm run test:e2e` 每次都会跑：

- `empty`：首启不是空白页——`empty.chat` 的引导语与三个步骤都在，会话列说的是「还没有项目」而不是「没有会话」，
  且屏幕上**没有**任何「加载中」（已经加载完就不许再声称在加载）。
- `loading`：在读取**还没回来**的那一帧拍照（`fixture.pending() > 0` 之后再看），会话列与对话区都在说加载中，
  并且**不出现**「还没有对话」——把未到达的历史渲染成「空」，是对还没读到的数据下确定结论。
- `error`：`error.title` 与 fixture 的原始失败文本 `[fixture:error] workspace.listRecent failed` 同屏，
  并给出重试按钮；不是一句「出错了」也不是空面板。
- `partial`：工作区读成功（项目名在屏上），会话列说「读取失败」并带原因 `[fixture:partial] sessions.list failed`，
  且不把失败渲染成「没有会话」。
- `permission`：弹窗 `aria-modal="true"`、由 `aria-labelledby` 指向的标题可读，正文里有类别 `SHELL`、
  风险 `high`、资源、命令与理由五件；四个回答都在；点「拒绝」后弹窗**消失**，
  事件流里出现 `permission.resolved{requestId:'req-1',decision:'deny'}`；撤销规则后规则列表真的少一行。

这一轮写这些断言时抓到的缺陷在 **fixture**，不在产品：`permissions.respond` 返回成功却什么事件都不发，
于是 `dev:web` 里点「拒绝」弹窗不动（`usePermissionQueue` 要等 `permission.resolved`，真机 Host 会发，
fixture 不发），第五个状态因此根本没法人工走查完；`revokeRule` 同样返回成功但规则还在。
两处都改成了真的写：发一条带连续 `seq` 的 `permission.resolved`（`events.since` 回放也看得到），撤销真的删行。

**仍未做**：人眼对**视觉**的判断（空态的引导语是否够醒目、失败信息的排版是否压过内容、长中文在窄窗口是否撑破）。
DOM 断言证明「该有的字在屏上、不该有的不在」，证明不了「看上去像不像首启」。这一条留给 Windows 桌面的
一次完整走查，和上表那一行一起记。

## 发布前必须满足

- 上表至少有一行来自 **Windows 桌面**，覆盖步骤 1–6。
- 任何一步写的是「阻塞」或「未跑」，发布说明里就得如实写出来，不能当作通过。

## 已发布的 feed 本身（2026-11-04，`scripts/verify-release-feed.mjs`）

上面每一行问的都是「应用在真机上做了什么」。这一行问的是另一件事：**发布出去的那份 feed 文档本身对不对**。
README 中英两半都写着「安装包必须带 `sha256`，没有哈希就不会安装」，`update-feed.ts` 也真的这么执行，
`tests/contract/update-integrity.test.ts` 钉住了它——但这些说的都是**代码**，没有一条在检查**发布出去的字节**。

在能连 `github.com` 的机器上跑：

```bash
npm run typecheck
node scripts/verify-release-feed.mjs
```

2026-11-04 对 `v1.0.0` 的真实结果（退出码 1）：

```
feed: https://github.com/castorhrio/jev-pi-agent/releases/latest/download/update-feed.json
version: this build is 1.0.0
[FAIL] no-sha256: the feed publishes no sha256, so the app refuses to install what it downloads — null
[warn] no-size: the feed publishes no size, so a truncated download is only caught after hashing — absent
[FAIL] installer-latest-url: the installer URL uses releases/latest, which 404s once a newer release exists
FAIL — 2 failure(s), 1 warning(s)
```

发布出去的 `update-feed.json` 只有 `version` / `notes` / `url` 三个字段。这意味着：

- **版本检查读得动，安装读不动。** 应用读这份 feed 会答「已是最新版本」，所以缺陷在「已发布版本 == 已安装版本」
  期间完全看不见；等 1.1.0 发布的那一天，每个用户的检查都会说「发现新版本」，下载跑完，
  `verifyInstaller()` 以 `no-hash` 拒绝——更新通道对所有人同时坏掉，而那一刻没人在看 feed。
- **`releases/latest/download/UCAD-Setup-1.0.0.exe` 是 `make-update-feed.mjs` 开头专门警告过的坑**：
  `latest` 指向最新 release，1.1.0 一发布，这个 URL 就 404。

修法就是仓库里已有的那条命令（它会把哈希算进文档、并把 URL 钉到 `v<version>` 的 release）：

```bash
node scripts/make-update-feed.mjs --version 1.0.0 \
  --installer release/UCAD-Setup-1.0.0.exe \
  --out release/update-feed.json
```

然后把 `release/update-feed.json` 作为 release asset 覆盖上传。**本轮没有做这一步**：覆盖已发布 release 的
资产需要 GitHub 写权限，本机没有 token，且 122 MB 的安装包在这台机器上下载不下来（无法重算哈希）。
所以这一条在 `docs/dod-status.md` 里记的是「红」，不是「通过」。

脚本能证明什么、不能证明什么：它证明 feed **带**哈希、哈希**是**哈希、feed 写的 `size` 与宿主实际服务的
`Content-Length` 一致、URL 钉在本次 release 而不是 `latest`。它**不**下载安装包，所以证明不了发布的哈希
就是发布文件的哈希——那是 120 MB 的读取，正确的位置是算哈希的那一步（`make-update-feed.mjs`）。

## 2026-11-03 复量：本机现在能连 `github.com`，于是把上面这条又跑了一遍

上一节写的「本机到 `github.com` 不通」是那台机器的状态。同一天晚些时候网络通了，重跑：

```
$ npm run typecheck            # 只为拿到 apps/desktop/dist/main/update-feed.js
$ node scripts/verify-release-feed.mjs
feed: https://github.com/castorhrio/jev-pi-agent/releases/latest/download/update-feed.json
version: this build is 1.0.0
[FAIL] no-sha256: the feed publishes no sha256, so the app refuses to install what it downloads — null
[warn] no-size: the feed publishes no size, so a truncated download is only caught after hashing — absent
[FAIL] installer-latest-url: the installer URL uses releases/latest, which 404s once a newer release exists — https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe
FAIL — 2 failure(s), 1 warning(s)
```

退出码 1，与上一节一致——变的不是结论，是**证据的来源**：这次 feed 与安装包 URL 都真的取到了
（`HEAD` 回 200），所以「红」不再依赖一台连不上网的机器的转述。

顺带把「修好之后长什么样」也量了出来，用的是 GitHub 自己对该资产的陈述，不是人抄的哈希：

```
host asset: sha256:76bbe0c612ac67575ac40a543929a7691ba9f9e185343297cbc3badda9ea5a48  size 122806279
HEAD https://github.com/castorhrio/jev-pi-agent/releases/download/v1.0.0/UCAD-Setup-1.0.0.exe
  → 200, content-length: 122806279
```

把这三个数（URL 钉 `download/v1.0.0/`、`sha256`、`size`）写成修正版文档，交给同一套判定：

```
PASS — the corrected document produces no findings, and the host serves 122806279 bytes
hasFailure: false
```

也就是说**剩下的只有一次上传**：本机没有任何 GitHub 令牌（`gh` 也未安装），覆盖 release asset 这一步
在别处做。上传后重跑一次 `node scripts/verify-release-feed.mjs`，期望退出码 0。

### 写 feed 的那一步现在也跑同一套判定

`scripts/make-update-feed.mjs` 以前写完就退出，于是「写出来的是不是能装的 feed」由另一条命令在另一天回答。
现在它在写之前问，被拒就**不写文件**、退出码 1：

```
$ node scripts/make-update-feed.mjs --version 1.0.0 --installer /tmp/feeddemo/UCAD-Setup-1.0.0.exe \
    --url https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe \
    --out /tmp/feeddemo/update-feed.json
[FAIL] installer-latest-url: the installer URL uses releases/latest, which 404s once a newer release exists — https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe

refused: /tmp/feeddemo/update-feed.json was not written — the app's own feed check rejects this document.
Fix the URL (a release tag, not `latest`) or the version, then run this again.
$ echo $?
1
```

这就是 v1.0.0 那份文档的 URL 形状：以前它能被原样写出来，现在写不出来。
默认参数（`releases/download/v<版本>/UCAD-Setup-<版本>.exe`）照旧通过，并把校验命令的提醒一起打出来。
门禁：`tests/contract/feed-writer.test.ts` 12 项（判定四种错法各一条、线上 v1.0.0 文档一条、
源码线序一条、CLI 退出码与「不落文件」两条）。
