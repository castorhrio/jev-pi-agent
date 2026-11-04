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

## 如何从 Windows 机器带回证据

步骤 1–5 的跑分可以**带回**：`--report <路径>` 把每一步的 `[ok]` / `[FAIL]` / `skip` 与它自己记下的
证据行写成一份结构化 JSON。于是「在 Windows 上跑过」不必靠转述——跑的人复制一个文件回来，
读的人拿到的是判定和产生判定的那几行原文。

### 把仓库交到 Windows 机器上的最短路径（逐条可复制）

下面这一节假定你面前只有一台 Windows 机器和一个浏览器：没有克隆、没有依赖、没有构建产物。
在 PowerShell 里逐条复制（`cmd` 下把前两行拆成 `git clone …` 与 `cd jev-pi-agent`）：

```powershell
git clone https://github.com/castorhrio/jev-pi-agent.git
cd jev-pi-agent
npm install
npm run package
node scripts\verify-main-chain.mjs --exec release\win-unpacked\UCAD.exe --report win-report.json
```

每行的作用只有一件：`npm install` 装依赖（需要 Node.js 22.12 或更新）；`npm run package` 产出
`release\win-unpacked\UCAD.exe`（`--exec` 指的就是它，Windows 上的默认值也是这个路径）；
最后一行跑步骤 1–5，把每一步的判定与它自己记的证据行写成 `win-report.json`——它**不上传任何东西**，
报告就是仓库根目录里的一个文件。跑之前不需要令牌、不需要联网（步骤 4 有网时才有「真实网络」那半句）。

把 `win-report.json` 原样带回，放到 `docs/manual-verification/win-YYYYMMDD.json`，
并在下面的表里追加一行指向它（`结果 / 证据` 写 `见 docs/manual-verification/win-YYYYMMDD.json`，
再补一句结论）。文件长这样：

```json
{
  "platform": "win32",
  "build": { "executable": "…\\UCAD.exe", "version": "1.0.0", "sizeBytes": 122806279, "modifiedAt": "…" },
  "ranAt": "…",
  "steps": [
    { "n": 1, "verdict": "pass", "evidence": ["1:turn 1 renderedHash=80e256b63523731c…"] },
    { "n": 2, "verdict": "fail", "evidence": ["2:table rows=0"] },
    { "n": 5, "verdict": "skip", "evidence": ["(not requested in this run)"] }
  ],
  "note": "…"
}
```

三件必须知道的事：

- **门禁只保证格式可回传，不保证内容为真。** `tests/contract/verify-main-chain.test.ts` 断言
  `platform` / `build` / `steps` 三键都在、每步都有 `verdict` 与 `evidence`；它无法证明这些步骤
  真的在 `platform` 写的那台机器上跑过。这句话也写在 JSON 自己的 `note` 字段里，因为读这份文件的
  人正是它要保护的人。
- **`verdict: "fail"` 的报告照样要带回。** 一份红的报告是结果，不是一次失败的上传；把它改成绿才是。
- **被阻塞的运行（退出码 2）不写报告。** 钥匙串不可用时应用在开窗之前就停下，那一段
  `[BLOCKED] …` 的控制台原文就是证据，请连同它一起贴回来。

### 带回之后怎么判（读的人跑这条，不必读 JSON）

```bash
node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json
```

退出码 0 有五个意思同时成立：这份报告覆盖了 step 1–5、自报平台是 `win32`、`build.version` 等于本仓库当前版本，
且**每一步 `pass` 都带着它自己记的证据行**——不是只有五个「pass」。五条各自会红，且各有一句话：
写在别的平台上（`a run on another platform is a real result about that platform`）、
某一步 `fail`（`row stays open`）、某一步 `skip`（`was not run`）、报告里没有这一步（`is not in the report`）、
某一步说 `pass` 却没有证据行（`a claim, not a result`）。
它会先打印每一步的 `verdict` 再给结论，所以读的人不必打开 JSON。

第五条是**这份报告唯一能被查的**那件事：报告是文档，文档可以手写，所以「这些步骤真的跑过」证明不了；
但「说 pass 却什么都没记」可以拒。真正的运行里，一步只有先 `record()` 过才会 `pass()`，所以这条规则
不会冤枉真跑的报告；而手写五行 `pass` 会被拒，不再和一份真报告长得一样。

它判的是**文件里写了什么**，不是这次运行真的发生过——报告是文档，文档可以手写，这句话在
`judgeReport()` 的注释里、在报告自己的 `note` 字段里、也在这条命令的输出里。它也不能替 step 6 收口：
五态是人眼走查，任何报告都关不掉那一行。判定规则由 `tests/contract/win-report.test.ts` 双向钉住，
`buildReport()` 写出的报告必须被判绿（写与判不能各说一套）。

`--report` 与 `--json` 是两件事：`--json` 是给脚本读的原始证据流（含 `boot:` 行与失败列表），
`--report` 是给人读的、按步骤归位的判定。两者都不改变退出码。

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
| 2026-11-04 | Linux x64（Ubuntu 26.04，headless + `xvfb-run`，**真实 Chromium**） | `HEAD` 源码（`npm test` 的布局门禁 `tests/contract/layout.test.ts`） | 步骤 6 五态（机器走查 + 截图落盘） | **通过（可测量部分）**：33 项全绿，五态在 1440×900 与 768×700 各量一次（不横向溢出、不塌缩、不裁字、控件不出屏、不压字、无控制台错误）。截图落盘：`docs/screenshots/states/loading.png`、`states/partial.png`、`states/permission.png`（1440×900，与产品开窗尺寸一致），首启与失败态沿用 `docs/screenshots/empty.png`、`error.png`。**人眼观感仍未做**，见步骤 6 末段 |
| 2026-11-04 | Linux x64（Ubuntu 26.04，headless） | `HEAD` 源码 | 步骤 1–5 的**证据回传通道** | **通过（通道本身，不是一次 Windows 跑分）**：`scripts/verify-main-chain.mjs --report <路径>` 写出的 JSON 含 `platform` / `build` / `steps` 三键，每步带 `verdict`（`pass` / `fail` / `skip`）与它自己的 `evidence` 行；`tests/contract/verify-main-chain.test.ts` 新增 7 项钉住形状（含「同一步里 pass 不许盖住 fail」「被请求却无判定按 fail 计」「未请求的步骤记 skip」）。**Windows 六步仍未跑**，这一行只证明「跑一次的输出可以被人从 Windows 机器带回」 |

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

**实测（2026-11-04，机器走查 + 截图落盘）**：这一轮把「五个状态长什么样」从「只有断言」变成「有图可看」。
`xvfb-run -a npx vitest run tests/contract/layout.test.ts` 33 项全绿，五态在真实 Chromium 里各拍一张
1440×900（与 `bootstrap.ts` 的开窗尺寸一致），其中三张此前**从未在仓库里出现过**，已提交：

| 状态 | 图 | 这一张证明什么 |
|---|---|---|
| 首启 | `docs/screenshots/empty.png` | 引导语 + 三步在屏上，会话列说的是「还没有会话」，没有「加载中…」 |
| 加载 | `docs/screenshots/states/loading.png` | 读取未返回的那一帧：会话列与对话区都在说「加载中…」，**不**说「还没有对话」 |
| 失败 | `docs/screenshots/error.png` | 标题「出错了」+ 原始失败文本 + 「重试」按钮，不是空面板 |
| 部分失败 | `docs/screenshots/states/partial.png` | 项目名在屏上，会话列说「会话列表读取失败（不是空的）」并带原因 |
| 权限 | `docs/screenshots/states/permission.png` | 弹窗五件可读（类别 `SHELL` / 风险 `high` / 资源 / 命令 / 原因），四个回答都在 |

图是门禁拍的，不是手绘也不是 mock：`npm test` 的布局门禁把每个 target 的截图写进 `.run-logs/layout/`
（该目录被忽略），上面五张是从那里挑出来提交的，所以**任何人重跑一次都能得到同一批图**。
`tests/contract/screenshots.test.ts` 现在还会比对「图与渲染层源码是否同步」：
`docs/screenshots/sources.json` 记着每张图与每个渲染层源文件的 sha256，改了组件没重拍图就是红
（`node scripts/screenshot-sources.mjs --check` 报告漂移并指名文件、退出 1，`--write` 记录一次确认）。
`--check` 与默认行为是同一个判定，写出来是为了让「这条命令会不会改文件」在命令本身里就有答案；
`--check --write` 同时给会被拒绝，而不是按先后顺序挑一个。

**仍未做**：人眼对**视觉**的判断（空态的引导语是否够醒目、失败信息的排版是否压过内容、长中文在窄窗口是否撑破）。
上面五张图让这件事**可以远程做**——把图发给任何一个人看，他就能回答这三问，不必先装应用；
但「有人真的看过并签了字」这件事，本轮仍然没有发生，所以这一条不算通过。
DOM 断言证明「该有的字在屏上、不该有的不在」，证明不了「看上去像不像首启」。这一条留给 Windows 桌面的
一次完整走查，和上表那一行一起记。

**这一条现在可以交接了**：要回答的问题写在 `docs/state-walkthrough.md`——每态三条能用「是 / 否」回答的判据，
每条锚在屏幕上真的会出现的字上（取自 `apps/desktop/src/shared/i18n.ts`），外加一张记录表。
表里出现一行带日期的记录，就是一次签字；`tests/contract/state-walkthrough.test.ts` 把两件事绑在一起：
表里没有带日期的一行时，README 中英两半都必须仍然写着「没人看过」；一旦签了字，README 必须带上那个日期。
所以「走查过了」和「README 还道着歉」不会同时存在，反过来也一样。

窄窗口的**可测量**那一半已经不再是「仍未做」：五态现在在两个尺寸上被真实布局引擎量过——
`state-<name>`（1440×900）与 `state-<name>-tight`（768×700，产品允许的最小窗口），
不横向溢出、不塌缩、不裁字、控件不出屏、不压字这五条对窄窗口同样成立（见 `docs/dod-status.md`）。
人眼要回答的因此缩成「观感」：引导语是否醒目、失败信息的层级是否压过内容、窄窗口里中文断行读起来是否别扭。

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

## 2026-11-04 深夜：主机不应答时，命令说的是「没跑完」而不是「feed 坏了」

这一节记的是**命令自己的输出**，不是应用的行为。本机到 release 主机的路由时通时不通，不通的那次
`node scripts/verify-release-feed.mjs` 打印的是：

```
[FAIL] feed-unreachable: the feed could not be fetched, so every update check fails — This operation was aborted
FAIL — 1 failure(s), 0 warning(s)
```

同一台机器上 `curl -sSL` 对同一个 URL 挂满 90 秒、一个字节也没回来（`exit=124`），所以那 20 秒里
什么都没读到——「feed 是坏的」这个结论没有依据。修完之后，同样的情形（本地起一个只接受连接、
永不回话的 TLS 主机，`--timeout 400`）打印的是：

```
feed: https://127.0.0.1:35517/update-feed.json
version: this build is 1.0.0
[FAIL] feed-timeout: the feed host did not answer in time, so nothing about the document was judged — a host result, not a verdict on the feed — no answer within 400ms — https://127.0.0.1:35517/update-feed.json (retry with --timeout <ms> if the host is slow)
INCOMPLETE — the host did not answer, so this is not a verdict on the feed; 1 failure(s), 0 warning(s)
```

退出码仍是 1（没看到就不能算绿），但词换了：`INCOMPLETE` 说的是「这次没跑完」，`FAIL` 说的是
「文档有问题」。路由恢复后对**线上那份 v1.0.0 feed** 重跑，输出仍是上一节那三行（`no-sha256` /
`no-size` / `installer-latest-url`，`FAIL — 2 failure(s), 1 warning(s)`，退出码 1）——也就是说
这一轮改的是**误诊**，不是结论：发布出去的 feed 仍然缺哈希，仍然只差一次上传。

**仍未做**（与上一节相同，不假装完成）：上传修正版 feed（本机无 GitHub 写权限令牌）、
Windows 桌面六步（无 Windows 机器）、步骤 6 的人眼视觉走查（无真机）。

## 2026-11-04：首屏与五态截图（发布前产品收口）

这一轮不改产品行为，只补「读者能看见的东西」，并把一处已发布版本的破绽写进产品自述。

1. **README 首屏从规格书改成产品**（中英各一段，具名 pass：clarify + quieter）：
   开篇不再是「两个问题 + 十条能力」，而是一段场景（三个 Agent 在同一个仓库上，
   一个改了你没料到的文件，而屏幕说不清它收到了什么、为什么走这条路），
   接一句电梯陈述（可核对的注入字节 + 可解释的路由），能力清单原样保留、退到第二屏。
   事实段一个字没动：`readme-parity` / `readme-update-parity` / `scenario-states` 仍绿。
2. **空态与失败态第一次出现在 README 里**：`docs/screenshots/empty.png`、
   `docs/screenshots/error.png` 取自布局门禁在真实 Chromium 里拍的那两张
   （`npm test` 的 `layout.test.ts` 会把每个 target 的截图写进 `.run-logs/layout/`，
   文件名形如 `state-empty-chat.png`，1440×900，与产品开窗尺寸一致）。
   门禁：新增 `tests/contract/screenshots.test.ts`——README 展示的每张图必须存在、
   是 PNG、且尺寸等于 `bootstrap.ts` 里 `createWindow()` 的开窗尺寸；空态与失败态必须被展示。
   红测证明：把 `empty.png` 换成 100×100 的图，该用例报
   `docs/screenshots/empty.png is 100x100 and the app opens at 1440x900`。
3. **已发布 v1.0.0 feed 缺 `sha256` 这件事写进 README 的「当前局限」**（中英各一条，
   并进 `readme-parity.test.ts` 的 `LIMITATIONS` 表）。本机仍无 GitHub 写权限令牌、
   `gh` 未安装，覆盖 release asset 这一步**仍未做**——所以它现在是一条产品自述里的
   已知缺陷，而不是只躺在 `docs/` 里的一句话。1.1.0 发布前必须修掉。

**仍未做**（不假装完成）：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼观感走查（无真机）。

## 交接：上传修正版 feed（唯一剩下的红，需要写权限）

这一节写给**下一个拿到令牌的人**，不是写给「原班人马」。它是一行可执行的交接：
变量名、命令、期望输出、失败时贴什么。做完之后要改的地方也写在下面。

**为什么还没做**：本机没有任何 GitHub 写权限令牌（`GITHUB_TOKEN` / `GH_TOKEN` 都未设置），
`gh` 也未安装。这不是「不知道怎么修」——修正版文档 `docs/release/update-feed-v1.0.0.json`
早就提交在仓库里，且被应用自己的规则判为零 finding。

**谁持有**：仓库 `castorhrio/jev-pi-agent` 的 release 写权限（`contents: write` 的 PAT 或
GitHub App token）。持有者只需要跑一条命令，不需要克隆之外的任何准备。

### 谁有 token 谁跑这两条（先看后按）

**命令**（在仓库根目录，`npm install` 之后；两条都是复制就能跑的形状）：

```bash
node scripts/publish-feed.mjs --dry-run                                    # 先看：上传什么字节、落到哪个 URL、跑哪几条判定
GITHUB_TOKEN=<有 contents:write 的令牌> node scripts/publish-feed.mjs --apply --verify
```

第一条**不联网、不写文件、不上传**——它把第二条要做的事按顺序打印出来，包括判定在哪一步跑。
有了它，「先看后按」是一条命令，不是一句叮嘱；`--dry-run` 与 `--apply` 同时给会被**拒绝**
（同时要两件相反的事的调用方并不知道自己要什么，替它挑一个就是让发布步骤真的跑起来）。
第二条的 `--verify` 会在上传后**再跑一次** `verify-release-feed.mjs`，所以「修好了」是这条命令的输出，
不是一句声明。

**期望输出**（最后一行是判据）：

```
feed: docs/release/update-feed-v1.0.0.json (431 bytes)
version: 1.0.0
installer: UCAD-Setup-1.0.0.exe (76bbe0c6…, 122806279 bytes)
target: update-feed.json on castorhrio/jev-pi-agent v1.0.0
…
PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=76bbe0c6…
```

2026-11-04 本机跑 `--dry-run` 的完整输出（无令牌，未上传；`installer:` 一行的哈希在此缩写）：

```
feed: docs/release/update-feed-v1.0.0.json (431 bytes)
version: 1.0.0
installer: UCAD-Setup-1.0.0.exe (76bbe0c6…, 122806279 bytes)
target: update-feed.json on castorhrio/jev-pi-agent v1.0.0
[plan] check 1 (already ran, before any token was read): the app’s own feed rules — docs/release/update-feed-v1.0.0.json produced no failure
[plan] check 2: the host’s digest for UCAD-Setup-1.0.0.exe equals the feed’s sha256/size, before anything is deleted
[plan] check 3: node scripts/verify-release-feed.mjs on the published bytes — waits for a real upload, so this run only plans it
[plan] GET https://api.github.com/repos/castorhrio/jev-pi-agent/releases/tags/v1.0.0
[plan] compare the feed’s sha256/size with the host’s digest for UCAD-Setup-1.0.0.exe
[plan] DELETE https://api.github.com/repos/castorhrio/jev-pi-agent/releases/assets/<existing update-feed.json id> (if present)
[plan] POST https://uploads.github.com/repos/castorhrio/jev-pi-agent/releases/<release id>/assets?name=update-feed.json
[plan] token: none — --apply needs GITHUB_TOKEN or GH_TOKEN

dry run — nothing was fetched and nothing was uploaded. Add --apply to replace the asset.
```

退出码 0。这三条 `check` 行是计划的另一半：只写「要删哪一行、要 POST 到哪」的计划，读到的人还得去
另一份文档里找「怎么才算修好了」。

**失败时贴什么**（原样贴进本文件，不要转述）：

- `token: none — --apply needs GITHUB_TOKEN or GH_TOKEN` → 令牌没传进环境，不是权限问题。
- `the host disagrees about the installer` → 宿主对 `UCAD-Setup-1.0.0.exe` 的 digest 与 feed 里的
  `sha256`/`size` 不一致；**不要**改 feed 去迁就，先查这个资产是不是被替换过。
- `401` / `403` → 令牌没有 `contents: write`，或已过期。
- `INCOMPLETE — the host did not answer` → 网络问题，重试；**这不是对 feed 的判决**。

**做完之后要改的三处**（一次改完，别只改一处）：

1. 本文件：把上面那次运行的完整 stdout/stderr 追加成一节（含 `PASS —` 那一行）。
2. `docs/dod-status.md`：「Windows 安装包航运 · 随包 feed 真实网络」那一行从**红**改成**有证据**，
   证据写 `node scripts/verify-release-feed.mjs` 退出码 0。
3. `README.md` 中英两半的「当前局限」里那条「v1.0.0 的 feed 缺 sha256」——修掉之后它就不再是局限，
   删掉它，并同步 `tests/contract/readme-parity.test.ts` 的 `LIMITATIONS` 表（那张表会打红提醒）。

**不要**为了让它变绿而降低门槛：不许允许无 digest 上传，不许把 URL 放回 `releases/latest`。
`scripts/publish-feed.mjs` 在找令牌**之前**先跑判定，就是为了让「有凭据的人」也发不出一份应用会拒绝的文档。
