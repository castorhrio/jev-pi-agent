# DoD 现状对照（2026-11-03）

`docs/PRODUCT-DOD.md` 是锁定稿，不改它；这里逐条写**现在到哪一步、证据在哪、还差什么**。
勾选只代表「有可复现的证据」，不代表「已过线」——过线由审查侧判定。

| DoD 条目 | 现状 | 证据 | 还差什么 |
|---|---|---|---|
| 可证明注入 | **有证据** | Context Pack 纯函数 + 内容哈希；真机步骤 1 通过：`renderedHash=80e256b63523731c…`，同一轮重读同哈希，任务描述多一个字符变 `673b97ec35b5…`，注入原文与 `estimate="heuristic_chars_div_4"` 同屏（`docs/manual-verification.md` 2026-11-03 行） | Windows 桌面复跑一次 |
| 可解释路由 | **有证据** | 真机步骤 2 通过：7 行决策各带 rationale / confidence / 引擎，回落如实记录；`tests/contract/decision-chain.test.ts` 钉住链与实跑一致 | Windows 桌面复跑一次 |
| 权限门不可绕 | **有证据（自动化 + 五态断言）** | 执行前允许/拒绝进事件流，审计可查；`tests/contract/permission-*.test.ts`、`tests/e2e/critical-path.e2e.test.tsx`；步骤 6 的权限弹窗已进 `tests/e2e/scenarios.e2e.test.tsx`（类别/风险/资源/命令/理由五件可读，四个回答都在，点拒绝后弹窗消失且事件流里出现 `permission.resolved`） | 真机上的**视觉**走查（排版、长中文、窄窗口）仍未做 |
| Windows 安装包航运 · NSIS 产出与安装 | **未验证** | `npm run dist` 走 electron-builder 的 `nsis` 目标（`package.json` 的 `build.win`），产物 `UCAD-Setup-<版本>.exe`；未签名 | **Windows 桌面**：装一次、过 SmartScreen、把提示原文记进 `docs/manual-verification.md` |
| Windows 安装包航运 · 随包 feed 真实网络 | **红（已量到；修正版已验证干净，差一次上传）** | 能连 `github.com` 的机器上跑 `node scripts/verify-release-feed.mjs`：退出码 1，`no-sha256` + `installer-latest-url`；发布出去的 `update-feed.json` 只有 `version`/`notes`/`url`。修正版文档（URL 钉 `download/v1.0.0/`、`sha256=76bbe0c6…`、`size=122806279`，取自 GitHub 自己给该资产的 digest，不是人抄的）用同一套判定跑出**零 finding**，宿主 HEAD 回的 `content-length` 也正是 122806279（见 `docs/manual-verification.md`） | 覆盖上传 `update-feed.json` 这个 release asset——本机没有任何 GitHub 写权限令牌，`gh` 也未安装；上传后重跑一次脚本应为 0 |
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
