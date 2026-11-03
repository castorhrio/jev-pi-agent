# DoD 现状对照（2026-11-03）

`docs/PRODUCT-DOD.md` 是锁定稿，不改它；这里逐条写**现在到哪一步、证据在哪、还差什么**。
勾选只代表「有可复现的证据」，不代表「已过线」——过线由审查侧判定。

| DoD 条目 | 现状 | 证据 | 还差什么 |
|---|---|---|---|
| 可证明注入 | **有证据** | Context Pack 纯函数 + 内容哈希；真机步骤 1 通过：`renderedHash=80e256b63523731c…`，同一轮重读同哈希，任务描述多一个字符变 `673b97ec35b5…`，注入原文与 `estimate="heuristic_chars_div_4"` 同屏（`docs/manual-verification.md` 2026-11-03 行） | Windows 桌面复跑一次 |
| 可解释路由 | **有证据** | 真机步骤 2 通过：7 行决策各带 rationale / confidence / 引擎，回落如实记录；`tests/contract/decision-chain.test.ts` 钉住链与实跑一致 | Windows 桌面复跑一次 |
| 权限门不可绕 | **有证据（自动化 + 五态断言）** | 执行前允许/拒绝进事件流，审计可查；`tests/contract/permission-*.test.ts`、`tests/e2e/critical-path.e2e.test.tsx`；步骤 6 的权限弹窗已进 `tests/e2e/scenarios.e2e.test.tsx`（类别/风险/资源/命令/理由五件可读，四个回答都在，点拒绝后弹窗消失且事件流里出现 `permission.resolved`） | 真机上的**视觉**走查（排版、长中文、窄窗口）仍未做 |
| Windows 安装包航运 · NSIS 产出与安装 | **未验证** | `npm run dist` 走 electron-builder 的 `nsis` 目标（`package.json` 的 `build.win`），产物 `UCAD-Setup-<版本>.exe`；未签名 | **Windows 桌面**：装一次、过 SmartScreen、把提示原文记进 `docs/manual-verification.md` |
| Windows 安装包航运 · 随包 feed 真实网络 | **红（已量到，未修）** | 在能连 `github.com` 的机器上跑了随包 feed：`node scripts/verify-release-feed.mjs` 退出码 1，`no-sha256` + `installer-latest-url`（见 `docs/manual-verification.md` 末节）。发布出去的 `update-feed.json` 只有 `version`/`notes`/`url`，没有 `sha256`/`size`，URL 用的是 `releases/latest` | 用 `make-update-feed.mjs` 重算并覆盖上传 release asset（需 GitHub 写权限 + 安装包本体）；之后重跑脚本应为 0 |
| Windows 安装包航运 · 拒绝路径（明文 / 非 URL） | **有证据** | 真机步骤 4：明文覆盖 → `检查更新失败: 更新源必须使用 https…`，日志 `update feed ignored: …`；`tests/contract/update-feed.test.ts` | — |
| 门禁即 DoD | **有证据** | `npm run typecheck && lint && knip && test && test:e2e` 全绿；注入/交接/凭据/更新合约测试能打红 | CI 等价跑一次留档 |
| 诚实估计与凭据 | **有证据** | 估算来源上屏（`heuristic_chars_div_4`）；凭据只进 OS 钥匙串，钥匙串不可用时启动即停并给平台补救话（`apps/desktop/src/main/keyring-gate.ts`，`tests/contract/keyring-gate.test.ts`） | Windows DPAPI 路径真机确认 |

## 本轮据此做的两件事

1. **真机主链路取证**：Linux 桌面会话（`dbus-run-session` + `gnome-keyring` + `xvfb-run`，
   声明 `XDG_CURRENT_DESKTOP=GNOME`）跑通步骤 1–4，记录进 `docs/manual-verification.md`。
2. **把「跑一次」变成命令**：`scripts/verify-main-chain.mjs` 修掉两处就绪竞态
   （窗口挂载 ≠ 应用可用；设置面板按钮晚一拍出现），并加 `--feed-url`，
   让「随包 feed 所在主机不可达」的机器也能跑真实网络分支，且记录用的是哪个 URL。

## 本轮修的缺陷：「退出应用」点 × 不退

步骤 5 抓到的那个缺陷已修，改动只在两处判定的**所有权**上，没有新功能：

- `apps/desktop/src/main/tray-icon.ts` 新增 `decideAllWindowsClosed()`：最后一个窗口关掉时
  该不该退，由它回答，且它把**用户在设置里选的那一项**算进去。原来
  `bootstrap.ts` 里只有一句 `platform !== 'darwin' && !trayUsable`，问的是「有没有托盘」，
  于是「关闭窗口时 = 退出应用」在有托盘时恰好得到相反答案：窗口关掉、进程留在后台、
  托盘里的「显示主窗口」指向一个已经不存在的窗口。判定抬头写明：`quit` 压过托盘，
  macOS 的 Dock 惯例只是默认值——用户选了退出，macOS 上也一样退。
- 同一个「退了但没退」的另一端：`before-quit` 以前无条件 `preventDefault()` 再等
  `ucad?.dispose()`，容器还没建起来时那个 promise 永远不会被创建，退出被取消且不再重发
  （启动中收到一次 SIGTERM 就够）。现在没有容器就直接放行。
- `tests/contract/tray-icon.test.ts` 的 `the last window is gone` 五条钉住判定本身，
  `the last-window rule is wired into the lifecycle` 三条钉住接线：`window-all-closed`
  必须走 `decideAllWindowsClosed(`，且**那句只问托盘的表达式不许再出现**，
  `before-quit` 的容器检查必须在 `preventDefault()` 之前。回到旧写法会打红，不必等真机。

门禁：`npm run typecheck && npm run lint && npm run knip && npm test && npm run test:e2e` 全绿
（`test` 与 `test:e2e` 在有显示的环境下跑，`tests/contract/layout.test.ts` 需要 X）。

## 本轮补上的两件事（2026-11-03 晚）

1. **步骤 5 的真机行补上了**：`npm run package` 这次正常退出（上一轮的卡住未复现），
   `dbus-run-session` + `gnome-keyring` + `xvfb-run` 下 `--steps 5` 退出码 0，两条分支都 `[ok]`：
   「隐藏到托盘」关窗后进程仍活、窗口不在屏上；「退出应用」`process exited, code 0`。
   上一轮那个「点了退出但没退」的缺陷在真机上确认已修。记录在 `docs/manual-verification.md`。
2. **托盘菜单从「目视」变成「断言」**：菜单行搬进 `tray-icon.ts` 的 `buildTrayMenuTemplate()`
   （纯函数，动作注入），`bootstrap.ts` 建完菜单后把 `trayMenuLabels(template)` 写进日志
   （`tray menu built`），`scripts/verify-main-chain.mjs` 的步骤 5 读那一行断言三项都在。
   真机输出：`items=["显示主窗口","打开项目…","设置","退出 UCAD"]`。
   宿主没有通知区时脚本记下应用自己说的 `tray unavailable` 而不是打红——那种机器上确实没有菜单可查。
   门禁：`tests/contract/tray-icon.test.ts` 钉住模板内容与接线（建菜单走 `buildTrayMenuTemplate`、
   日志在 `setContextMenu` 之后），`tests/contract/verify-main-chain.test.ts` 钉住
   `trayMenuVerdict()` 的三种结局（缺项打红 / 无托盘放行 / 静默打红）。
3. **`window-all-closed` 的时序承诺变成红测**：`tray-icon.ts` 文档里写着「退出期间可以不读
   preference（store 可能已关）」，现在 `tray-icon.test.ts` 断言调用点确实是
   `preference: isQuitting ? 'quit' : closePreference()`，且 `closePreference()` 在处理器里只出现一次。

## 本轮（2026-11-03 夜）门禁侧的两处收口

1. **`scripts/verify-main-chain.mjs` 的失败语义**：`--steps` 以前把看不懂的 token 丢掉、
   剩下的照跑，于是 `--steps 6` 会启动应用、一步不驱动，然后以
   `PASS — steps 6 recorded above` 结束——这是「沉默即通过」，与 DoD「门禁即 DoD」相反。
   现在 `parseSteps()` 认 1–5（步骤 6 属 `npm run dev:web`，请求它直接拒绝并退出 1），
   并且 `stepCoverage()` 会把「既没 `[ok]` 也没 `[FAIL]`」的被请求步骤按失败计。
   步骤 2 的「引擎链」行以前只记录不判定（标题改了或面板没渲染都算过），现在缺了就是红。
   `tests/contract/verify-main-chain.test.ts` 双向钉住声明与实际 `wants(n)` 派发。
2. **根目录陈旧产物**：`03f8135` 误提交的 `bootstrap.js` 与
   `apps/desktop/dist/main/bootstrap.js` 逐字节相同，且没有任何地方引用它——它只是让审查者
   在「入口点该在的位置」读到一份不再更新的副本。已删除，`.gitignore` 补上根目录的
   `bootstrap.js`/`.map`，并由 `tests/contract/repo-root.test.ts` 钉住：入口点必须在 `dist/` 下、
   根目录不得有同名的编译副本、根目录不得提交任何编译产物。

## 本轮（2026-11-03 深夜）步骤 6：五个界面状态进门禁

DoD 的「步骤 6 人工走查」以前只有 fixture 的**接口完整性**测试（`fixture-bridge.test.ts`）与
happy path（`critical-path.e2e.test.tsx`），五个状态各自画了什么，没有任何断言——
一个空白面板、一个把未到达的历史写成「还没有对话」的加载窗口，都是绿的。

`tests/e2e/scenarios.e2e.test.tsx` 把清单上那四句问题变成断言，逐状态回答：
`empty` 有引导语与三步且没有「加载中」；`loading` 在读取尚未返回的那一帧拍照，两处都在说加载中且**不**说「还没有对话」；
`error` 有标题、fixture 的原始失败文本与重试按钮；`partial` 保留健康面板、会话列说「读取失败」并带原因；
`permission` 的弹窗五个字段可读、四个回答都在、点「拒绝」后弹窗消失并且 `permission.resolved` 进了事件流。

写这批断言时抓到的缺陷在 **fixture 不是产品**，但正是它让人工走查走不完：

- `permissions.respond` 返回成功却**不**发 `permission.resolved`。`usePermissionQueue` 等这条事件才让请求落地
  （真机 Host 会发），所以 `dev:web` 里点「拒绝」弹窗一动不动，点第二次也一样——安全回路在唯一能看它的地方看起来是坏的。
  现在它按同一套连续 `seq` 发事件，`events.since` 回放也看得到这次决定：决定是日志的一部分，不是只改 UI。
- `permissions.revokeRule` 返回成功但规则还在。现在真的删行，面板重读时那行确实消失。

两处合起来才是「允许/拒绝都能走」；只改其中一处，另一个仍然在说谎。
门禁：`npm run test:e2e` 147 项全绿（新增 6 项），`npm test` 1186 项全绿（`layout.test.ts` 需 X，`xvfb-run` 下过）。

## 本轮（2026-11-04）五个界面状态在真实布局引擎里被测量

步骤 6 的五态以前有两条通道：happy-dom 里断言「每一态画了什么」（`scenarios.e2e.test.tsx`），
真实 Chromium 里量几何的 `layout.test.ts` 却只量了 default。门禁把五态当五份状态名，
写在三处：fixture 的 union + 数组、E2E 的 mount 列表、探针 target 的 `?scenario=`。
改一处忘两处不会红——这正是它五轮没被人看过的原因。

1. **状态名收敛成一份事实**：`apps/desktop/src/renderer/src/dev/scenarios.ts` 导出
   `SCENARIOS` / `STATE_SCENARIOS` / `IN_FLIGHT_SCENARIO` 与 `scenarioFromLocation()`，
   类型由数组派生（`as const` + `satisfies`），所以「加到 union 没加到数组」现在编译不过。
   `tests/contract/scenario-states.test.ts` 把四个消费者钉在一起：E2E 挂载的集合、
   布局门禁 import 的常量（且 target 里不许再手写状态名）、README 中英两半（每态各两次）、
   以及 `docs/manual-verification.md` 的走查清单。
2. **`loadURL` 只有一处**：探针原来把「丢 axe、换 URL、记住当前页」三件事写在三个调用点，
   少写一行就静默地把下一个 target 量在上一页上。现在只有 `loadOnly()` 调 `loadURL`，
   复位与记录在同一处完成，契约测试断言调用点恰好一个。
3. **量得到的两个真缺陷（都在门禁侧，不是产品）**：
   - 量测脚本假定 shell 在场：`?scenario=error` 走的是 App.tsx 的 `if (fatal)` 分支，
     没有 `.project-chip`，`text(null)` 抛 TypeError，整个 target 报
     「Script failed to execute」——报的是探针，不是屏幕。`text()` / `visible()` 现在接受缺失元素。
   - 控制台错误被记到了错误的帧上：`consoleErrors` 累积整轮，每个结果带的是「到目前为止」，
     于是真正抛错的那一帧干净、后面每一帧背着同一条错。现在每个 target 开始时快照长度，
     归属还原为「这一帧在屏上时发生的事」。
4. **五态进几何门禁**：`state-<name>` target 由 `STATE_SCENARIOS` 生成，五条内容断言
   （量到的正是它自称的状态、empty 没有会话行且 chip 是「打开项目文件夹」、
   error 真的是错误面板且没有预览列、permission 真的有 `role="dialog" aria-modal` 的弹窗），
   加上现有的全部几何不变量（不横向溢出、无塌缩、无裁切、无文字叠字、无控件出屏、无控制台错误）。
   窗口级不变量对五态照旧生效；「量到的是有数据的应用」只对 happy path 的 target 成立，
   由 `POPULATED` 区分——把五态从 `GEOMETRY` 里摘掉才是错的做法。

**证明它会红**：把 `if (target.url !== loadedUrl)` 改成不重载（回到上一轮之前的写法）后，
5 条「`?scenario=X` measured another state」+ error 面板 + 弹窗 + empty 行数共 8 条断言打红；
恢复后 30/30 绿。

门禁：`npm run typecheck` / `npm run lint` / `npm test`（含 `xvfb-run` 下的
`tests/contract/layout.test.ts`，30 项）/ `npm run test:e2e` 全绿。

## 下一刀（按 DoD 未勾项）

- Windows 桌面补跑步骤 1–6（唯一硬缺口）。
- 步骤 6 的**视觉**走查（DOM 断言管不到排版与观感），在 Windows 那一行里一起记。
- 随包 feed（`github.com/.../releases/latest/download/update-feed.json`）在能连 `github.com`
  的机器上跑一次；顺带记录「版本相等 → 已是最新版本」与「版本更高 → 发现新版本」两条分支，
  后者要等一个真比 `1.0.0` 新的 release。

## 本轮（2026-11-04 深夜）发布出去的 feed 被当成被测对象

上面每一行问的都是「应用在真机上做了什么」。这一轮问的是另一件事：**发布出去的那份 feed 文档本身对不对**。

README 中英两半都写着「安装包必须带 `sha256`，没有哈希就不会安装」，`update-feed.ts` 真的这么执行，
`tests/contract/update-integrity.test.ts` 钉住了它。但这些说的都是**代码**。没有一条在检查**发布出去的字节**，
而字节才是用户的应用真正读的东西。

1. **`scripts/verify-release-feed.mjs`**：取随包 `update-config.json` 指的那份 feed，用**应用自己的规则**判它
   （`checkChannelUrl` / `normalizeSha256` 从 `apps/desktop/dist/main/update-feed.js` 导入，不写第二份），
   再对安装包 URL 发一次 HEAD，把「feed 描述的是一份真的在那里的文件」量出来而不是假定。
   退出码 0/1；`no-size` 是唯一的 warn（应用能装，只是丢掉截断检查）。
2. **量到的真缺陷**：`v1.0.0` 发布出去的 `update-feed.json` 没有 `sha256`、没有 `size`，URL 还是
   `releases/latest/download/...`。版本检查读得动，所以「已发布版本 == 已安装版本」期间完全看不见；
   等 1.1.0 发布，每个用户的下载都会被 `no-hash` 拒绝，更新通道对所有人同时坏掉。
   这一条在表里记的是**红**，不是「未验证」——差别在于现在有命令、有输出、有修法。
3. **`tests/contract/release-feed.test.ts`（24 项）**：判定的表驱动（每种错法产出指名它的 finding，
   一份正确的 feed 产出零条——不能变绿的门禁会被关掉）、词表完整性（每个 code 都有 severity 与句子，
   `no-size` 是唯一的 warn）、以及「不许重述规则」的源码扫描（脚本里不许出现 64 位十六进制模式或
   `'https:'` 比较）。安装包文件名从 `package.json` 的 `build.productName` 读，产品改名会让这里先红。

**证明它会红**：把 `judgeFeedDocument` 里的 `normalizeSha256` 判断删掉，`no-sha256` 那组立刻红；
把 `installer-latest-url` 的正则去掉，`releases/latest` 那组红。恢复后 24/24 绿。

门禁：`npx vitest run tests/contract/release-feed.test.ts` 24 项全绿；`npx eslint` 与 `npx knip` 无新增问题。
