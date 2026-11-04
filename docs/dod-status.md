# DoD 现状对照（2026-11-03）

**审查与下一轮必须先读 `docs/PRODUCT-DOD.md`**（锁定稿，不改它）；这一页只回答「现在到哪一步、
证据在哪、还差什么」，不替代它——不先读 DoD，就会把「没人记的一条」当成「没有这一条」，
未勾选项就是这么漏掉的。
勾选只代表「有可复现的证据」，不代表「已过线」——过线由审查侧判定。

**发布闸门**：`npm run dist` 会在 `electron-builder` 之前跑 `node scripts/release-gate.mjs`。
已发布的 feed 只要被判成「应用不会从中安装」（`no-sha256` / `installer-latest-url` 之类），
或压根没被量到（主机不应答、有检查被 `[skipped]` 跳过），构建就退出 1 并打印 `REFUSED`。
所以「1.1.0 不许发布」现在是一条**会红的构建**，而不是一句靠人记得的约定；判定在
`scripts/release-gate.mjs`，接线（`dist` 的顺序、`package` 不受影响、`--from-json` 不许上发布路径）
由 `tests/contract/release-gate.test.ts` 钉住。`npm run package`（免安装目录）不受影响：
它不出安装包，也不该需要 release 主机。

## DoD 逐项核对（四态，门禁钉住）

上面那张表按**轮次**记历史；这一节按 **DoD 原句**记状态，是下一轮唯一合法的范围来源。
`docs/PRODUCT-DOD.md` 的每条 `- [ ]` 在这里逐句拆开（以 `；` 为界），条目号 `DOD-<条>.<句>`。
四态只有四种：`通过`（有可复现证据）、`未过`（现在就能量到不满足）、`外部阻塞`（本机做不到，
等外部条件）、`不适用`（这一条对当前产品不成立）。**四态是证据判断，不是过线通知**——
过线仍由审查侧判定，编码侧不自报。

证据列里的每个反引号指针都必须真的存在（路径存在、`npm run …` 是本仓脚本），
`tests/contract/dod-status.test.ts` 逐行核对：少一条、改一句、写一个不存在的路径、四态合计对不上，
都会打红。所以这张表不是一段说明，是一条会红的门禁。

四态合计：通过 14 / 未过 1 / 外部阻塞 1 / 不适用 0

| 条目 | 判据（取自 PRODUCT-DOD 原句） | 四态 | 证据（路径或命令） | 还差什么 |
|---|---|---|---|---|
| DOD-1.1 | Context Pack 纯函数 + 内容哈希 | 通过 | `packages/context/src/renderer.ts` `tests/contract/injection-contract.test.ts` | — |
| DOD-1.2 | 界面可展示上一轮注入原文 | 通过 | `apps/desktop/src/renderer/src/components/ContextDrawer.tsx` `tests/e2e/critical-path.e2e.test.tsx` | — |
| DOD-1.3 | 改一字节哈希失配 | 通过 | `tests/contract/injection-contract.test.ts` `docs/manual-verification.md` | — |
| DOD-2.1 | 每次决策记录 rationale / confidence / 引擎 | 通过 | `tests/contract/decision-contract.test.ts` | — |
| DOD-2.2 | 回落记为回落 | 通过 | `tests/contract/decision-chain.test.ts` | — |
| DOD-2.3 | 设置里引擎链与实跑一致 | 通过 | `tests/contract/decision-chain.test.ts` | — |
| DOD-3.1 | 执行前有记录在案的允许/拒绝 | 通过 | `tests/integration/ui-permission.test.ts` | — |
| DOD-3.2 | 审计可查 | 通过 | `packages/permissions/src/permission-engine.ts` `tests/integration/ui-permission.test.ts` | — |
| DOD-4.1 | Releases 上 NSIS 可装 | 外部阻塞 | `package.json` `scripts/verify-main-chain.mjs` `docs/blockers.md` `docs/manual-verification/README.md` | 需要一台 Windows 机器：装一次、过 SmartScreen、跑 `node scripts/verify-main-chain.mjs` 并 `--report` 带回报告，再用 `--judge` 判成过。**照着敲的一页**：`docs/manual-verification/README.md` |
| DOD-4.2 | 更新 feed `https` + `sha256` 校验 | 未过 | `scripts/verify-release-feed.mjs` `scripts/publish-feed.mjs` `tests/contract/release-feed.test.ts` `docs/release/REPLACE-FEED.md` | 应用侧校验已绿、修正版文档已判零 finding；**发布出去的 v1.0.0 feed 仍缺 `sha256`**，需要持有 `contents: write` 的人跑 `node scripts/publish-feed.mjs`，之后 `node scripts/verify-release-feed.mjs` 退出 0。**照着敲的一页**：`docs/release/REPLACE-FEED.md` |
| DOD-4.3 | 明文/非 URL 覆盖被拒并打日志 | 通过 | `apps/desktop/src/main/update-feed.ts` `apps/desktop/src/main/update-feed-log.ts` `tests/contract/update-integrity.test.ts` | — |
| DOD-4.4 | 未签名 SmartScreen 有说明 | 通过 | `README.md` | — |
| DOD-5.1 | `npm run typecheck && lint && knip && test && test:e2e`（及 CI 等价）绿 | 通过 | `npm run verify:gates` `.github/workflows/ci.yml` `scripts/gate-local.mjs` `tests/contract/ci-gate-local.test.ts` `tests/contract/ci-typecheck.test.ts` `docs/manual-verification.md` | — |
| DOD-5.2 | 注入/交接/凭据/更新合约测试能打红 | 通过 | `tests/contract/injection-contract.test.ts` `tests/contract/handoff-chain.test.ts` `tests/contract/keyring-gate.test.ts` `tests/contract/release-feed.test.ts` | — |
| DOD-6.1 | token 来源（厂商 tokenizer vs 启发式）上屏 | 通过 | `apps/desktop/src/renderer/src/components/ContextDrawer.tsx` `apps/desktop/src/renderer/src/components/PreviewPane.tsx` | — |
| DOD-6.2 | 凭据进 OS 钥匙串，不经环境变量/日志泄露 | 通过 | `apps/desktop/src/main/keyring-gate.ts` `tests/contract/keyring-gate.test.ts` `tests/contract/secret-vault.test.ts` `tests/contract/host-secret-channel.test.ts` | — |

## 按轮次的历史对照（旧表，保留原文）

下面这张表是**上一版**的对照表，按 DoD 的六条**大项**记，每格一段历史。它不再被门禁读取
（`tests/contract/dod-status.test.ts` 只读上面那一节），保留是因为它记着每条大项背后的真机行号与
缺陷故事；**下一轮的范围来源是上面那张四态表**，不是这张。

| DoD 条目 | 现状 | 证据 | 还差什么 |
|---|---|---|---|
| 可证明注入 | **有证据** | Context Pack 纯函数 + 内容哈希；真机步骤 1 通过：`renderedHash=80e256b63523731c…`，同一轮重读同哈希，任务描述多一个字符变 `673b97ec35b5…`，注入原文与 `estimate="heuristic_chars_div_4"` 同屏（`docs/manual-verification.md` 2026-11-03 行） | Windows 桌面复跑一次 |
| 可解释路由 | **有证据** | 真机步骤 2 通过：7 行决策各带 rationale / confidence / 引擎，回落如实记录；`tests/contract/decision-chain.test.ts` 钉住链与实跑一致 | Windows 桌面复跑一次 |
| 权限门不可绕 | **有证据（自动化 + 五态断言）** | 执行前允许/拒绝进事件流，审计可查；`tests/contract/permission-*.test.ts`、`tests/e2e/critical-path.e2e.test.tsx`；步骤 6 的权限弹窗已进 `tests/e2e/scenarios.e2e.test.tsx`（类别/风险/资源/命令/理由五件可读，四个回答都在，点拒绝后弹窗消失且事件流里出现 `permission.resolved`） | 真机上的**视觉**走查（排版、长中文、窄窗口）仍未做 |
| Windows 安装包航运 · NSIS 产出与安装 | **外部阻塞（无 Windows 机器）** | `npm run dist` 走 electron-builder 的 `nsis` 目标（`package.json` 的 `build.win`），产物 `UCAD-Setup-<版本>.exe`；未签名。**回传通道已就绪**：`node scripts\verify-main-chain.mjs --exec release\win-unpacked\UCAD.exe --report win-report.json` 把每一步的判定与证据写成结构化 JSON（`docs/manual-verification.md`「如何从 Windows 机器带回证据」） | **外部阻塞（Windows 机器）**：本机没有 Windows 机器；命令与判定都已就绪，等待一台 Windows 桌面持有者执行——装一次、过 SmartScreen、跑一次带 `--report` 的六步，把 `win-report.json` 放进 `docs/manual-verification/` 并在表里加一行。**解除条件（可执行）**：`node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json` 退出 0 —— 它要求报告自报 `platform=win32`、step 1–5 全部 `pass`（`fail` / `skip` / 缺行三种情形各有一句话）、`build.version` 等于仓库当前版本，且每一步的 `pass` 都带着它自己记的证据行（说 pass 却什么都没记算 `a claim, not a result`）；判定由 `judgeReport()` 给出，`tests/contract/win-report.test.ts` 两个方向都钉住。**责任人**：发布负责人（本机无 Windows 机器，本轮**没有跑**，不假装跑过） |
| Windows 安装包航运 · 随包 feed 真实网络 | **红（已量到；外部阻塞：写权限令牌；修正版已验证干净；**绿分支已在本地托管副本上跑通**；缺陷已写进 README「当前局限」中英两条）** | 能连 `github.com` 的机器上跑 `node scripts/verify-release-feed.mjs`：退出码 1，`no-sha256` + `installer-latest-url`；发布出去的 `update-feed.json` 只有 `version`/`notes`/`url`。修正版文档（URL 钉 `download/v1.0.0/`、`sha256=76bbe0c6…`、`size=122806279`，取自 GitHub 自己给该资产的 digest，不是人抄的）用同一套判定跑出**零 finding**，宿主 HEAD 回的 `content-length` 也正是 122806279（见 `docs/manual-verification.md`） | **外部阻塞（写权限令牌）**：需要一位持有 `castorhrio/jev-pi-agent` `contents: write` 的人跑 `GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify`（先 `--dry-run` 看计划，再 `--apply`；输出请追加到 `docs/manual-verification.md`）。本机没有任何 GitHub 写权限令牌，`gh` 也未安装。**解除条件**：上传后 `node scripts/verify-release-feed.mjs` 退出 0 |
| Windows 安装包航运 · 拒绝路径（明文 / 非 URL） | **有证据** | 真机步骤 4：明文覆盖 → `检查更新失败: 更新源必须使用 https…`，日志 `update feed ignored: …`；`tests/contract/update-feed.test.ts` | — |
| 门禁即 DoD | **有证据** | `npm run typecheck && lint && knip && test && test:e2e` 全绿；注入/交接/凭据/更新合约测试能打红；发布物由 `tests/contract/release-feed.test.ts`（判定）与 `tests/contract/feed-writer.test.ts`（写之前跑判定）钉住 | CI 等价跑一次留档 |
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

## 本轮（2026-11-03 夜）写 feed 的那一步，跑读取方的检查

上一轮把「发布出去的字节」变成了被测对象：`scripts/verify-release-feed.mjs` 会取 release 上的
`update-feed.json`，用应用自己的规则判它。但那是**另一条命令**、**另一台机器**、**发布之后**的事。
真正写出那份文档的是 `scripts/make-update-feed.mjs`，而它在此之前从不问自己写出来的东西能不能装。

这不是假想的缺口，`--url` 就是那条缝：它存在是为了让镜像可用，而它同样能一字不差地写出
v1.0.0 发布的那份文档——`releases/latest/download/UCAD-Setup-1.0.0.exe`。于是错误由一个命令犯下，
由另一个命令在几天后发现。

现在判定在写之前跑：

- `make-update-feed.mjs` 把刚构好的文档交给 `judgeFeedDocument()`（`verify-release-feed.mjs` 里那一个，
  规则仍从应用自己的 `update-feed.ts` 载入），有任何 fail 就**不写文件**、退出码 1，
  并把 verifier 会打印的那几行原样打到 stderr——两条命令用同一个 `findingLine()`，不各写一套。
- 新增 `feedRefusals(document, rules)` 纯函数，测试不用 build 也不用网络就能驱动它。
  被拒的四种写法各有一条：`releases/latest`、指向别的 release 的镜像、文件名不带版本的安装包、明文镜像。
  另有一条直接喂**线上那份 v1.0.0 文档**，断言它被拒（`no-sha256` / `no-size` / `installer-latest-url`）。
- 线序也进了门禁：`tests/contract/feed-writer.test.ts` 读源码断言 `hasFailure(refusals)` 出现在
  `writeFileSync(outPath` 之前——门在写之后，拒的就是一个已经在磁盘上等着被上传的文件。

**证明它会红**：把判定整段挪到 `writeFileSync` 之后，`checks the document before anything is written to disk`
与 CLI 那条 `exits 1 for a latest URL` 同时打红（2 项）；恢复后 12/12 绿。

真实命令行（本机，v1.0.0 的 URL 形状）：

```
$ node scripts/make-update-feed.mjs --version 1.0.0 --installer /tmp/feeddemo/UCAD-Setup-1.0.0.exe \
    --url https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe \
    --out /tmp/feeddemo/update-feed.json
[FAIL] installer-latest-url: the installer URL uses releases/latest, which 404s once a newer release exists — https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe

refused: /tmp/feeddemo/update-feed.json was not written — the app's own feed check rejects this document.
```

退出码 1，`/tmp/feeddemo/` 里只有安装包，没有 feed。

同时本机这轮能连 `github.com` 了，于是把「已发布 feed」这条重测了一遍（结果仍是红，但现在是
**带宿主自述的**红）：`verify-release-feed.mjs` 仍报 `no-sha256` + `installer-latest-url`；
GitHub 对该 release 的 `UCAD-Setup-1.0.0.exe` 自报 `sha256:76bbe0c612ac67575ac40a543929a7691ba9f9e185343297cbc3badda9ea5a48`、
`size: 122806279`，安装包 URL 的 HEAD 也真的回 `content-length: 122806279`。
把这三个数写进修正版文档，用同一套判定跑 → **零 finding**（`docs/manual-verification.md` 末节有完整输出）。
所以剩下的不是「怎么修」，而是「谁有这个仓库的写权限」：本机没有任何 GitHub 令牌，`gh` 也没装。

**时效说明（这两组数字不是常量）**：上面那段里的 `sha256:76bbe0c6…` 与 `size: 122806279` 是
**2026-11-04 从 GitHub 对该 release 的自报值**（asset 的 `digest` / `size`）抄下来的。
`tests/contract/feed-publish.test.ts` 把这两个数硬编码进 `FEED_DOCUMENT` 的断言，是有意为之：
它钉住的是「发布流程用的数字取自宿主自报，不是人算的」。所以**重传资产或换 tag 之后**要重取一次，
并同步更新三处——`docs/release/update-feed-v1.0.0.json`、`tests/contract/feed-publish.test.ts` 的那两条断言、
以及本节这段文字。重取是发布动作的一部分，不是把测试放宽。

**绿分支（2026-11-04 补）**：这条红说的是「发布出去的那份字节」，不是「判定能不能通过」。
修正版文档已经在一个本地 TLS 地址上原封不动地跑过一次完整链路：
`node scripts/replay-feed-local.mjs` 退出码 0，`verify-release-feed.mjs` 打出
`PASS — 0 warning(s), nothing the app would refuse`，`release-gate.mjs` 也打出 `PASS`。
所以这张表里剩下的只是**上传**（写权限令牌），不是判定逻辑；输出在
`docs/manual-verification.md`「绿分支是一次跑」一节，命令、端口与哈希都可复现。
完整绿跑另需一条到 `github.com` 的路（安装包 URL 要 HEAD 一次）：路由不通时命令以 `[INCOMPLETE]` 收场、
**不**把主机问题写成文档判决，退出码同样是 1——这是本机路由时通时不通时唯一诚实的结局。

## 本轮（2026-11-04 深夜）五态在最小窗口也被测量，弹窗不再被当成排版错误

上表「权限门不可绕」还差的「窄窗口」以前只有一个诚实答案：五态只在 1440×900 量过。
把五态放进最小窗口（768×700，即 `minWidth`/`minHeight`）量第一次，先红在了一条**门禁自己的错**上：

- 权限弹窗在 768×700 与 860×700 报 `overlaps`：`span#permission-dialog-title "Agent 请求权限"`
  压着 `div.msg.assistant "已定位到 …"`。屏幕是对的——模态本来就画在对话之上；错的是判定少了一层。
  `.overlay` 是 `position: fixed`，但 `.dialog` 里的 `header`/`span` 都是 `static`，
  于是「非 static 的盒子是有意分层的，豁免」这条只护住了一层，弹窗里的字被拿去和背后的对话比。
  1440×900 之所以一直没报，是那个窗口下弹窗正好落在对话的空白处——**门禁的绿取决于窗口大小**，
  这正是它五轮没人发现的原因。
- 现在判定带上层：`modalOf(el)` 取最近的 `[role="dialog"][aria-modal="true"]`（与 `dialogOpen` 同一个选择器，
  产品只声明了这一个模态），两个文字盒子只有在**同一层**里才互相比较。弹窗内部的压字仍然打红——
  那正是 round 4 的缺陷形状（描述压在自己的风险行上）；页面内部的规则一字未改。

五态因此在两个尺寸上都被量：`state-<name>`（1440×900）与 `state-<name>-tight`（768×700），
两条 target 共用同一个 `state` 字段，四条状态断言（量到的正是它自称的状态、error 真是错误面板、
permission 真有模态、empty 真没有工作区）对两者都生效；新增一条断言要求每个状态在最小窗口都被量到，
尺寸取自 `TIGHT`，而 `TIGHT` 由漂移测试钉着等于产品自己声明的 `minWidth`/`minHeight`。

**证明它会红**：在修判定之前跑同一份 target 列表（探针直接驱动，`.run-logs/narrow-states.mjs`），
`permission-768x700` 与 `permission-860x700` 各报 `overlaps`，其余四个状态的窄窗口干净。
修完后门禁 31 项全绿（`layout.test.ts`，含 5 条新的 tight target 与 1 条覆盖断言）。

这仍然**不是**视觉走查：几何管不到「引导语够不够醒目」「失败信息压不压过内容」。
窄窗口的**可测量**那一半（不横向溢出、不塌缩、不裁字、控件不出屏、不压字）现在有门禁；
剩下的仍然要人眼，见 `docs/manual-verification.md` 步骤 6。

## 本轮（2026-11-04 深夜）写与判接成一条命令链，且「没跑」在输出里显形

上一轮把判定搬进了写之前，但两条命令仍然各判各的：写的一方验的是自己手里的对象，
判的一方验的是网上那份文档，中间那份**刚写到磁盘、等着被上传**的文件，没有任何一条命令碰过。
这正是 v1.0.0 那份坏 feed 的形状——错由一条命令犯下，由另一条命令在几天后、另一台机器上发现。

1. **`verify-release-feed.mjs --feed-file <路径>`**：把「即将上传的那份文档」交给同一条判定
   （`judgeFeedDocument` / `judgeInstallerHead`，规则仍从应用自己的 `update-feed.ts` 载入），
   于是文档那一半可以在**没有网络、没有 release** 的情况下被证明，也能进 CI。
   地址规则对文件不适用——这一点被**打印出来**（`[skipped]`）而不是咽下去。
2. **「没跑」不再和「跑过」长得一样**：`--no-installer` 与 `--feed-file` 各自留下未检查项，
   现在逐条打成 `[skipped] …`，总结行带「`N check(s) did not run`」。以前两种运行都打印同一句
   `PASS`——一次只证明了文档的运行，和一次全查的运行，读起来一模一样。
3. **不认识的选项是错误，不是默认值**（`verify-release-feed.mjs` 与 `verify-packaged-adapters.mjs`）：
   `parseArgs` 会跳过看不懂的 token，这对散落的单词是对的，对旗标是错的。
   `--no-installers` 会让本该跳过的网络检查照跑（把主机问题报成 feed 问题）；
   `--requires universal,mock` 会退回默认的 `universal`，于是「要证两个适配器」的检查证了一个并报 OK。
   现在两条命令都打印未知选项 + 已知选项表并以 1 退出。
4. **端到端门禁 `tests/contract/feed-pipeline.test.ts`（7 项）**：临时目录里真的跑
   `make-update-feed.mjs` 生成文档，再把**同一个文件**喂给 `verify-release-feed.mjs --feed-file`，
   断言零 FAIL、退出码 0，且 feed 里的 `size` 等于安装包的实际字节数；反向四条：线上 v1.0.0 那份文档
   经同一条命令红（`no-sha256` + `installer-latest-url`）、路径打错时红（`feed-unreadable`，
   而不是在空集合上报绿）、未知选项红、`--feed` 与 `--feed-file` 同时给时红。

**证明它会红**：删掉 `[skipped]` 的打印 → 「says out loud which checks it did not run」红；
把写入器的 `sha256` 一行去掉 → 端到端三条同时红（写入器自己先拒绝写）。恢复后 7/7 绿。

`layout-probe.mjs` 这一路复核结论是**已经收口**：结果文件缺失直接抛错、`GEOMETRY` 在
`beforeAll` 之后由数据派生（历史上曾在模块作用域算出空数组，让 11 条几何断言在探针首屏就挂掉时全绿），
`--steps` 那一路由 `verify-main-chain.mjs` 的 `parseSteps` / `stepCoverage` 管着。
三者里只有上面两条命令还有「静默」的缝，本轮补上。

门禁：`npm test`（含 `tests/contract/layout.test.ts`，需 X）、`npm run lint`、`npm run knip`、
`npm run typecheck` 全绿；README 中英两半同步加了「上传前后用同一条命令」的段落，
`readme*.test.ts` 与 `doc-citations.test.ts` 保持绿。

## 已知盲区（故意不做，防止后来者误补）

1. **`verify-release-feed.mjs` 不比对哈希与文件本体**：它不下载安装包，所以证明不了「发布的
   `sha256` 就是发布文件的哈希」。要证明只有两条路——120 MB 的流式读取，或 GitHub 的 asset `digest`
   接口（本轮人工用过一次，见上）。两条都属于**发布步骤**（`make-update-feed.mjs` 算哈希的那一刻，
   以及本轮的写前判定），不属于这条只做 HEAD 的命令；在这里补一个下载会把它变成一个 120 MB 的门禁。
2. **布局门禁不管 `:hover` / `:focus-visible` 的观感**：几何量的是稳定帧，悬停与聚焦态要么抖要么需要
   合成事件，量出来的断言比它防的问题更脆。`tests/contract/focus-indicator.test.ts` 管的是焦点可见性
   这条**规则**，不是某个状态下的像素。
3. **`release-feed.test.ts` 的源码扫描对格式敏感**：`['"]https:['"]` 这类断言只看字面量写法，
   改写风格（比如抽成常量）会让它误报。现有意图清晰（"不许出现第二份 https 规则"），暂不改为语法级扫描——
   语法级扫描要读 TypeScript，代价远大于它现在挡住的风险。

## 下一刀

- **上传修正版 feed**：这是表里唯一还剩的「红」，且已经验证过判定为绿，只差写权限。
  上传后 `node scripts/verify-release-feed.mjs` 应退出 0；在那之前，`--feed-file` 只能证明
  文档本身（离线、可复跑），证明不了「发布出去的就是这一份」。
- **Windows 桌面六步**：唯一硬缺口，需要一台 Windows 机器，不是代码。
- 步骤 6 的**视觉**走查（DOM 断言管不到排版与观感）与排版分寸（正文行长、行首禁则），同上。

## 本轮（2026-11-04 深夜）主机不应答，不再被写成「feed 是坏的」

上一轮把「写」和「判」接成了一条命令链，剩下的红只有一条：v1.0.0 发布出去的 feed 缺 `sha256`/`size`、
URL 钉在 `latest`，修正版已验证干净，只差一次上传。这一轮本机仍然没有 GitHub 写权限令牌（`gh` 也未安装），
所以上传这一步照旧做不了——但**为了做这一步而跑的那条命令**，本轮暴露了一个会把人带错方向的缺陷。

**量到的缺陷**：本机到 release 主机的路由时通时不通。不通的那次，`node scripts/verify-release-feed.mjs` 打印的是

```
[FAIL] feed-unreachable: the feed could not be fetched, so every update check fails — This operation was aborted
FAIL — 1 failure(s), 0 warning(s)
```

这句话是**对文档的判决**，而实际发生的是「20 秒内没有应答，什么都没读到」。同一台机器上 `curl` 对同一个
URL 挂满 90 秒也没有回一个字节，所以这不是 feed 的问题。方向错得很贵：读到这句话的人会去重传一份本来
没问题的 feed，而真正该做的是重试抓取或换网络。

这正是本仓自己已经命名过的失败形状——`verify-release-feed.mjs` 拒绝未知选项时写的理由是
「reports a host problem as a feed problem」——只是那条规则当时只覆盖了旗标，没覆盖抓取本身。

**改法**（`scripts/verify-release-feed.mjs`）：

1. 超时是它自己的 finding：`feed-timeout` / `installer-timeout`，severity 仍是 `fail`（没看到就不能算绿），
   但句子说的是「这次检查没跑完」，detail 带上窗口与 URL，并提示 `--timeout <ms>`。
2. 分类收进纯函数 `judgeFetchFailure(error, { url, timeoutMs, kind })`：`AbortError`（`AbortController.abort()`）
   与 `TimeoutError`（`AbortSignal.timeout()`）都算超时；DNS 失败、连接被拒这类**主机给了答案**的错误
   仍然是 `feed-unreachable` / `installer-unreachable`，不被软化。
3. 总结行收进纯函数 `summaryLine(findings, notChecked)`，三种结局三个词：`PASS` / `FAIL` / `INCOMPLETE`。
   `INCOMPLETE` 的退出码同样是 1，差别只在读者下一步做什么。`--json` 多一个 `incomplete` 字段，
   读 JSON 的脚本不必从 code 里反推。

**证明它会红**：`tests/contract/release-feed.test.ts` 新增 6 项（两种超时各一条、主机给了答案的那条不被软化、
两种超时形状都认、`INCOMPLETE` 与 `FAIL` 不混、跳过计数在三种结局上都在、超时码表与词表对齐）；
`tests/contract/feed-pipeline.test.ts` 新增 1 项**端到端**：起一个只接受连接、永不回话的本地 TLS 主机
（`net.createServer` 不写 ServerHello，握手永远不完成），`--feed https://127.0.0.1:<port>/… --timeout 100`
必须退出 1、输出含 `feed-timeout` 与 `INCOMPLETE`，且**不含** `feed-unreachable` 与 `FAIL —`。
把 `judgeFetchFailure` 里的超时分支删掉（回到一律 `feed-unreachable`），这两组同时红。

**顺带量到的一件事**（记下来，不改）：超时之后命令的判决行立刻打印，但进程还要约 10 秒才退出——
undici 把被 abort 的那条连接留在事件循环里。所以那条端到端用例本身要跑 10 秒左右；这是运行时行为，
不是判定行为，判决在打印那一刻就已经完整。

**这一轮没有做的事**：上传修正版 feed（无写权限）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼视觉走查（无真机）。三条都仍是上表里的缺口，不假装完成。

## 本轮（2026-11-04 深夜）截图与渲染层源码同步，五态第一次有图可看

上表里「步骤 6 的**视觉**走查」一直是同一句话：DOM 断言证明「该有的字在屏上」，
证明不了「看上去像不像首启」。这一轮没有假装把它做完，而是把它拆成两半，做掉能机器做的那一半。

1. **截图与 UI 同步进门禁**（`tests/contract/screenshots.test.ts` 扩展，不新建文件）。
   以前这个文件只判三件事：图存在、是 PNG、尺寸等于 `bootstrap.ts` 的开窗尺寸——全是关于**文件**的断言，
   没有一条是关于**画面**的。`styles.css` 重写一遍、README 继续展示旧窗口，门禁照样绿。
   现在 `scripts/screenshot-sources.mjs` 把每个渲染层源文件与每张已提交截图的 sha256 记进
   `docs/screenshots/sources.json`，门禁重算并**指名**移动的那个文件；重拍图后
   `node scripts/screenshot-sources.mjs --write` 是那次确认。
   - **为什么不用 mtime**：`git clone` / `git checkout` 把每个文件都盖成检出时间，CI 里截图永远和源码
     一样新，比较恒绿——一个不能变红的门禁比没有门禁更糟（本仓对 `--steps` 与 `skipIf` 说过同样的话）。
   - **为什么不做像素比对**：`layout-probe.mjs` 开头已经写过理由，字体渲染、滚动条、亚像素边缘都会让它在
     第一次无辜改动上打红，然后被关掉。
   - **它做不到什么**：它证明不了图**真的重拍过**——`--write` 可以在没看一眼的情况下跑。这是所有非像素
     门禁的共同上限，写在这里而不是糊过去：门禁的职责是让「没重拍」变成**显式决定**，不是让它不可能。
   - **证明它会红**：往 `styles.css` 末尾加一行注释后，`node scripts/screenshot-sources.mjs` 退出 1 并打印
     `[drift] changed since the screenshots were taken: apps/desktop/src/renderer/src/styles.css`，
     `screenshots.test.ts` 的 `records the renderer sources that are actually in the tree` 同时打红；
     恢复后 9/9 绿。
2. **五个界面状态第一次有图**：`npm test` 的布局门禁在真实 Chromium 里拍的五态截图，此前只落在被忽略的
   `.run-logs/layout/`。其中三张从未在仓库里出现过，已提交为
   `docs/screenshots/states/{loading,partial,permission}.png`（1440×900，与开窗尺寸一致），
   首启与失败态沿用 `docs/screenshots/{empty,error}.png`。于是「观感」这件事**可以远程做**：
   把图发给任何一个人，他不必装应用就能回答「引导语够不够醒目、失败信息压不压过内容」。
3. **演示脚本的步骤 6 拆成逐条可演示动作**（`docs/demo-script.md` 第四个演示动作）：
   每个状态一行——做什么 / 屏幕上应看到什么 / **失败长什么样**。最后一句是给现场用的：
   屏幕上出现的是「失败长什么样」那一列，就说明这个状态坏了，不要往下讲。
4. **上传修正版 feed 的交接写成一行可执行说明**（`docs/manual-verification.md` 末节）：
   变量名（`GITHUB_TOKEN` / `GH_TOKEN`）、命令（`node scripts/publish-feed.mjs --apply --verify`）、
   期望输出（`PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=…`）、
   失败时贴什么、做完要改的三处。本机仍无写权限令牌，所以这一条**仍是红**，不假装完成。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的**人眼**观感签字（图有了，看的人还没有）。

## 本轮（2026-11-04 深夜）Windows 六步的证据可以带回来了，README 承认五态没人看过

三条真实卡点全是「外部条件 + 人眼」，本轮不碰产品行为，只把其中两条往前推一步。

1. **`verify-main-chain.mjs --report <路径>`**：六步属于 Windows 桌面，而跑它的机器通常不是读结果的机器。
   终端里的 transcript 只在终端开着的时候是证据，于是 `--report` 把同一次运行写成一份文档：
   `platform` / `build`（可执行文件、版本、字节数、mtime）/ `steps`（每步 `verdict` + 它自己记的证据行）。
   判定三态：`pass` / `fail` / `skip`（`--steps 1,4` 这种部分运行里，没跑的步骤记 `skip` 而不是消失）；
   被请求却既没 `[ok]` 也没 `[FAIL]` 的步骤记 `fail`——与 `stepCoverage()` 对退出码的规则同一条。
   **它证明不了什么**：报告是文档，文档可以手写。这句话写在 JSON 自己的 `note` 字段里，
   门禁（`tests/contract/verify-main-chain.test.ts` 新增 7 项）只钉形状：三键都在、每步有 `verdict` 与 `evidence`。
2. **README 中英两半各加一条「五个界面状态还没有被人眼走查过」**：它们被断言、被测量、被拍照，
   但没有人看过并说「这看起来像首启 / 像失败 / 像权限请求」。`readme-parity.test.ts` 的 `LIMITATIONS`
   表按 id 加了一行（三个关键词：哪五态、没人看过、记在哪）。门禁绿的假象是主动误导，这条不补，
   前面所有「如实记录」都被前门抵消。

**本轮没做**：排版三项底线（行长 / 行首禁则 / 中英空隙）——留给下一刀；上传修正版 feed（无令牌）；
Windows 真机六步（无 Windows 机器）；步骤 6 的人眼观感签字。

## 本轮（2026-11-04 深夜）行长与断行：排版三项底线里的两项，量出来而不是写出来

上一轮末尾留了一句「排版三项底线（行长 / 行首禁则 / 中英空隙）——留给下一刀」。这一轮做掉前两项，
第三项**量过之后决定不做**，理由写在下面，不是漏掉。

**为什么这是 DoD 内的事**：`docs/PRODUCT-DOD.md` 的「权限门不可绕」那一行还差「真机上的视觉走查
（排版、长中文、窄窗口）」。几何门禁管得到「字在框里、不裁、不叠、不出屏」，管不到「一行有多长、
在哪里断」——而后者才是中文读不下去的原因。一个段落可以每条几何规则全绿，仍然是一堵墙。

1. **行长有了天花板，且是量出来的**：`scripts/layout-page-scripts.mjs` 新增
   `MAX_PROSE_LINE_CJK = 40`。一个汉字约一个 em 宽，所以「行宽 ÷ 字号」就是「每行几个字」，
   不需要猜。只量**换行过的**块（单行标签没有行长可判，段落最后一行天然短，所以取最长的那一行）。
   量到的真缺陷：帮助页两段正文被设成页面列宽（960px），在 13px 下是 **70.1 与 69.0 个汉字**。
2. **断行位置也量**：`LINE_START_FORBIDDEN` / `LINE_END_FORBIDDEN`（行首禁则 / 行尾禁则）。
   逐字取 rect、按 top 归行，检查每行首尾字符。**哪个 CSS 属性真的会破坏它，是量出来的**：
   合成页（400px，30 个汉字后接「。」）上 `line-break: anywhere` 会把句号顶到下一行行首，
   规则报红；而 `word-break: break-all` 与 `overflow-wrap: anywhere` **不会**——Chromium 在这两个
   属性下仍保留 CJK 标点规则。第一版注释把三个都写上了，测量推翻了它，注释改成实测结论。
3. **正文有了自己的度量**：`--measure-prose: 36em`。em 在这里是唯一正确的单位，因为一个汉字约一个 em，
   所以这个数**就是**每行字数。列宽仍是 960px（最宽的门禁表格需要它，表格不是正文），
   只有正文被收窄。`.card > p`、`.convo-inner`、`.composer-inner`、`.terminal-note`、
   `.first-run`、`.pane-head p`、`.fs-note`、`.fs-fine` 都改用它。
4. **门禁抓到的两个真缺陷（都在产品里，不是门禁里）**：
   - 上下文抽屉的两条说明（`div.faint.fs-note`）在 768×700 下是 **41 与 43.6 个汉字/行**——
     它们被设成面板宽度。`.fs-note` / `.fs-fine` 现在带正文度量（在 inline span 与表格单元格上
     `max-width` 不生效，所以这两个角色照旧可以用在那里）。
   - 交接页的副标题（`.pane-head p`）在 768×700 下是 **40.9 个汉字/行**，刚好越过天花板。
5. **门禁**：`tests/contract/layout.test.ts` 新增 3 项（行长不越天花板、断行不违规、**量到了正文而不是
   量了个空**——帮助页至少两段换行正文、整轮至少 10 段，否则「没找到」和「没量」长得一样）；
   `tests/contract/typography.test.ts` 新增 3 项（天花板在 28–40 带内且测量真的用了这个数、
   两个字符集按**内容**断言且不许有交集、`--measure-prose` 在带内且真的被正文规则消费）。

**证明它会红**：修之前跑同一份 target 列表，`layout-768x700#context` 报两条 `longLines`
（41 / 43.6），修完 `.fs-note` 后 `layout-768x700#handoff` 报一条（40.9），再修 `.pane-head p` 后
36/36 全绿。断行规则的红证据是上面那个合成页（`line-break: anywhere` → `badBreaks` 非空）。

**中英空隙：量过，决定不做**。扫 `apps/desktop/src/shared/i18n.ts` 的全部字符串字面量，
「汉字紧邻拉丁字母/数字」出现 **0 次**——现有文案已经全部带空格（`将删除 {sessions} 个会话`）。
没有缺陷可修，而一条会拒绝「第1步」这类正常写法的规则，是把风格偏好伪装成排版错误。
它属于文案约定，不属于布局失败；真要管，该管在 i18n 的评审里，不是几何门禁里。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的**人眼**观感签字（图有了，看的人还没有）。三条仍是上表里的缺口，不假装完成。

## 本轮（2026-11-04）五态走查从「去看一眼」变成可交接的判据与签字表

上表里「权限门不可绕」还差的那半句是「真机上的**视觉**走查」，而它连着三轮的写法都是同一句
「仍未做」。这句话诚实，但它没有下一步：**「去看一眼」不是一件可以交接的事**——没有要回答的问题、
没有写答案的地方、也没有「答了会怎样」。所以它挂了三轮。

这一轮不碰产品行为，只把这件事变成可交接的：

1. **`docs/state-walkthrough.md`**：每态三条**能用「是 / 否」回答**的判据，每条锚在屏幕上真的会出现的字上
   （取自 `apps/desktop/src/shared/i18n.ts`，例如首启态「第一眼落在 `还没有对话。…` 上而不是空列头上」、
   权限态「`拒绝` 不比允许更难找」），并写明**不合格长什么样**——现场看到那一句就说明这个状态坏了。
   两条路都写在文件里：有应用走 `npm run dev:web` 的五个 URL，只有图就直接看五张截图（远程可做）。
2. **记录表**：`日期 / 走查人 / 看了哪几张 / 五态判据 / 不合格项 / 结论`，出厂只有一行 `未走查` 占位。
   **一行带日期的记录就是一次签字**；写「OK」不算记录，要写「第 N 条不满足：屏幕上看到什么」。
3. **`tests/contract/state-walkthrough.test.ts`（10 项）** 把三件事钉在一起：
   - 每个 `STATE_SCENARIOS` 状态都有 `### <state>` 一节、至少三条判据、且每条判据都点名一个反引号字面量
     （**写这份文件时它当场抓到我自己的 5 条判据在说空话**——「加载态看起来是在等」没有锚点，
     改成「没有 `重试` 按钮」才过）；
   - 每节点名的截图必须真的在仓库里（远程走查那条路不能烂成 404）；
   - **README 与记录表不许互相矛盾**：表里没有带日期的一行时，README 中英两半都必须仍然写着
     「没人看过」（`by eye` / `人眼`）；一旦签了字，README 必须带上那个日期。两个方向各有一条红测，
     外加一条「签了字且 README 带上日期 → 零问题」的绿测，免得规则变成永远失败。
4. **README 中英各补一句**指向这份文件（`readme-parity.test.ts` 的 `LIMITATIONS` 关键词原样保留），
   `docs/manual-verification.md` 步骤 6 与 `docs/demo-script.md` 的演示动作 4 各补一段「现场照着判据念」。

**这一轮没有做的事**：走查本身（没有人看那五张图）、上传修正版 feed（无令牌）、
Windows 桌面六步（无 Windows 机器）。三条仍是上表里的缺口，不假装完成——本轮只是让第一条
**从「没人做」变成「谁都能做，且做了会留下痕迹」**。

## 排版三项底线的证据索引（答辩时 30 秒定位）

| 结论 | 证据在哪 | 门禁 |
|---|---|---|
| 一屏只有四档字号（18 / 13 / 12 / 10.5） | `apps/desktop/src/renderer/src/styles.css` 的 `--fs-display` / `--fs-body` / `--fs-note` / `--fs-fine` | `tests/contract/typography.test.ts`（加一条裸 `12.5px` 会打红） |
| 中文不小于 12px，且与 `--fs-note` 是同一个数 | 同上，`--fs-min-cjk` | `tests/contract/typography.test.ts` |
| 正文行长 ≤ 40 汉字（`--measure-prose: 36em`，落在 28–40 带内） | `styles.css` 的 `--measure-prose`；量测常量 `MAX_PROSE_LINE_CJK` 在 `scripts/layout-page-scripts.mjs` | `tests/contract/layout.test.ts`（五态 × 两个窗口尺寸） |
| 行首 / 行尾禁则（句号不顶行首） | `LINE_START_FORBIDDEN` / `LINE_END_FORBIDDEN`，同上文件 | `tests/contract/layout.test.ts` |
| 中英空隙：**量过，决定不做** | 扫 `apps/desktop/src/shared/i18n.ts` 全部字面量，「汉字紧邻拉丁字母/数字」出现 0 次 | 无门禁，理由见上一节（会拒绝「第1步」这类正常写法） |
| 字体栈按声明解析（Latin → 中文 → 通用），且汉字的框只落在声明的两个栈上 | `scripts/layout-page-scripts.mjs` 的 `families`；断言 `layout.test.ts` | `tests/contract/layout.test.ts`（41 项 × 两个窗口尺寸） |
| 汉字不被合成斜体（假斜体） | 同上，`fakeItalics` | `tests/contract/layout.test.ts` |
| 五态观感：判据已就位，**等一个人签字** | `docs/state-walkthrough.md` | `tests/contract/state-walkthrough.test.ts`（判据锚点 + README 与签字表不许矛盾） |

## 三条外部阻塞（本轮仍阻塞，不假装完成）

| 阻塞 | 解除条件 | 一行命令 | 本轮状态 |
|---|---|---|---|
| 已发布 v1.0.0 的 feed 缺 `sha256` | 拿到 `castorhrio/jev-pi-agent` 的 `contents: write` 令牌的人跑两条：先看，后按 | `node scripts/publish-feed.mjs --dry-run` 然后 `GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify` | **仍阻塞**：本机无令牌、`gh` 未安装。修正版文档已判零 finding，`--dry-run` 已把「上传什么字节 / 落到哪 / 判哪三条」打成可复制的计划，只差上传 |
| Windows 桌面六步 | 一台 Windows 机器 + 一次 `npm run package`，跑完把报告带回并**被判成过** | `node scripts\verify-main-chain.mjs --exec release\win-unpacked\UCAD.exe --report win-report.json`，带回后 `node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json` 退出 0 | **仍阻塞**：无 Windows 机器。回传通道（`--report`）与读回通道（`--judge`）都已就绪：报告不再是一份没人判的文档，`win32` / 全 `pass` / 版本一致三条任一不满足就不算过 |
| 五态人眼走查 | 一个人按判据看五张图（或走五个 URL）并签一行 | 打开 `docs/state-walkthrough.md`，逐条回答 | **仍阻塞**：判据与签字表本轮就位，签字还没有发生 |

这三条都是**外部阻塞**（写权限令牌 / Windows 机器 / 人），不是留在本仓的待办：命令、判定与签字表都已就绪，接手的人照最后一列跑即可，本机不再把它们记成「还没做完」。
三条的「解除命令 / 期望输出 / 结果放到哪个路径」收敛在一页：`docs/blockers.md`——
读那一页就够，不必从这三份文档里拼。

## 本轮（2026-11-04 深夜）截图漂移的「只检查不写」路径，第一次被证明会红

上一轮把截图与渲染层源码接进了门禁：`docs/screenshots/sources.json` 记着每个渲染层源文件与每张图的
sha256，`scripts/screenshot-sources.mjs` 重算并指名移动的那个文件。但那条命令的**失败路径**没有任何
测试驱动——`tests/contract/screenshots.test.ts` 调的是 `drift()` 这个纯函数，`main()` 里若把漂移判成
0 退出、或者干脆在比较之前就返回，所有用例照样绿。这正是本仓已经命名过三次的缺陷形状
（`--steps 6` 通过、`skipIf` 守卫、上一轮那个让布局门禁在 import 阶段就死掉的反引号）：
**守门人和被守的门一起哑**。

1. **`--check` 成为一条写出来的路径**（`scripts/screenshot-sources.mjs`）。默认行为本来就是检查，
   但默认不是一句话：一条 `node scripts/screenshot-sources.mjs` 的 CI 步骤，读者得先读懂它才敢信
   ——「这条命令会不会写文件」对一个有 `--write` 兄弟旗标的命令是合理的问题。现在 `--check` 在命令
   本身里回答它；`--check --write` 同时给会被**拒绝**而不是按优先级挑一个（同时要两件相反的事的调用方
   并不知道自己要什么，替它猜就是让门禁记录下它本该报告的漂移）。绿路径也打印计数
   （`PASS — 33 renderer source(s) and 9 screenshot(s) match …`）：空清单上的 PASS 和三十个文件上的
   PASS 否则读起来一样，而前者正是「门禁已经不看东西了」的形状。
2. **`tests/contract/screenshot-sources.test.ts`（8 项）跑的是命令，不是函数**。临时树里复制一份脚本
   （脚本把根锚在自己所在位置，所以一份拷贝对它就是一个完整仓库），`--write` 记一次，然后：
   - 改一行渲染层源码 → `--check` 退出 1，stderr 含 `[drift] changed since the screenshots were taken: apps/desktop/src/renderer/src/styles.css`，且**不**打印 PASS；
   - 换掉一张图 → 退出 1 并指名那张图；新增一个组件 → 退出 1 并指名那个文件；
   - `--check` 与默认都**不写** manifest（检查路径若顺手记录一次确认，第二次运行就把红变绿了）；
   - `--check --write` 被拒；`--wirte` 被拒并打印用法；manifest 缺失时退出 1 而不是在空集合上报绿。
3. **证明它会红**：在 `main()` 的漂移分支里插一句 `return 0`，上面四条（改源码 / 换图 / 新组件 /
   不写 manifest）同时打红，其余四条仍绿——说明这组用例钉的正是「命令会不会说不」。
   真实树上也验了一次：往 `styles.css` 末尾加一行注释，`node scripts/screenshot-sources.mjs --check`
   退出 1 并打印 `[drift] changed since the screenshots were taken: apps/desktop/src/renderer/src/styles.css`；
   恢复后退出 0。

**这一轮没有做的事**：五态人眼走查的签字（需要一个人看那五张图，本轮没有发生，README 中英两半
仍写着「没人看过」，`state-walkthrough.test.ts` 会拦住任何提前改口）、上传修正版 feed（无令牌）、
Windows 桌面六步（无 Windows 机器）。三条仍是上表里的缺口，不假装完成。

## 本轮（2026-11-04）HEAD 上唯一的红：`partial` 画了首启块

`tests/contract/layout.test.ts` 的 `the first-run block has an entry point, and counts its steps once`
在 HEAD 上是红的，失败原文：

```
AssertionError: ?scenario=partial painted the first-run block: expected { leadSize: 13, …(6) } to be null
```

**结论：产品该改，不是断言该收窄。** 首启块说的是「还没有对话。在下方描述你的任务…」——
这是关于**对话**的断言，它成立的前提是「会话列表真的读过了」。`partial` 里 `sessions.list` 失败，
`useAppData` 把原因记进 `endpointErrors.sessions` 并回退成 `[]`，于是 `sessionId` 为 null、
对话区为空，首启块照常渲染：左侧会话列说「会话列表读取失败（不是空的）」，右侧主区却说
「还没有对话」——同一屏上两句话互相矛盾，而主区那句是对一份没读到的历史下的确定结论。
这与 `loading` 分支已经修过的缺陷是同一个形状（「还没到达」不等于「没有」），只是这次是「读失败」。

**改动**（`apps/desktop/src/renderer/src/App.tsx`，一处分支 + 一个 import）：
对话区在 `data.endpointErrors.sessions` 有值时渲染 `ReadFailure`（`sessions.loadFailed` + 原因），
与左侧会话列同一句话、同一个组件；首启块因此只在会话列表确实读过、且确实为空时出现。
没有新增文案、没有新增组件、没有动 `empty` 场景（它没有 `endpointErrors`，首启块照旧）。

**反向验证**：把新增分支删掉（回到旧写法）后重跑
`xvfb-run -a npx vitest run tests/contract/layout.test.ts -t "the first-run block"`，
同一条断言重新变红（`?scenario=partial painted the first-run block`）；恢复后
`tests/contract/layout.test.ts` 37/37 绿，`tests/e2e/scenarios.e2e.test.tsx` 6/6 绿，
`tsc --project apps/desktop/tsconfig.renderer.json --noEmit` 干净。

**这一轮没有做的事**：五态人眼走查签字（本轮只把渲染结果逐态取了出来，签字与 README 中英两半
的同步留给下一轮）、P1 的字体栈/嵌套圆角门禁、上传修正版 feed（无令牌）、Windows 六步（无 Windows 机器）。

## 本轮（2026-11-04）两条外部阻塞的交接面：一条先看后按的命令，一份照做就行的清单

上一轮之后剩下的三条卡点都是「外部条件 + 人」，本轮仍不假装能在这台机器上做完任何一条。
改的是**接手的人拿到的东西**：两条阻塞各自从「知道怎么修」变成「拿到东西的人照着敲」。

1. **`scripts/publish-feed.mjs --dry-run` 成为一条写出来的路径**（默认行为本来就是不写，
   但默认不是一句话）。它打印将上传的**字节数**、落点 URL，以及**判定在哪一步跑**：
   `check 1` 是应用自己的 feed 规则（在找令牌之前就已经跑过）、`check 2` 是宿主对安装包的
   digest 与 feed 的 `sha256`/`size` 比、`check 3` 是上传后对发布出去的字节再判一次。
   只写「删哪行、POST 到哪」的计划，读到的人还得去另一份文档里找「怎么才算修好了」。
   `--dry-run` 与 `--apply` 同时给会**被拒绝**（`docs/manual-verification.md`「谁有 token 谁跑这两条」）。
2. **Windows 机器的最短路径写进 `docs/manual-verification.md`**：从 `git clone` 到 `--report` 的五条
   命令逐条可复制，再给出「把文件带回来跑 `--judge`」那一条。以前文档写的是「在仓库根目录先
   `npm run package`」——它假定读者已经有一份装好依赖的仓库，而那正是把仓库交到别人手上的那一步。
3. **`judgeReport()` 多了一条：`pass` 必须带证据行。** 报告是文档、文档可以手写，这是它证明不了的事；
   但「五行 `pass`、什么都没有」可以被拒。`buildReport()` 只在一步 `record()` 过之后才让它 `pass`，
   所以真跑的报告不受影响；`buildReport()` 给空行填的那句占位（`(the step recorded no evidence line)`）
   在这条规则下**不算证据**，于是「一步 pass 却什么都没记」在报告里也不再和一位真结果长得一样。

**证明它会红**：`tests/contract/win-report.test.ts` 新增 4 项——`evidence: []`、只有占位句、
根本没有 `evidence` 数组三种都指名那一步（`a claim, not a result`），带证据行的报告照旧绿；
再加 1 项直接喂 `buildReport()` 写的「pass 但没有证据行」形状，同样红。
`tests/contract/feed-publish.test.ts` 新增 6 项——`--dry-run` 与无参数是同一份计划、计划里点名三条判定、
`--verify` 的 dry run 说「waits for a real upload」、dry run 前后**文件字节与 mtime 都没变**、
`--dry-run --apply` 被拒、命令行 `--dry-run` 退出 0。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼观感签字（需要一个真的看那五张图的人）。三条仍是上表里的缺口，不假装完成。

## 本轮（2026-11-04 深夜）绿分支是一次跑，不是一段论证；三条阻塞收敛成一页

这一轮仍然没有写权限令牌，所以**上传还是没有发生**。改的是另外两件事：那条红**之前的**判定链
有没有真的跑过一次绿的，以及接手的人拿到的是不是一页能读完的东西。**产品行为没有变化。**

1. **`scripts/replay-feed-local.mjs`**：把修正版文档原封不动托到本地 TLS 上（自签证书只给两个子进程
   通过 `NODE_EXTRA_CA_CERTS` 信任），跑 `verify-release-feed.mjs --feed <地址>`，再用同一条命令的
   `--json` 产出 run 交给 `release-gate.mjs --from-json`。两条命令都 `PASS`，退出码 0；完整输出在
   `docs/manual-verification.md`「绿分支是一次跑」一节，含被托出字节的 sha256 与字节数，
   `sha256sum docs/release/update-feed-v1.0.0.json` 可对照。
   - **证明**：feed 正确时发布闸门会放行，这条路上没有 `[skipped]`。
   - **不证明**（命令最后一行自己说）：Releases 上那份 asset 还是旧的；闸门判的是保存 run，
     而 `npm run dist` 是让闸门自己去抓。
   - **没有 openssl 的机器**上不退回明文，打印 `openssl could not be run …` 并指向 `--feed-file`。
2. **`tests/contract/replay-feed-local.test.ts`（16 项）钉控制流**：验证器红了就不许跑闸门、保存 run
   失败就不许跑闸门；两次 verifier 都带 `--feed <地址>`（不是 `--feed-file`）、第二次才带 `--json`、
   闸门拿到第二次写的那个文件；`NODE_EXTRA_CA_CERTS` 只发给两个子进程；replica 只在一个路径回那份字节，
   别的路径 404；未知选项（`--feed-file` 这种别的命令的旗标）是错误而不是默认值。最后一条端到端真跑。
   **证明它会红**：删掉「验证器红了就提前 return」→ 控制流那条打红（其余 15 条仍绿）；
   去掉保存 run 的 `--json` → 接线那条打红。恢复后 16/16 绿。
3. **`docs/blockers.md`**：三条外部阻塞收敛成一页，每条三行——解除命令 / 期望输出 / 结果放到哪个路径，
   外加「做不到时不要做什么」。旗标由已有的 `manual-check-docs.test.ts` 钉住（`docs/blockers.md`
   已加进它的 DOCUMENTS：路径必须存在、`npm run …` 必须是真脚本、`--flag` 必须是该脚本认识的）。
4. **`npm run knip` 回到绿**：它此前红在五条与产品无关的清单重复上——根 `package.json` 声明了三个
   只有 `apps/desktop` 才 import 的工作区包（`@ucad/files` / `@ucad/providers` / `@ucad/usage`，
   应用自己已经声明）、`zod` 同时出现在 `dependencies` 与 `devDependencies`、以及
   `scripts/verify-main-chain.mjs` 直接 import 的 `node-sqlite3-wasm` 在根上没有声明。
   后者的版本写成与 `packages/storage` 一致的 `0.8.60`（精确，不带区间）。`package-lock.json` 只改根条目，
   不动 npm 10/11 的 peer 标记。
5. **「审查与下一轮必须先读 DoD」成为显式一步**：本页顶部与 `README.md` 中英两半（「当前局限」开头）
   都指向 `docs/PRODUCT-DOD.md` 与 `docs/blockers.md`。`tests/contract/doc-routing.test.ts`（6 项）钉住：
   中英两半各说这两句、本页的「先读」必须在前 12 行、`docs/blockers.md` 恰好三个小节且每节三件都在
   并带一条可运行命令。反方向四条用改坏的副本驱动（少一句 / 埋到折叠线下 / 少一件 / 少一节）。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼观感签字（需要一个人）。三条的解除命令与结果落点现在都在 `docs/blockers.md` 一页里。

## 本轮（2026-11-04 深夜）五态走查的签字成本降到 5 分钟，窄窗口第一次有图

上表「权限门不可绕」还差的那一句是「真机上的**视觉**走查（排版、长中文、窄窗口）」。这一条挂了五轮，
每轮都只写「需要一个人」——而**签字成本**从没被降过：判据散在五节里，图只有 1440×900 一种，
「长中文在窄窗口是否撑破」这句判据根本没有对应的图可看。本轮不假装有人签了字，改的是**接手的人拿到的东西**。

1. **窄窗口五张图**：`docs/screenshots/states/{empty,loading,error,partial,permission}-768x700.png`。
   它们不是把宽图缩出来的，是布局门禁在 768×700（`minWidth`/`minHeight`）下拍的同一批 target。
   `tests/contract/state-walkthrough.test.ts` 读 `bootstrap.ts` 的 `minWidth`/`minHeight`，
   断言每张窄图的**文件名与像素尺寸**都等于它——一张改名冒充窄图的宽图会打红。
2. **`docs/state-walkthrough.md` 顶部加「5 分钟走查脚本」**：十张图按顺序排成一张表
   （每态宽 → 窄），每张图写明要回答哪三条判据，末尾给一行签字模板（`YYYY-MM-DD` 占位，
   故意不是真日期，所以它不会被当成一次签字）。判据本身一字未改。
3. **门禁钉住「脚本与判据是同一件事」**：脚本列出的图必须**恰好等于**各态小节点到的图，
   且顺序是「每态先宽后窄」。少一张、顺序颠倒、某态只有宽图、窄图尺寸不对，四种各有句子。
4. **HEAD 上那条红**：`6705691` 改了 `App.tsx`（`partial` 不再画首启块）却没重拍图，
   `node scripts/screenshot-sources.mjs --check` 在 HEAD 上是红的。本轮重拍并 `--write`，
   `docs/screenshots/states/partial.png` 因此变了（105296 → 80589 字节），其余宽图逐字节未变。

**证明它会红**（三条各演示一次，恢复后 16/16 绿）：
删掉 `### error` 的窄窗口行 → `error names no narrow-window screenshot … at 768x700`；
删掉脚本第 6 行 → `the five-minute script lists 9 image(s) and the state sections call for 10`；
把 `loading-768x700.png` 换成 1440×900 的图 → `is 1440x900 … the narrow picture is not narrow`。

**这一轮没有做的事**：签字本身（需要一个人看那十张图）、上传修正版 feed（无令牌）、
Windows 桌面六步（无 Windows 机器）。README 中英两半仍写着「没人看过」，`state-walkthrough.test.ts` 会拦住提前改口。

## 本轮（2026-11-05）DoD 逐句核对成为一张会红的表，字体栈与假斜体从源码断言变成计算值断言

上一轮末尾的三条「没做」一字未变：上传 feed（无令牌）、Windows 六步（无 Windows 机器）、
五态人眼签字（需要一个人）。这一轮不碰产品行为，只补两处**门禁**——因为「下一轮唯一的范围来源」
此前靠的是每个 agent 读一遍 DoD，而读漏一条没有任何东西会响。

1. **`docs/PRODUCT-DOD.md` 的每条 `- [ ]` 在 `docs/dod-status.md` 里有了一行，而且是门禁读的那一行。**
   `docs/dod-status.md` 顶部新增 `## DoD 逐项核对`：按 DoD 原句（以 `；` 为界）逐句拆开，
   条目号 `DOD-<条>.<句>`，四态 `通过 / 未过 / 外部阻塞 / 不适用`，每行带**能解析**的证据指针与
   「还差什么」。`tests/contract/dod-status.test.ts`（11 项）把它钉住：
   - 每条 DoD 句都有行，且判据**逐字**等于 DoD 原句（改一个字的措辞、把一条拆成两条，都打红）；
   - 四态之外没有第五个词（`差不多` 打红）；
   - 证据列里每个反引号指针真的存在：路径在本仓，`npm run …` 是本仓声明过的脚本——
     一个死指针和没有证据是同一件事，它读起来像证据却什么都证明不了；
   - 不是 `通过` 的行必须写「还差什么」；
   - 「四态合计」这一句必须等于实际行数（删一行、加一行都留不下一个舒服的总结）；
   - `docs/blockers.md` 还列着外部阻塞时，这张表不许全绿——两份文档不许互相矛盾。
   **它不判**某一行「应该是」什么状态：那是证据判断，每轮都会变，写进测试就变成每轮都要改的测试。
   它判的是「判断发生了、用了词表、指向了真东西」。
2. **字体栈与假斜体，从「源码里写着」变成「引擎解析成了」。**
   `tests/contract/typography.test.ts` 早就断言 `--sans` 的族顺序、`--mono` 以 `monospace` 结尾、
   以及 `styles.css` 里没有 `font-style: italic`。那三句都是关于**源码**的：
   一个不再解析的 `var()`、一个从没样式化的控件继承来的族、一个组件上的内联样式，
   都能让它们全绿而屏幕是错的。`scripts/layout-page-scripts.mjs` 的探针现在同时记录
   每个载着汉字的框的**计算后** `font-family`（按栈归组，附一个例子的元素名与文本）与 `font-style`，
   `tests/contract/layout.test.ts` 新增两条断言（41 项，1440×900 / 768×700 与窄窗口五态全覆盖）：
   - 汉字的框只落在样式表声明的两个栈上，且**各守各的承诺**：正文栈（`--sans`）必须先拉丁后中文、
     以通用族收尾；标识栈（`--mono`）以 `monospace` 收尾，**不**要求它写中文字族——
     等宽角色里的汉字（`span.faint` 的 `本轮`）落回引擎的 CJK 字回退是对的，
     一个装着不会解析的中文字族的等宽栈只是噪声。第一版断言要求每个栈都写中文字族，
     因此栽在等宽栈上，而那不是缺陷；现在那条「失败」变成另一个角色的规则，而不是被跳过。
   - 载着汉字的框，计算后的 `font-style` 不是 `italic`/`oblique`：汉字没有斜体字面，
     倾斜是引擎把正体剪切出来的，笔画会糊——而它在任何几何断言里都看不出来，
     因为被剪切的字和正体在同一个框里、一样大。
3. **中英空隙仍是「量过，决定不做」**，理由不变：扫 `apps/desktop/src/shared/i18n.ts` 全部字面量，
   「汉字紧邻拉丁字母/数字」出现 0 次；一条会拒绝「第1步」这类正常写法的规则，是把文案偏好伪装成排版错误。
   中文行首禁则已经在 `LINE_START_FORBIDDEN` / `LINE_END_FORBIDDEN` 里（上一轮），本轮没有重复加。

**证明它会红**（各演示一次，恢复后全绿）：

| 改坏的写法 | 打红的断言与原文 |
|---|---|
| 在 `styles.css` 末尾加 `.faint { font-family: Georgia, "Songti SC", serif; }` | `layout-1440#chat: span.faint (3 box(es), "@ 引用文件") was drawn with a stack the stylesheet does not declare: Georgia, "Songti SC", serif` |
| 把 `--sans` 里的三个中文字族删掉 | `layout-1440#chat: span (32 box(es), "会话") is set on the prose stack but it names no Chinese family …` |
| 加 `.faint { font-style: italic; }` | `layout-1440#chat: Chinese drawn with a synthesised italic` + 三个框（`span.faint`「@ 引用文件」、`div.faint.fs-note.mt-2`「估算值，非精确」、`span.faint`「本轮」） |
| 删掉 `docs/dod-status.md` 的 `DOD-2.2` 行 | `no row for DOD-2.2` |
| 把 `DOD-2.2` 的判据改成「回落有记录」 | `DOD-2.2 answers "回落有记录"` |
| 把 `DOD-3.2` 的四态写成「差不多」 | `DOD-3.2 has state "差不多"` |
| 把证据换成 `packages/context/src/no-such-file.ts` | `does not exist, so the row points at nothing` |
| 把证据里的脚本名换成 `package.json` 没有的（`npm run` 接一个不存在的名字） | `is not a script this repository declares` |
| 把 `DOD-4.1` 的「还差什么」改成 `—` | `DOD-4.1 is "外部阻塞" but says nothing about what is missing` |
| 把「四态合计」的通过数减一 | `四态合计 says 通过 12` |
| 把整张表改成全 `通过`（合计也改） | `docs/blockers.md: lists 3 blocker(s) but every DoD sentence is 通过` |

恢复后：`tests/contract/layout.test.ts` 41/41、`tests/contract/dod-status.test.ts` 11/11、
`tests/contract/typography.test.ts` 12/12 绿；`node scripts/screenshot-sources.mjs --check` 仍是
`PASS — 33 renderer source(s) and 14 screenshot(s) match`（本轮产品样式一行未改）。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼观感签字（需要一个人）。三条仍是上表里的缺口，不假装完成。

## 本轮（2026-11-05）「CI 等价」从一句记得住的话，变成一条读工作流的命令

上表里 `DOD-5.1` 是**未过**，还差的那半句写得具体：「CI 等价跑一次还没有留档」。这一轮做的只有它，
也只有它需要做——`DOD-4.2` 的红仍是写权限令牌，`DOD-4.1` 仍需一台 Windows 机器，五态签字仍需一个人，
三条都在 `docs/blockers.md` 里，本轮没有假装动过。

**为什么不是再贴一次 terminal 日志。** 上一轮之前，「CI 等价」的写法是
`npm test`（本机）与 `ci.yml` 里的
`xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" npm test` 加
`ELECTRON_DISABLE_SANDBOX=1`（CI）——两条不同的命令，中间靠人记得。于是「跑过一次 CI 等价」既不能
复现，也不能被检查：任何人手敲一遍都能得到一份不同的 transcript，而没有任何东西能说「这七步就是 CI 的七步」。

1. **`scripts/gate-local.mjs`（`npm run verify:gates`）读 `.github/workflows/` 的 `run:` 步骤并原样执行**：
   同样的文本（连 `xvfb-run` 的 screen 参数）、同样的 `env:`、同样的 shell 旗标（`bash -eo pipefail`）、
   同样的顺序，第一步失败就停。命令清单**没有**抄进脚本——抄一份就是第二份事实，漂移时没人看得见。
   每一步被分成三类并**打印出来**：`gate`（跑）、`setup`（`npm ci` 之类，打 `[skipped]` 带原因）、
   **无法归类**（`./scripts/check.sh` 这种：跑之前就失败，因为继续下去只会给出一条「门禁绿了」而
   那道门没跑）。`--list` 只打印计划（因此可以问「将要跑什么」而不启动 `npm test`），
   `--only` 按计划里的 id 挑一步，`--json` 留一份 run 记录。
2. **本机这一次跑（HEAD `2dba24f`，linux，node v22.23.4）**：7 个 gate 步骤全 `[ok]`，
   `test` 84.3s（94 文件 / 1490 项），`test:e2e` 28.8s（18 文件 / 147 项），build 与 clean build 各一次，
   最后一行 `PASS — 7 gate step(s) green on linux with node v22.23.4`。完整 transcript 在
   `docs/manual-verification.md`「CI 等价的一次跑」一节。
3. **`DOD-5.1` 因此改成「通过」**，证据是 `npm run verify:gates` 加那一节 transcript。这句「通过」的意思
   是：CI 执行的七条命令在本机、用同样的旗标与 env、按同样顺序全绿，并且任何人可以重跑得到同一份步骤表。
   **它仍然不是一次 GitHub 托管 runner 的运行**（内核、sandbox 情形、npm 版本都可能不同，`npm ci` 在这里是
   `[skipped]`）——这句话写进了 run 记录的 `note` 字段，也写在那份 transcript 的「不证明」段落里。
4. **证明它会红**（各演示一次，恢复后 17/17 绿）：把 `ci.yml` 的 `run: npm run knip` 改成 `run: npx knip`，
   `node scripts/gate-local.mjs --list` 立刻 `REFUSED — 1 workflow step(s) this gate cannot classify.
   Nothing was run.`，`tests/contract/ci-gate-local.test.ts` 两条同时红；把 `runStep()` 的退出码一律当成 0，
   子进程三条红（失败即红、`--only`、run 记录）。第二种是本轮真正要防的形状：**计划读得再对，命令也可以
   永远绿**——所以驱动脚本的是子进程用例，而不是只测纯函数。
5. **顺带修掉一条会自己失效的门禁用例**：`tests/contract/dod-status.test.ts` 里「四态合计对不上要打红」
   那条把 `通过 13` 硬写进断言，一旦真实合计变化，它就退化成一次静默的空替换。现在它从事先读出的
   合计里减一，再断言打红——仍然会红，但不再需要每轮改一次。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼观感签字（需要一个人）。三条仍是上表里的缺口，不假装完成。

## 本轮（2026-11-04 深夜）视觉 token 有了具名出处，登记册与样式表由门禁对齐

字号档已经被钉过两次（`typography.test.ts` 钉「每条 `font-size` 都是 `var(--fs-…)`、最多四档」，
布局门禁在真 Chromium 里量解析后的尺寸）。**其余三样从来没有具名出处**：

- **圆角**：规则里散着九个值（`0`、`2px`、`3px`、`4px`、`6px`、`7px`、`10px`、`999px`、`50%`），
  只有三个有名字（`--r-sm` / `--r` / `--r-lg`）。裸值的问题不是难看，是**下一个值不需要任何决定
  就能写进去**：`border-radius: 5px` 编译得过、门禁全绿、屏幕上多一档没人认领的圆角。
  字号档当初就是这么烂掉的（47 条规则、九个值）。
- **边线宽度**：`1px` 是发丝边，`2px` 只该出现在两处（`border-left` 强调条与滚动条滑块）。
  这句话此前只活在 `styles.css` 顶部注释里，而注释不是门禁。
- **颜色分配**：「蓝=可交互、绿=成功、琥珀=注意、红=失败，别的都不上色」是整套调色板存在的理由，
  没有任何东西把调色板与这句话对起来。

1. **`docs/DESIGN.md` 是登记册**：四张表——字号档、圆角登记（值 / token / 用在哪 / 为什么）、
   发丝边（宽度 / 用在哪 / 为什么）、铬色与强调色（token / 值 / 角色）。每个值都写了它对应哪种盒子。
   圆角**不是**「四档」：4px 高的计量条和 400px 宽的对话框，圆角的物理尺寸本来就该不同，
   所以登记的是「每个值对应一种盒子」，门禁断言的是**值集合相等**，不是「个数 ≤ 4」。
2. **`tests/contract/design-tokens.test.ts`（19 项）**：CSS 不能 `@import` 一份 markdown，
   所以「引用」的落地方式是门禁——
   - `:root` 里每个 `--fs-*` / `--r-*` / 颜色 token 都在表里且值相同，表里也不许留 `:root` 没有的行；
   - 规则里**实际用到**的每个圆角值都有登记行（`var(--r-sm)` 解析成 `4px` 再比，不是比字符串），
     登记行也不许有没人用的值；
   - 每条边线宽度都在发丝边表里，且 `2px` 只允许出现在 `border-left` 或 `::-webkit-scrollbar-thumb`；
   - `CONTRIBUTING.md` 链到登记册（没人被指过去的文档等于没人读）。
   边线扫描是**字符级**的，不是 `([^{}]+)\{([^{}]*)\}` 正则：`@media` 会嵌套，正则会把
   `@media (max-width: 860px)` 当成选择器、然后丢掉里面每条规则的选择器——而窄窗口的规则
   正是最可能长出新边线的那批。
3. **`CONTRIBUTING.md` 的「The layout language」不再复述数字**：它原来写着
   `--fs-body/note/fine` 是 `13/11.5/10.5px`，而 `--fs-note` 早就是 12px 了——一段没人比的
   副本，已经错了。现在它指向登记册，数字只有一处。

**证明它会红**（全部用真实文档的变异副本驱动，不靠嘴说）：删掉 `--fs-fine` 行 → 指名
「declared in styles.css but has no row」；把 `--fs-body` 改成 14px → 指名值不一致；
往 `.badge` 里加 `border-radius: 5px` → 指名「a new radius is a decision, so write it down first」；
删掉 `7px` 行 → 同时指名 token 与值两条；加一行没人用的 `8px` → 指名「no rule uses it」；
给 `.badge` 加 `border-top: 2px` → 指名「outside the two the register allows」；
加 `border: 3px` → 指名宽度未登记；把 `--accent` 改成 `#6d7cfe` → 指名值不一致；
删掉整张圆角表 → 红（不是空表上变绿）；把 `CONTRIBUTING.md` 里的链接改小写 → 红。

**这一轮没有做的事**：没有改 `styles.css` 一个字节。任何 CSS 改动都会让
`scripts/screenshot-sources.mjs` 的漂移门禁变红，而「重拍图」目前没有一条提交进仓库的命令
（`--write` 只是记录当前状态，它可以在没看一眼的情况下跑）。所以本轮把登记册建起来、
把两边钉住，**没有**顺手把裸圆角收成 token——那是一次需要重拍图的改动，留给下一轮连同
「重拍图成为一条命令」一起做。

门禁：`npx vitest run tests/contract/design-tokens.test.ts` 19/19 绿；
`readme` / `readme-parity` / `doc-routing` / `dod-status` / `typography` / `screenshot-sources`
共 56 项绿；`npx eslint tests/contract/design-tokens.test.ts` 无输出。

## 本轮（2026-11-04 深夜）正文行长有了下限，但只在容器给得起的时候

审查清单 A 里唯一还挂着的排版项是「正文行长约 28–40 字」。上限早就有门禁
（`MAX_PROSE_LINE_CJK = 40`，真 Chromium 里量每个换行过的中文段落的最长一行），
下限一直**故意**没有：`layout-page-scripts.mjs` 的注释写着「窄面板里短行是对的，
只有上限是阅读问题」。那句话是对的，但它把两件事混成了一件——**窄面板**里短行是对的，
**宽卡片里被 `max-width` 掐窄**的段落不是。后者才是下限该管的东西，而它此前没有任何断言。

1. **下限只在容器给得起时生效**：`MIN_PROSE_LINE_CJK = 28`，判定条件是
   「最长一行 < 28 **且** 父容器的内容宽度 ≥ 28 字」。父容器宽度减掉左右 padding 再除以字号，
   就是「这个段落本来能有多宽」。条件不成立时（768px 下的窄面板）只受上限约束。
   没有这个条件，这条规则就变成一条**关于窗口大小**的规则——本仓已经因为同样的形状
   拆过一次门禁（几何判定随视口变化）。
2. **失败信息带两个数**：`shortLines` 每条记 `longestCjk` 与 `roomCjk`，所以红的时候说的是
   「23 字，而这一列本来有 69 字」，不是「太短」。
3. **规则不许空转**：`floorChecked` 记「下限实际应用到了几个段落」，门禁要求 help 面每帧
   > 0、整轮 > 10。条件型规则最容易悄悄变成空集上恒绿，这一条把它变成测量。
   实测（1440×900 与 768×700，help/context/chat 三面）：help 2 段、context 4 段、chat 1 段
   被下限检查，`shortLines` 为空。
4. **登记册补一行**：`docs/DESIGN.md`「什么不是 token」写明行长是几何断言而不是 token，
   以及为什么两个数不在这份表里重复登记。

**这一轮没有做的事**：没有改 `styles.css` 一个字节（任何 CSS 改动都会让
`scripts/screenshot-sources.mjs` 的漂移门禁变红，而重拍图还不是一条命令）；
没有跑打包适配器解析（`npm run package` 未在本轮执行，`docs/manual-verification.md`
里 2026-11-02 那一行仍是最近一次真机记录）；DOD-4.1（Windows 真机）与 DOD-4.2（feed 上传）
两条缺口原样保留，不假装完成。

门禁：`xvfb-run -a npx vitest run tests/contract/layout.test.ts` 42 项全绿（新增 1 项）。

## 本轮（2026-11-04 深夜）五态观感走查的第一条可测量缺陷：段落收在孤字上

上表「步骤 6 的**视觉**走查」一直挂着同一句话。这一轮把「观感」拆成「机器能量到的」与「只能人眼判的」，
把能量到的那一条量出来、修掉，并让它进门禁；人眼那一半仍然没有签字（`docs/state-walkthrough.md`
的记录表照旧是「未走查」，没有日期，README 也照旧说没人看过）。

**critique（逐态，量的是排版事实，不是截图好看）**：五态 × 两个尺寸（1440×900 / 768×700），逐段走
每个换行过的中文段落，记下每个段落**最后一行的字数**。命中的是同一件事：

- `?scenario=empty`（1440×900）：`.preview-body .faint` 收在 `容。`
  ——`发送一轮指令后，这里会显示 Agent 实际收到的内容。` 断成 11 行满行 + 一行一个「容」，
  底下垫着它自己的句号。
- `?scenario=permission`（1440×900 与 768×700）：`[role="dialog"] .faint.mt-3.fs-note` 收在 `批。`
  ——「…可拦截的 Agent 会同时启用厂商原生审」/「批。」。
- 把 `text-wrap: pretty` 去掉再量一遍，命中的不止这两处：`layout-768x700#context` 的
  `p` 收在 `验。`，`div.notice.warn.mt-2` 收在 `字。`。这不是窄窗口效应，也不是某一处文案的偶然，
  是这个应用**所有**两行段落共有的收尾形状。

这就是中文排版里的**孤字行**，而它此前对每一道门禁都不可见：盒子在框里（几何绿）、没被裁
（clipped 绿）、没压字（overlaps 绿）、最长一行 28–40 字（行长上下限都绿）——
两条行长规则**故意**豁免最后一行（段末一行天生就短，后面也没有断点可查）。豁免就是孤字住的地方。

**typeset（一处声明）**：`apps/desktop/src/renderer/src/styles.css` 的 `body` 加 `text-wrap: pretty`。
量过两种修法才选的：`balance` 也能把两处清掉，但它会把短段的**每一行**都压到半栏——468px/13px 的
那条注变成 12 字一行，**低过同一道门禁的 28 字下限**，等于拿孤字换一根「树桩列」；
`pretty` 只动最后一行。修完这两处收在 3 个字，全仓其余段落一行未动。

**门禁**（`scripts/layout-page-scripts.mjs` + `tests/contract/layout.test.ts`）：
`typeset.stubLines` 记下每个「最后一行文字字数低于下限」的段落，字数**不含句读**——
`容。` 算 1 个字，`内容。` 算 2 个。下限是导出的 `MIN_LAST_LINE_GLYPHS = 2`，
和行长上下限一样先断言「量测用的是声明的那个数」，再断言所有 target 的 `stubLines` 为空。

**证明它会红**：把 `text-wrap: pretty` 那行注释掉重跑 `-t "runt line"`，
`layout-768x700#context` 报两条（`p` → `验。`、`div.notice.warn.mt-2` → `字。`）并打红；
恢复后 `tests/contract/layout.test.ts` 43 项全绿（新增 1 项）。

**顺带重拍了图**：CSS 改动会让 `scripts/screenshot-sources.mjs` 的漂移门禁变红，这一轮把门禁那一跑
产出的新截图（`.run-logs/layout/state-*-chat.png`、`panels-1440-*.png`）选进 `docs/screenshots/`，
再跑 `node scripts/screenshot-sources.mjs --write` 记录——16 张图、33 个渲染层源文件，`--check` PASS。
这条「重拍」仍然靠人复制文件，还不是一条命令（`docs/dod-status.md` 的已知盲区没有变化）。

**这一轮没有做的事**：人眼观感走查的签字（`docs/state-walkthrough.md` 记录表仍是「未走查」）、
Icon/Favicon 的 16–32px 核验、DOD-4.1（Windows 真机）、DOD-4.2（feed 上传）。四条都不假装完成。
