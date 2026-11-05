# DoD 现状对照（2026-11-06）

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
| DOD-1.2 | 界面可展示上一轮注入原文 | 通过 | `apps/desktop/src/renderer/src/components/ContextDrawer.tsx` `tests/e2e/context-hash.e2e.test.tsx` | — |
| DOD-1.3 | 改一字节哈希失配 | 通过 | `tests/contract/injection-contract.test.ts` `tests/e2e/context-hash.e2e.test.tsx` `docs/manual-verification.md` | — |
| DOD-2.1 | 每次决策记录 rationale / confidence / 引擎 | 通过 | `tests/contract/decision-contract.test.ts` | — |
| DOD-2.2 | 回落记为回落 | 通过 | `tests/contract/decision-chain.test.ts` | — |
| DOD-2.3 | 设置里引擎链与实跑一致 | 通过 | `tests/contract/decision-chain.test.ts` | — |
| DOD-3.1 | 执行前有记录在案的允许/拒绝 | 通过 | `tests/integration/ui-permission.test.ts` | — |
| DOD-3.2 | 审计可查 | 通过 | `packages/permissions/src/permission-engine.ts` `tests/integration/ui-permission.test.ts` | — |
| DOD-4.1 | Releases 上 NSIS 可装 | 外部阻塞 | `package.json` `scripts/verify-main-chain.mjs` `docs/blockers.md` `docs/manual-verification/README.md` | 需要一台 Windows 机器：装一次、过 SmartScreen、跑 `node scripts/verify-main-chain.mjs` 并 `--report` 带回报告，再用 `--judge` 判成过。**照着敲的一页**：`docs/manual-verification/README.md`。**阻塞在哪**：`docs/blockers.md` 第 2 节 |
| DOD-4.2 | 更新 feed `https` + `sha256` 校验 | 未过 | `scripts/verify-release-feed.mjs` `scripts/publish-feed.mjs` `tests/contract/release-feed.test.ts` `docs/release/REPLACE-FEED.md` | 应用侧校验已绿、修正版文档已判零 finding；**发布出去的 v1.0.0 feed 仍缺 `sha256`**，需要持有 `contents: write` 的人跑 `node scripts/publish-feed.mjs`，之后 `node scripts/verify-release-feed.mjs` 退出 0。**照着敲的一页**：`docs/release/REPLACE-FEED.md`。**阻塞在哪**：`docs/blockers.md` 第 1 节 |
| DOD-4.3 | 明文/非 URL 覆盖被拒并打日志 | 通过 | `apps/desktop/src/main/update-feed.ts` `apps/desktop/src/main/update-feed-log.ts` `tests/contract/update-integrity.test.ts` | — |
| DOD-4.4 | 未签名 SmartScreen 有说明 | 通过 | `README.md` | — |
| DOD-5.1 | `npm run typecheck && lint && knip && test && test:e2e`（及 CI 等价）绿 | 通过 | `npm run verify:gates` `.github/workflows/ci.yml` `scripts/gate-local.mjs` `scripts/temp-dir-probe.mjs` `tests/contract/ci-gate-local.test.ts` `tests/contract/temp-dir.test.ts` `tests/contract/ci-typecheck.test.ts` `docs/manual-verification.md` | — |
| DOD-5.2 | 注入/交接/凭据/更新合约测试能打红 | 通过 | `tests/contract/injection-contract.test.ts` `tests/contract/handoff-chain.test.ts` `tests/contract/keyring-gate.test.ts` `tests/contract/release-feed.test.ts` `tests/contract/app-rules-build.test.ts` | — |
| DOD-6.1 | token 来源（厂商 tokenizer vs 启发式）上屏 | 通过 | `apps/desktop/src/renderer/src/components/ContextDrawer.tsx` `apps/desktop/src/renderer/src/components/PreviewPane.tsx` | — |
| DOD-6.2 | 凭据进 OS 钥匙串，不经环境变量/日志泄露 | 通过 | `apps/desktop/src/main/keyring-gate.ts` `tests/contract/keyring-gate.test.ts` `tests/contract/secret-vault.test.ts` `tests/contract/host-secret-channel.test.ts` | — |

## 三条外部阻塞落在哪一行

`docs/blockers.md` 的三节与上面那张四态表**不是**一一对应：两条阻塞各有一句 DoD 句子，第三条没有。
这张小表就是那个对应关系，`tests/contract/dod-status.test.ts` 两个方向都核对——每一节都要在这里有一行、
每一个「未过 / 外部阻塞」的行都要在这里被点到、点到的条目号必须真的在四态表里、写「无对应 DoD 句子」
的那一行必须给出理由。所以「解除第 N 条阻塞」与「改哪一行」是同一件事，不是两件靠人记的事。

| 阻塞（`docs/blockers.md`） | 落在哪一行 | 为什么 |
|---|---|---|
| 第 1 节 · 已发布的 v1.0.0 feed 缺 `sha256` | DOD-4.2 | 那一句要求 feed 带 `sha256` 校验，而发布出去的那份没有 |
| 第 2 节 · Windows 桌面六步 | DOD-4.1 | 那一句要求 Releases 上的 NSIS 可装，而本机没有 Windows 机器 |
| 第 3 节 · 五个界面状态的人眼走查 | 无对应 DoD 句子 | DoD 没有一句要求人眼走查；它落在旧表「权限门不可绕」行的「还差什么」里，签字之后改那一行 |

第三行是这张表存在的理由：一条外部阻塞**没有** DoD 句子接着它，这件事本身要写下来。不写的话，
下一轮读四态表会以为「未过 + 外部阻塞 = 2」就是全部缺口，而 `docs/blockers.md` 上还挂着第三节。

## 阻塞关闭回执（谁签收、跑了哪条命令、退出码）

`docs/blockers.md` 的每一节都写着「解除路径」，`2ba4d18` 之后还写着「谁能关掉它」。这两样都只回答
**怎么关**，不回答**关掉之后**：谁签收的、跑的是哪条命令、退出码是多少、结果落在哪个路径。没有这一行，
「这条阻塞已经解除了」就只是一句在聊天里说过的话，下一轮读文档的人无法分辨它是「做完了」还是「没人再提」。

所以这一节是一张回执表：一条阻塞被关掉时，在这里加一行；还没关掉的，在下面「未关闭」子节点名。
`tests/contract/dod-status.test.ts` 两个方向都核对——`docs/blockers.md` 的每一节要么在表里有一行回执，
要么在「未关闭」里被点名，**不允许沉默缺席**；同一节也不能既签了回执又挂在「未关闭」里。
回执行的命令必须是本仓真有的脚本，结果路径必须真的存在，否则那一行读起来像证据、其实什么都没证明。

| 日期 | 阻塞 id | 执行的命令 | 退出码 | 结果路径 |
|---|---|---|---|---|

### 未关闭

- 第 1 节 · 已发布的 v1.0.0 feed 缺 `sha256`：**需要写权限令牌**。本机没有 `contents: write`
  令牌，`node scripts/publish-feed.mjs --apply --verify` 会直接拒绝执行，所以没有回执可签。
  拿到令牌那天，那条命令屏幕上第一行是
  `PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=…`。
- 第 2 节 · Windows 桌面六步：**需要一台 Windows 机器**。本机不是 Windows，
  `node scripts/verify-main-chain.mjs` 只在 Linux 桌面会话里跑通过。报告带回后跑
  `node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json`，
  屏幕上第一行是 `PASS — the report covers steps 1, 2, 3, 4, 5 on win32 against build 1.0.0`。
- 第 3 节 · 五个界面状态的人眼走查：**需要一个人**看过五态并签字，机器答不了这一问。签字之后
  `npx vitest run tests/contract/state-walkthrough.test.ts` 才转绿，屏幕上第一行是
  `✓ tests/contract/state-walkthrough.test.ts`。

表里现在是空的，这是**如实**的空：三条阻塞一条都没关掉。关掉第一条时，把「未关闭」里那一行删掉、
在表里加一行（日期、`第 1 节`、跑的命令、退出码、结果路径），两处一起动——只动一处会红。

### 有令牌时：第 1 节的命令序列与期望退出码

上面那张回执表是空的，因为三条阻塞一条都没关掉。但「关掉第 1 节要敲哪几条、每条退出码是多少」
不该等到有人拿到令牌那天才第一次被写下来。它现在散在三处：`docs/blockers.md` 第 1 节写着
「有令牌的人」该敲什么，`docs/release/REPLACE-FEED.md` 是照着敲的一页，`README.md` 的「当前局限」
说这条还没关。三处各说一半，读者要自己拼。

这一节把「有令牌时怎么做」收成**一条序列**，`tests/contract/dod-status.test.ts` 核对三处说的是
同一组命令：这一节里的每一条命令都必须在 `docs/release/REPLACE-FEED.md` 里逐字出现；
`docs/blockers.md` 第 1 节「有令牌的人」那一半里的每一条命令都必须在这一节里出现。
少一条、改一个旗标、把退出码删掉，红的是这一节，并指名是哪一条。

```bash
node scripts/publish-feed.mjs --rehearse                           # 退出 0 = 四条命令与期望输出都打印出来，什么都没写
node scripts/publish-feed.mjs --preflight                          # 退出 0 = 线上那份还是坏的（方向是反的）
node scripts/publish-feed.mjs --dry-run                            # 退出 0 = 计划打印完，什么都没写
GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify      # 退出 0 = 换好了，判据行是 PASS —
node scripts/verify-release-feed.mjs                               # 退出 0 = 读的一方复核通过
```

五条命令的退出码都是 0，但 `--preflight` 的 0 与其余四条的意思相反：它回答的是「线上那份
**还是坏的**吗」，所以 0 是「还是坏的，接着往下走」，1 是「已经不是坏的了」。这条反向语义写在
`docs/release/REPLACE-FEED.md` 第 0 步里，这里只重复结论，不重复理由。

第一条 `--rehearse` 是这一轮补的：它把下面四条命令与各自的期望输出一次打印出来，**不联网、
不需要令牌、不写任何文件**，所以「有令牌那天照着敲会看到什么」在拿到令牌之前就能读一遍、也能被
门禁比对（`tests/contract/publish-rehearsal.test.ts`）。它证明的是**运行手册完整**，不是线上那份
已经被换掉——那两行 `PASS —` 在预演里自己写着 `a promise, not a measurement`。

跑完之后，回执表加一行（日期、`第 1 节`、`GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify`、
`0`、`docs/manual-verification.md`），并把「未关闭」里第 1 节那一行删掉——两处一起动，只动一处会红。

## 本轮 DoD 加载来源与未勾项（2026-11-06）

**加载来源**：`/opt/agent-scheduler/docs/product-dod/jev-pi-agent-dod.md`（与 `/opt/agent-control/docs/product-dod/jev-pi-agent-dod.md`、
本仓 `docs/PRODUCT-DOD.md` 逐字相同，`diff` 为空）。控制面 `projects/jev_pi_agent.json` **没有** `dod_passed_at`，
所以本轮不是「已过线停扩」，但按「DoD 勾满即停扩」的原则，本轮仍然只做阻塞项，不加功能。

**未勾项逐条**（与上面四态表一一对应，不另立一份事实）：

| 条目 | 四态 | 现在能跑的命令 | 期望 |
|---|---|---|---|
| DOD-4.1 Releases 上 NSIS 可装 | 外部阻塞 | `node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json` | 退出 0；没有报告时退出 1 并指名缺哪一步。报告的形状见 `docs/manual-verification/report-schema.json` |
| DOD-4.2 更新 feed `https` + `sha256` 校验 | 未过 | `node scripts/verify-release-feed.mjs` | 退出 0；今天退出 1，`no-sha256` + `installer-latest-url` |
| DOD-4.2（离线演示） | 未过 | `node scripts/release-gate.mjs --simulate-missing-sha` | 退出 1，打印与真实 `npm run dist` 被挡时同一份 `REFUSED` 文案；不需要令牌、不联网 |

第三条是 2026-11-05 那一轮新增的：它把「已发布的 feed 缺 `sha256`」从三份文档里的描述，变成任何一台没有令牌的机器上
都能**看见**的一次拒绝。它不改变判定——判定仍是 `judgeFeedDocument()`，模拟只是把同一份判定离线跑一遍，
并在 `source:` 与 `[skipped]` 两行里说清「这是模拟、没有联网」。

那八行输出的**原文**现在贴在 `docs/blockers.md` 第 1 节的「没有令牌的人」一半里，与「有令牌的人」一半
分开放：前者回答「没令牌能证明什么」，后者回答「有令牌怎么做」。粘贴不是摘录——
`tests/contract/release-gate-simulation.test.ts` 把那一块与命令自己打印的行逐字比对（每条 `[FAIL]` /
`[warn]` 句子由闸门自己的 `findingLine()` 生成，本机装了应用那一侧的规则时整块比对），
所以闸门改了措辞而这一页没跟着改，红的是这一页。

## 已知残留（不修，登记）

门禁这一轮清掉的静默失败，下一轮会被重新当成**新缺陷**提出来——除非它被登记成「决定过、不做」。
这一节就是那个登记处。每一条都还在树里，每一条都**仍然会红**（登记不等于放宽），只是本轮不修，
并写清为什么不修、什么时候该修。

`tests/contract/dod-status.test.ts` 逐行核对这张表，四个方向都会打红：整节没了、一行没了、
「为什么不修」或「什么时候该修」写成空话、指针指向不存在的文件；再加一个**反方向**——
被点名的文件里必须真的有 `KNOWN RESIDUAL` 标记，标记所在的文件也必须在表里有一行。
**表与被登记的代码不许互相消失**，否则「登记」就退化成一句没人核对的话。

| 残留 | 为什么不修 | 什么时候该修 | 位置（文件里带 `KNOWN RESIDUAL` 标记） |
|---|---|---|---|
| `tests/contract/replay-feed-local.test.ts` 仍自带「缺构建」分支，而 `43dcde2` 已把另外四个消费方改成 `tests/global-setup.ts` 一次构建 | 它的端到端用例起的是**子进程**，子进程要的不止「产物存在」：还要 `openssl` 造证书，绿分支还要 release 主机应答安装包 URL。把这条分支并进全局 setup，等于声明一个本轮运行仍然满足不了的前置条件——那条分支是它自己的**可诊断拒绝**之一，不是漏 cleanup 的残留形状 | 把 openssl 探测与主机探测从这个文件拆成可单独测试的声明式前置条件之后；那一步做完，这条分支与表里这一行一起删（删一侧不删另一侧，门禁当场红） | `tests/contract/replay-feed-local.test.ts` |

一条残留一行。写三件事就够了：它现在**仍然会红**、这一轮为什么不修、删掉它的条件是什么。
「以后再说」不是条件，「等 X 被拆成 Y」才是。

## 按轮次的历史对照（旧表，保留原文）

下面这张表是**上一版**的对照表，按 DoD 的六条**大项**记，每格一段历史。它**一个字都不被门禁读取**
（`tests/contract/dod-status.test.ts` 读的是上面那节四态表与「已知残留」那张表），保留是因为它记着
每条大项背后的真机行号与缺陷故事；**下一轮的范围来源是上面那张四态表**，不是这张。

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
| 中英空隙：**字母那一半本轮收进门禁，数字那一半仍按上一轮的判断放过** | 句子侧：`apps/desktop/src/shared/i18n.ts` 的 178 处字母空格（另 3 处挨数字）分布在 90 条里、45 个插值槽 0 个紧贴汉字；引擎侧：`styles.css` 的 `--text-autospace`，常量 `MIN_HAN_LATIN_GAP_EM` / `HAN_LATIN_GAP_TOLERANCE_EM` / `HAN_CLASS` / `LATIN_CLASS` 在 `scripts/layout-page-scripts.mjs` | 句子侧 `tests/contract/typography.test.ts`（把一个空格删掉会红，指名 `i18n.ts:441` 与那一对字；`counts the boundaries the gap rule guards…` 把上面那几个数压成下限，不再是抄来的）；引擎侧 `tests/contract/layout.test.ts`（词典一字不改、只删那条声明也会红：`resolves the gap the stylesheet declared, in this engine`；带空格的 509 处每个边界加 0em；紧贴一旦出现必须给到 1/8em——本轮在 `div.faint` 上实测 0.125em） |
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

## 本轮（2026-11-05）接手的人在自己机器上跑得起来：布局门禁一行命令，无令牌也看得见同一次拒绝

审查给的 P0-2 与 P0-3 是同一件事的两面：门禁与阻塞项都写清了「敲什么」，但**敲命令的那个人所在的
机器**没有被考虑。本轮只做这两条，产品代码一行未改。

1. **`CONTRIBUTING.md` 有了一行可直接复制的布局门禁命令，而且它不是照抄建议的那一行。**
   建议里的 `xvfb-run -a npx vitest run tests/contract/layout.test.ts` 会红，两个原因都是量出来的：
   - `xvfb-run` 的默认屏幕比门禁要的最宽窗口窄（`GATED_WIDTHS` 里是 **1440**），窗口被夹到屏宽，
     门禁红在它自己那条「reports the width it actually measured」上。`.github/workflows/ci.yml`
     的注释早就写了这件事，所以正确的一行带着 `--server-args="-screen 0 1920x1080x24"`；
   - `npx vitest` 绕过 `pretest`，而套件把 `@ucad/*` 解析到 `packages/<name>/dist`——一行命令量的是
     **上一次构建留在盘上的东西**。所以 `npm run build:packages` 被写进同一个代码块里。

   `tests/contract/layout-gate-command.test.ts`（8 项）钉住这行命令与 CI 的同一条一致：屏幕尺寸
   **从 `ci.yml` 读出来比**，文档不许自带一个数；再拿门禁自己的 `GATED_WIDTHS` 量一次「CI 给的屏
   装不装得下门禁要的最宽窗口」——数字由测量决定，不由注释决定。红方向三条各驱动一次：删掉
   `xvfb-run` / 只改文档的屏尺寸 / 把文档与 CI 的尺寸一起缩到 1280（后者只剩「CI 在量一个被夹住的
   窗口」这一条真问题）。
   还有一条是**跑出来的**：把 `DISPLAY`、`XAUTHORITY`、`ELECTRON_RUN_AS_NODE` 从子进程环境里删掉，
   真 Electron 起不来，stderr 就是 `Missing X server or $DISPLAY`——文档引的正是这一句，而同一段
   必须写明它是 **Linux** 的症状（Windows/macOS 上没有 `$DISPLAY` 可缺；把 Linux 的症状写成通用的，
   等于把读者送到一个不存在的因上）。
2. **`docs/blockers.md` 第 1 节按读者分成两半**：「有令牌的人：先看，后按」与「没有令牌的人：
   同一次拒绝，离线也看得见」。后者贴的是 `node scripts/release-gate.mjs --simulate-missing-sha`
   在本机的**逐字输出**与退出码 1，并写明「这是离线演示，不是真替换」，另附「做不到时不要做什么」
   （不许把这条旗标接进 `npm run dist`，也不许改 `PUBLISHED_V1_FEED` 让演示变绿）。
   **粘贴不是摘录**：`tests/contract/release-gate-simulation.test.ts`（新增 5 项）把那一块与命令
   自己打印的行比对——每条 `[FAIL]` / `[warn]` 句子由闸门自己的 `findingLine()` 生成（不需要应用
   构建，所以 CI 上照样跑）；本机装了应用那一侧的规则时，再整块逐行比一次。三个方向各验一次：
   改一句 `no-sha256` 的措辞 → 指名那条 code；把 ```text 围栏改名 → 指名「不再贴出那次运行」；
   把「退出码 1」写成 0 → 指名它。
3. **改了一条既有门禁的红方向**：`tests/contract/doc-routing.test.ts` 的「这一节少了这一件」原来靠
   替换**全文第一处** `**期望输出**` 来制造红。第 1 节现在有两个读者、两处都写这个词，替换一处
   就不再是「这一节少了这一件」——那条用例在本轮当场变成红的对立面（`expected [] to have a length
   of 1`，即它**再也不会红**）。改成在该节 body 内替换全部出现，仍然是 1 条 problem，且真的触发得了。
4. **顺带量到的两个环境问题，都写进了 `CONTRIBUTING.md`**（它们是「下一个读者以为是自己的问题」那一类）：
   - 无 X server 时布局门禁的失败原文是 `Error: the layout probe produced no result` 加
     `Missing X server or $DISPLAY`，约半秒结束、45 项 skipped；
   - 本机 `/tmp` 有配额：写临时文件的契约测试会以 `Unknown system error -122: …, write` 失败，
     看起来像门禁坏了而不是磁盘满了。跑法改成
     `mkdir -p .run-logs/tmp && TMPDIR=$PWD/.run-logs/tmp npm test` 之后，本轮之前那两条红
     （`savedRun()` 写不进 `/tmp`）直接消失。

**这一轮没有做的事**：`xvfb-run` 那行的**绿跑没有在本机演示成**。这台机器上 `xvfb-run` 能把
`DISPLAY=:109` 交给子进程，但 X socket 与授权 cookie 都没有出现（`/tmp/.X11-unix` 里没有 `X109`，
`Xauthority` 是 0 字节），Electron 照旧报「没有 X server」。所以「这一行是绿的」这句话的证据仍然
只有 CI 那一份——本轮因此把它写成「与 CI 的命令一致」而不是「本机验过」。三条外部阻塞（无令牌 /
无 Windows 机器 / 五态没有人签字）原样不动，不假装完成。

门禁：`npx vitest run` 七个文档与门禁文件 **83 项全绿**（`layout-gate-command` 8、
`release-gate-simulation` 12、`doc-routing` 6、`manual-check-docs` 18、`handoff-packs` 11、
`dod-status` 11、`ci-gate-local` 17）；全量 `npm test` **1596 项通过、46 项 skipped**，唯一失败的
文件是 `tests/contract/layout.test.ts`——本机没有能连上的 X server（见上，与本次改动无关）；
`npm run test:e2e` 19 个文件 **149 项全绿**；`npx eslint` 对改动的三个文件无输出；
`npm run typecheck` 退出码 0；`npm run knip` 退出码 0。

## 本轮（2026-11-05）合约测试对「应用规则已构建」的要求，从四个各写一遍的分支变成一次构建

审查点名的唯一真实工程缺陷在 `tests/contract/release-gate-simulation.test.ts`：三处
`if (!RULES_BUILT) return;`。它们比 `skipIf` 更糟——`skipIf` 在报告里写着 skipped，这三处在报告里
写着 **passed**，而本机没有 `apps/desktop/dist/main/update-feed.js` 时，那三条用例一条断言都不跑。

**为什么会静默**：判断 feed 用的是应用自己的规则（`checkChannelUrl` / `normalizeSha256`，
`scripts/verify-release-feed.mjs` 从构建产物导入，不写第二份）。被测的是构建产物，于是「这一次运行
到底判了没有」取决于上一个动过这份 checkout 的人跑过什么：`npm run typecheck` 与 `npm run build`
会产出它，`npm test` 不会（`pretest` 只构建 packages），新克隆从来没有过。CI 恰好因为 Typecheck
排在 Unit tests 之前而一直绿——**这条静默在 CI 上看不见**，只有接手的人在自己的机器上才会遇到一份
「绿但什么都没判」的套件。

**改法（一次构建，而不是四处分支）**：

1. `tests/contract/app-rules-build.ts`：`ensureAppRulesBuilt()` 只在产物缺失时构建，且缺什么建什么
   （packages 的声明在，就只构建 `@ucad/desktop` 的 main；不在，先 `npm run build:packages`）。跑不动
   就抛，把 npm 自己的输出一起带出来。两条构建都带 `--force`——这不是保险，是量出来的：删掉产物再跑
   一次不带 `--force` 的 main 构建，它一字不出、退出码 0、文件照旧不存在（`tsc -b` 按
   `.tsbuildinfo` 决定写什么，不看盘）。少了这个旗标，本轮那条「缺失即红」会在最常见的坏状态下变成
   「构建成功但什么都没建」——同一件静默，下沉一层。
2. `vitest.config.ts` 的 `globalSetup` 指向 `tests/global-setup.ts`，在**任何测试文件被加载之前**、在
   父进程里跑一次。为什么不是各文件的 `beforeAll`：`pool: 'forks'` 并行起文件，四处会同时强构建同一份
   产物，而另外三处正在 import 它——那样红的是构建顺序，不是发布物。
3. 四个消费方不再分支：`release-gate-simulation.test.ts` 的三处静默 `return` 与它那条「缺构建时的
   拒绝」一并删掉；`release-gate.test.ts` 一处；`feed-writer.test.ts` 一处；`feed-pipeline.test.ts`
   六处（`refusedForMissingBuild()` 整个删除）。于是 `docs/blockers.md` 那份粘贴在每台机器上都逐行
   比对，不再有「装了应用规则才比」的第二等分支。

**证明它会红**（两份都被驱动过，不是嘴上说的）：注释掉 `vitest.config.ts` 里那行 `globalSetup` 并删掉
产物之后——

- `tests/contract/release-gate-simulation.test.ts` 整个文件失败（12 skipped），错误原文前半是
  `the app's feed rules are not built (apps/desktop/dist/main/update-feed.js), so a judgement below
  would be comparing nothing`，后半给出要跑的 workspace 构建脚本；
- `tests/contract/app-rules-build.test.ts` 两条运行时用例红、四条接线用例照绿——「接线完好、状态坏了」
  正是这一组要区分的东西；
- `tests/contract/feed-writer.test.ts` 两条命令行用例红。

把 `globalSetup` 那行恢复后，同一条 `npx vitest run` 自己把产物建回来（31/31 绿，文件时间戳就是那一跑
的），不需要任何人先跑构建。

**新增的门禁**：`tests/contract/app-rules-build.test.ts`（7 项）钉的是这件事本身会不会烂：配置仍然指着
那份 setup；setup 真的调用 `ensureAppRulesBuilt()`（只 import 不调用＝注册一个绿色空转）；构建目标与
`scripts/verify-release-feed.mjs` 自己 import 的是同一个文件（两边各写一份路径时，搬一次文件就会让 setup
去建一个没人读的东西）；构建清单里每条脚本名都在对应 manifest 的 `scripts` 里（改名会让 setup 跑一条不
存在的命令）；本轮运行时产物确实在；以及那条给新克隆看的句子仍然指名缺的文件与要跑的命令。

**顺带量到、本轮没动**：`tests/contract/replay-feed-local.test.ts` 仍留着它自己的缺构建分支——它同时还要
看 openssl 与 release 主机，那条分支不是本轮的形状。DOD-5.2 的证据列加了本轮那份门禁（合计四态不变）。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、步骤 6 的人眼观感
签字（需要一个人）。三条仍是 `docs/blockers.md` 里的缺口，不假装完成。

门禁：全量 `npm test` **1603 项通过 / 46 项 skipped**（较上一轮 +7，正是本轮新增那份门禁），唯一失败的
文件仍是 `tests/contract/layout.test.ts`——本机没有能连上的 X server，stderr 就是 `CONTRIBUTING.md` 引的
那一句 `Missing X server or $DISPLAY`；`npm run test:e2e` 19 个文件 **149 项全绿**；`npm run lint`、
`npm run knip`、`npm run typecheck` 均退出码 0。

## 本轮（2026-11-05）两处「文档复述测量」被收回成门禁，三条外部阻塞开始计时

产品代码一行未改（`styles.css` 一字未动，所以漂移门禁照旧 `PASS`，不需要重拍任何图）。本轮仍只做
两条外部阻塞的**看守**，加上上一轮 commit message 点过、却没进任何文档的那个遗留形状。

1. **同心圆差额：从一段话变成七列登记表**（`docs/DESIGN.md` + `tests/contract/design-tokens.test.ts`）。
   上一轮把「内层不许大于外层」变成了断言，却把「内层比同心值多多少」留在一段散文里。
   **那段散文是错的**：它记 `.row-item .m button` 为 `4px`，而 `styles.css` 里从来是 `3px`。
   这正是本仓反复量到的那一件事——文档复述测量，就会腐烂，而且腐烂时没有任何东西会响。
   现在这张表有七列（内层 / 外层 / 内层圆角 / 外层圆角 / 外层内边距 / 同心应为 / 实际差额）：
   前五列逐格与样式表的**解析后**值比，后两列由门禁自己的 `concentricIdeal()` 重算
   （`同心应为 = max(0, 外层 − 内边距)`，`实际差额 = 内层 − 同心应为`），所以那两列不许被顺手改成一个好看的数。
   登记的差额是 `1px`（`.more-menu button`）与 `3px`（`.row-item .m button`）。
   **断言的是「差额被登记」，不是「差额等于 0」**——方向仍然是样式表说话、文档跟着改，
   而不是为了让测试变绿去改两条按钮规则。`paddingLengths()` 只接受外层规则**真的声明过**的那些数
   （`.row-item` 认 `6` 与 `9`，登记贴着右边缘的那个 `9px`）。

2. **已知残留成为一张双向核对的表**。上一轮说了「`replay-feed-local.test.ts` 那条分支本轮没动」，
   但没说在哪——于是下一轮会把它当成新缺陷重新提一遍。现在 `docs/dod-status.md` 多了
   `## 已知残留（不修，登记）`，而 `tests/contract/dod-status.test.ts` 两头都查：
   表里每一行点名的文件必须**真的存在**且**真的带着 `KNOWN RESIDUAL` 一节**；反过来，扫描目录
   （`tests` 与 `scripts` 两棵树）里任何带这个标记的文件必须在表里有一行。唯一被豁免的是本门禁自己
   （它的源码声明了这个常量），那条豁免写在一个具名用例里而不是注释里；越过扫描根的指针
   （比如登记一个 `apps/` 下的文件）也会被指名——那是一条边界，不是一条沉默。
   登记的**理由**也与上一轮那句 commit 不同：全局 setup 已经保证产物存在，这条分支之所以还留着，
   是因为那条端到端用例起的是**子进程**，子进程另外需要 `openssl`，绿分支还需要 release 主机应答；
   它的前置条件不是一个，把它并进 `globalSetup` 等于声明一个本轮运行满足不了的条件。
   `CONTRIBUTING.md` 同步写了这一节——接手的人读的是那一页，不是某次 commit 的正文。

3. **三条外部阻塞开始计时**（`docs/blockers.md` + 新门禁 `tests/contract/blocker-freshness.test.ts`）。
   每一节的第一行现在写着「最近核对」的 ISO 日期与「重跑这一条」的命令。日期超过 **14 天**、
   写的是占位符、写的是日历上没有的那天、比这台机器的日历晚一天以上、或者把命令丢了——都打红，
   并指名该重跑哪一条、输出贴回哪里。**它证明不了「有人真的跑过」**：它只看日期新不新。
   这条盲点被写成一个用例（同一份文档，只改日期那一格，从红变绿，中间什么都没运行），不是写在注释里。
   三条**本轮各重跑了一次**，那两个日期就是这么来的：
   `node scripts/release-gate.mjs --simulate-missing-sha` 退出 1，八行与 `docs/blockers.md` 贴的那份逐字相同；
   `node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json` 退出 1，
   说的是 `report-unreadable`（那个目录里只有 `README.md` 与 `report-schema.json`）；
   `node scripts/screenshot-sources.mjs --check` 退出 0，`PASS — 33 renderer source(s) and 16 screenshot(s) match`，
   而 `docs/state-walkthrough.md` 记录表第一列仍是 `—`——没有人生成过一次签字。
   顺带把「什么算一节」收成一份（`tests/contract/blockers-doc.ts`），由本门禁与 `doc-routing.test.ts` 共用：
   两处各写一份的话，任何一份的区块正则失配就变成「一个门禁读不到东西却照旧绿，另一个还在报它那一份」。

   **驱动这条门禁时抓到两个我自己的错**，都留在这里而不是修完不提：
   `px?` 只让 `x` 可选、`p` 仍然必需，所以表里那个 `0` 格子读不出来（应为 `(?:px)?`）；
   以及 `today` 若按「 epoch 除以一天的秒数」取，就是按 **UTC** 取日子，而这一页的日期是人按
   **本地**历日写的——本机在 UTC+8，今天写的 `2026-11-05` 会被判成「来自未来」，
   一条与任何人的缺陷无关的红。现在 `todayInUtcDays()` 读本地历日再换算成 UTC 日索引，
   并另外给**一天**松弛：UTC−12 与 UTC+14 本来就相差一天，零容差会把两个都诚实的机器判成造假。

**证明它会红**（每一条都驱动过，恢复后全绿）。**同日第二刀补注**：下面第一行的输入已经不成立——
`styles.css` 里那一行本轮从 `var(--r-sm)` 改成了 `3px`，照这一行去改的人会撞上一次静默失配的
`String.replace`，而不是它承诺的那两格报错。新的写法与失配守卫在本节末尾那张表。

| 改坏的写法 | 打红的断言与原文 |
|---|---|
| `.more-menu button` 的 `var(--r-sm)` 换成 `5px` | 两格同时指名：`registers 内层圆角 「4px」 but styles.css resolves it to 5px` 与 `states 实际差额 「1px」, but the stylesheet puts it at 2px`——差额就是从内层算的，改一处必露两处 |
| `.more-menu` 的 `padding: 4px` 换成 `5px` | `registers 外层内边距 「4px」, which .more-menu does not declare (padding lengths: 5px)` |
| 新增一条 `.more-menu .item { border-radius: 6px; }` | `is a nested pair the register does not carry — a new pair is a decision, so write its delta down first` |
| 把「同心应为」那一格从 `3px` 改成 `2px` | `states 同心应为 「2px」, but the rule is 外层 − 内边距 = 7px − 4px = 3px` |
| 删掉表里那一行 / 删掉样式表里那条 `border-radius` | 两个方向各一句：`the register does not carry` 与 `nothing in styles.css nests like that any more` |
| 把「已知残留」整节删掉 | `no` 已知残留 section，句子后半是「so a non-fix that was argued for has nowhere to be written」 |
| 抹掉 `replay-feed-local.test.ts` 里的 `KNOWN RESIDUAL`（表格一字未动） | `registers` 那个文件 `but that file does not carry "KNOWN RESIDUAL"` |
| 反过来：在另一个文件写上标记而表格不加一行 | `carries "KNOWN RESIDUAL" but the register has no row for it` |
| 把某条阻塞的日期改成 30 天前 | `was last re-checked 30 days ago, over the 14 this gate allows.` 后面跟着该重跑的那条命令与结果该贴去的文档 |
| 改成晚 7 天 | `7 day(s) from now, past the 1-day slack…`；而**晚 1 天不红**——那是两个时区都诚实 |
| 写成 `YYYY-MM-DD` 或 `2026-02-30` | 都报 `is not a real YYYY-MM-DD day on the calendar`；后者靠把 `Date.UTC` 的结果**读回来比对**，而不是信它 |
| 删掉那一行 / 把命令换成一句人话 | `carries no` 最近核对 line；以及那条命令「既不是本仓能跑的脚本，也不是 `npm run` 脚本」 |

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼观感签字（需要一个人）。三条仍是 `docs/blockers.md` 上的缺口，不假装完成——本轮只是给
它们各装了一只走得动的表。`CONTRIBUTING.md` 里那一行 `xvfb-run` **仍然没有在本机验成**：本轮又跑了一次，
症状与上一轮记录的一字不差（`Missing X server or $DISPLAY` 加 `The platform failed to initialize`，45 项 skipped），
所以那一页仍然写「与 CI 的命令一致」，不写「本机验过」。

门禁：全量 `npm test` **1631 项通过 / 46 项 skipped**（较上一轮 +28：`design-tokens` +8、`dod-status` +10、
新增的 `blocker-freshness` 10），唯一失败的文件仍是 `tests/contract/layout.test.ts`——本机没有能连上的
X server，同上一轮；`npm run test:e2e` 19 个文件 **149 项全绿**；`npm run lint`、`npm run knip`、
`npm run typecheck` 均退出码 0；`node scripts/screenshot-sources.mjs --check` 仍 `PASS — 33 renderer
source(s) and 16 screenshot(s) match`。

## 本轮（2026-11-05，同日第二刀）同心圆差额做了一次决定：修，并把「登记过」换成上限

上一轮把两处的差额登记成会红的数，正文里写的是「留给下一刀」。这一刀做的是那个**决定**，
不是把差额再登记一次：两条路（修 / 留）选**修**，并且同时把「留」这条路堵死——因为「留」原来的
意思是「在表里加一行就合法」。

1. **`.more-menu button`：`4px` → `3px`。** 外层 `7px` 的角配 `4px` 内缩，同心值就是 `3px`；
   菜单项的悬停底色铺满内边距盒，首末两项贴着那条外弧，`4px` 多出来的 `1px` 在屏幕上读起来是
   底色与外框之间一道头发丝宽的缝。`3px` 不是新值——登记册里 `3px` 那一行本来就为小控件存在，
   本轮把菜单项写进那一行的「用在哪」，并在「为什么」里写明这一处的 `3px` 不是「15px 见方的盒子」
   那条理由而是同心算出来的：样式表没有长出一个没人认领的数，登记册也没有多一个不解释的行。
2. **`.row-item .m button`：保持 `3px`，停止登记差额。** `9px` 的内缩已经追过那颗 `4px` 的角，
   两个盒子碰不到同一个角——「同心」在这里不是屏幕上的事实，只是 `max(0, 4 − 9)` 落到下限的 `0`。
   按算式把它改成 `0` 是让门禁推着界面走（一颗 15px 见方的小按钮在圆角行里变成方角），方向本仓
   说过不许。登记册那两个格子因此写 `—`；对这一对仍然成立的约束只剩「内层不许大于外层」。
   这一半是**收窄**：上一轮登记的两个数，一个是缺陷（本轮改掉了），一个根本不是差额（规则对它不适用）。
3. **上限：共用角上，差额非 `0` 就是红——表写得完全准确也红。** `concentricProblems()` 那条分支
   把「记下来就合法」换掉了。此前那些用例都是改一份、让另一份指名；这条要**同时**改两份，
   让五个格子全部对上，只剩那一句关于角本身的报错。它现在有用例驱动（本轮新增三条用例里的第一条），
   不是写在注释里的能力。上限这一半，和它的另一半（**不共用角的那一对不许写数**），本轮各有了
   一条用例驱动——后一半 `docs/DESIGN.md` 上一轮就写了，只是从来没有用例走到过那一句。

**本轮自己也撞上了本仓反复说的那个形状**。上一轮那批驱动用例里，有**三处替换原文**还写着样式表
改前的字面——两处样式表的 `border-radius: var(--r-sm);`，一处登记册的整行
`4px / 7px / 4px / 3px / 1px`——另有**四处期望值**还把内层半径当成 `4px`。期望值过时只会报一条
对不上号的红；替换原文过时是另一回事：`String.replace` 静默失配，`mutated === STYLES`，被驱动的
缺陷从此不存在，而用例照旧打红，说的是别的事。这正是这里对门禁的指控：读不到东西却照旧跑下去。
本轮把**嵌套圆角这一组**的每一条 mutation 都配上了失配守卫（样式表那份是
`expect(mutated …).not.toBe(STYLES)`，登记册那份是 `.not.toBe(DESIGN)`），将来再动那两条规则时它
指名「这条 mutation 已经不再描述样式表」，而不是留一条要人猜的红。**这个文件其余几组**
（字号、圆角登记、边宽、颜色、渐变）的 mutation 还是一样的写法、还没有守卫——本轮没做，
是因为它们没有一处本轮改过原文；那是一处不对称，留在这里而不是装作已经统一。

**本轮新增的三条驱动用例**（此前这三个分支没有任何用例走到过）：

| 改坏的写法 | 打红的断言 |
|---|---|
| 样式表把 `.more-menu button` 改成 `5px`，登记册**同时**把内层圆角改成 `5px`、差额改成 `2px` | `is 2px off concentric, and the register says so`——两份完全一致，红的仍是那颗角本身 |
| `.row-item` 的内缩从 `6px 9px` 改成 `2px 3px`，登记册把外层内边距跟着重登记成 `3px`，两格仍写 `—` | `leaves 同心应为 as 「—」, but .row-item rounds its 3px of padding with a 4px corner … the concentric value is 1px` |
| 样式表一字不改，只把 `.row-item` 那一对的两个派生格从 `—` 写成 `0` 与 `3px` | `states 同心应为 「0」 and 实际差额 「3px」, but 9px of padding reaches past the outer 4px`——不共用角的一对不许写数：那个 `0` 读起来像「还差 3px，而有人解释过」 |

**本轮没有做完，所以没有 commit**：`styles.css` 一改，`tests/contract/screenshots.test.ts` 就会把
`docs/screenshots/` 判成陈旧——它比的是 `docs/screenshots/sources.json` 里记下的源码哈希，不是像素，
所以任何一次样式表改动都要重拍才能过。重拍要在真实 Chromium 里跑布局门禁，而这一条在本机
从来没有绿过（`CONTRIBUTING.md` 与上面几轮记的都是 `Missing X server or $DISPLAY`）。

比那更早的一步也没了：**这一轮整个 shell 起不来**——每条命令都返回非零、stdout 为空，连 `echo`
也一样。所以上面那些期望值**一条都没有被执行过**，它们来自对 `concentricProblems()` 与两份文档的
静态阅读；本轮没有任何「跑过 / 绿 / 退出码」的声称，`docs/blockers.md` 的三个日期也因此**没有**动过：
本轮没重跑，就没有资格让它们变新（那是 `blocker-freshness` 自己承认的盲点，不是可以顺手填的格子）。

下一轮在能跑的机器上，按这个顺序把这一刀收尾：

1. `npx vitest run tests/contract/design-tokens.test.ts`——先确认本轮改的三处替换原文、四处期望值
   与三条新用例真的对齐登记册（这一步只需要 Node，不需要显示器）。
2. 按 `CONTRIBUTING.md` 那一行跑布局门禁，它把五态的图写到 `.run-logs/layout/` 下
   （`state-*-chat.png`、`panels-1440-*.png`）。**重拍仍然不是一条命令**：要由人把用的图复制进
   `docs/screenshots/`——上一轮也这样记过，这一轮它仍然是这样。
3. `node scripts/screenshot-sources.mjs --write` 记下新的源码哈希，让漂移门禁重新对着「这一版
   渲染层」而不是上一版。
4. 全量门禁一次、commit 一次。在那之前这一刀留在工作区里别提交——提交了就是一棵红着的树。

## 本轮（2026-11-05，第三刀）那一刀的四个收尾步骤按顺序跑完，顺带删掉两张没人点名的截图

上一节留下四步，本轮**按那四步的顺序**做，每一步的结论都来自这一次跑出来的输出，不是静态阅读。
`docs/manual-verification.md` 末节「布局门禁在本机第一次跑绿」是同一件事的证据页。

1. **第 1 步：`npx vitest run tests/contract/design-tokens.test.ts` → 37 项全绿。** 上一轮担心的是
   「三处替换原文过时 → `String.replace` 静默失配、被驱动的缺陷从此不存在」与「四处期望值过时 →
   一条对不上号的红」。这两件事本轮都被跑掉了：那三条新用例（两份一起改、差额仍须为 `0`；不共用角
   的一对改内缩后必须从 `—` 换成数；不共用角的一对不许写数）加上失配守卫，37 项没有一项是空跑的。
   `3px` 这个决定因此从「工作区里的一段话」变成「门禁读得到、且真的比对过的一份登记册」。
2. **第 2 步：布局门禁需要真实 Chromium，而这一条在本机第一次跑绿——原因不是终于有了显示器，
   是那行 `xvfb-run` 在这台机器上本来就不可能成功。** 量到的三件事（命令与数字都在
   `docs/manual-verification.md`）：`/tmp` 是带**用户配额**的 tmpfs（`df` 报 `82%` / `348M` 可用，
   而**写一个字节**返回 `Unknown system error -122`）；Xvfb 的 socket `/tmp/.X11-unix/X<n>` 与
   `xvfb-run` 的 `Xauthority` 正是这样的字节，所以建不出来，而子进程仍拿到一个 `DISPLAY=:109`，
   那一头没有服务端；于是「没有显示器」与「配额挡住」打印**同一句** `Missing X server or $DISPLAY`。
   **换法**是这台机器上本来就有一个在应答的 `Xvfb :140`（`1920x1080x24`）：
   `ELECTRON_DISABLE_SANDBOX=1 DISPLAY=:140 npx vitest run tests/contract/layout.test.ts`
   → `Tests 45 passed (45)`，约 90 秒。`CONTRIBUTING.md` 现在把第二种原因与这一条能用的命令都写着，
   下一个人不会再按那条不可能成功的命令重试第二次。
3. **第 3 步：重拍不需要复制任何图——14 张已提交截图与这一跑新拍的逐张 sha256 相同。** 上一节说
   「重拍仍然不是一条命令，要由人把用的图复制进 `docs/screenshots/`」；本轮比复制更直接：把
   `.run-logs/layout/` 那 65 张的哈希与 `docs/screenshots/` 那 16 张逐张对上。对上之后只剩一件事要做，
   而它不是复制——**`.more-menu button` 那 1px 在 14 张图上移动了零个像素**，因为 `.more-menu` 是
   portal 到 `<body>` 的浮层，只有点开「更多」才会被画出来，而这 14 张没有一张拍到它打开。所以这
   1px 是被同心算式与几何门禁背书的，不是被图背书的；要让它有一张图，`scripts/layout-probe.mjs`
   得先学会点开那个菜单（本轮没做，记在下面「这一轮没有做的事」）。然后
   `node scripts/screenshot-sources.mjs --write` → `recorded 33 renderer source(s) and 14 screenshot(s)`，
   再 `--check` → 退出码 0、`PASS — 33 renderer source(s) and 14 screenshot(s) match`。
4. **第 4 步：全量门禁一次、commit 一次。** 见本节末尾「门禁」。

**顺带抓到一张真正烂在那里的图，而且它烂的原因正是「没人点名它」。** 逐张对哈希时有两张对不上：
`docs/screenshots/states/empty.png` 是 `de8cfc08…`，而文档真正引用的 `docs/screenshots/empty.png`
已经是 `831249ba…`（本轮新拍的就是这个）。前者还停在上一版渲染层，而没有任何一条门禁能说出来。
扫 `README.md`、`CONTRIBUTING.md` 与 `docs/` 下全部 markdown：**这两张是整个目录里仅有的、没有任何
文档指向的 PNG**，其余 14 张各有 1 到 4 处点名。`docs/screenshots/sources.json` 是唯一知道它们
存在的东西，而那份 manifest 由跑 `--write` 的人重写——所以「没人看的图」同时「没有任何东西在看它」，
正是本仓已经命名过三次的「绿而什么都没判」，只是这次它在文档侧。

改法不是「以后记得看一眼」，而是把它变成一条会红的断言：**`docs/screenshots/` 里每张图都必须被某个
文档点名**（`tests/contract/screenshots.test.ts` 现 13 项，新增 4 项）。两张孤儿图因此删掉——
`states/error.png` 与 `error.png` 逐字节相同、`states/empty.png` 的信息在 `empty.png` 里是更新的那一份，
删掉不丢任何画面。

**证明它会红**（本轮两条驱动各演示一次，恢复后全绿）：

| 改坏的写法 | 打红的断言与原文 |
|---|---|
| 往 `docs/screenshots/states/` 复制一张没有任何文档点名的 `orphan-demo.png` | `has a reader for every picture in docs/screenshots/` → `these screenshots are committed and no document points at them, so nothing keeps their bytes honest — name each one in a document, or delete it: docs/screenshots/states/orphan-demo.png`（真实树上跑的，不是合成输入；删掉后 13/13 恢复绿，`--check` 仍退出 0） |
| 把三份文档里 `docs/screenshots/states/loading.png` 的引用全部改名（合成输入，不落盘） | 同一个用例指名那一张，且**只有**那一张；前置一条 `expect(touched).toBeGreaterThan(0)`——一次匹配不到的替换会让用例比较两份相同的 Map 并打绿，那是本仓对 `String.replace` 已经付过一次的学费 |

**关于上一轮那句「整个 shell 起不来」，本轮的量测**（这是推断，证据写在这里而不是当作结论）：
命令**在执行**——本轮往本仓写的文件都建得起来，门禁真的跑出了 `45 passed`。看不到的是 stdout 与
退出码：任何命令的捕获文件都落在 `/tmp` 下（本会话的是 `/tmp/qoder-cli-1000/…`），而那里写不进一个
字节。上一轮记的「连 `echo` 也一样」和 `/tmp/.X11-unix` 里没有出现 `X109`、`Xauthority` 是 0 字节，
与这条是同一个原因的两面。本轮的绕法是把输出重定向进被 `.gitignore` 忽略的 `.run-logs/` 再读回来，
所以每一句「跑过 / 绿 / 退出码」都来自这一次真实运行，不是静态阅读。

**这一轮没有做的事**：
- **`.more-menu` 打开时的那张图**：门禁拍不到点开浮层的瞬间（探针只会 `loadURL`，不会点），所以那
  1px 的观感目前没有像素证据。要让 `scripts/layout-probe.mjs` 先学会点开菜单再拍，那一跑会同时
  改到所有 target 的稳定帧定义，不是一行；
- **`polish` 那一刀**：审查建议的 P0-2（界面文案与 `README.md` 中文半部分去 AI 味道）本轮没做。
  它需要「先 critique、再逐条改、每条改完重拍五态图」——本轮刚把重拍这条路跑通，把它同时用在
  两件改动上会让一次 commit 里混两种判定；
- **上传修正版 feed**（无令牌）、**Windows 桌面六步**（无 Windows 机器）、**五态人眼签字**（需要一个人）。
  三条本轮各重跑了一次它们的命令，退出码是**这一轮跑出来的**：
  `node scripts/release-gate.mjs --simulate-missing-sha` → 1（八行与 `docs/blockers.md` 贴的逐字相同，
  由 `tests/contract/release-gate-simulation.test.ts` 比对着）；
  `node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json` → 1，说的是
  `report-unreadable`；`node scripts/screenshot-sources.mjs --check` → 0。所以 `docs/blockers.md` 上那三个
  2026-11-05 的日期本轮**不需要**改新——它们本来就是今天，而现在它们背后各有一次真实的退出码。

门禁（本轮各跑一次，数字是这几跑打印的）：
`TMPDIR=$PWD/.run-logs/tmp DISPLAY=:140 ELECTRON_DISABLE_SANDBOX=1 npm test` →
`Test Files 105 passed (105)`、`Tests 1683 passed | 1 skipped (1684)`；
`npm run test:e2e` → `19 passed (19)` / `149 passed (149)`；`npm run typecheck`、`npm run lint`、
`npm run knip` 均退出码 0；`node scripts/screenshot-sources.mjs --check` → 退出码 0，
`PASS — 33 renderer source(s) and 14 screenshot(s) match docs/screenshots/sources.json`。

**这一轮 `npm test` 第一次不再有那个「唯一失败的文件是 `tests/contract/layout.test.ts`」**——上面那条
命令里加的 `DISPLAY=:140` 就是原因，不是运气。四个数也对得上，不需要读者猜：
`1631`（上一轮在 HEAD 上跑的）+ `3`（上一刀写进 `design-tokens.test.ts`、但因为 shell 起不来**一次都没跑过**
的那三条驱动用例）+ `45`（布局门禁从 skipped 变成 real run）+ `4`（本轮孤儿图那四条）= `1683`；
`46 skipped` 里有 `45` 条正是布局门禁本身，剩下的 `1` 条与本轮无关。

**这一轮没有做的事**里那条 `polish` 仍然是欠的：界面文案与 `README.md` 中文半部分的去 AI 味道，
需要一次「先 critique、再逐条改、每条重拍」的独立一刀。本轮把重拍这条路第一次跑通（哈希对得上、
`--write` 之后 `--check` 绿），下一刀改文案时不必再先解决「拍了放哪儿」。

## 本轮（2026-11-05，第四刀）加载态那两张图是「已经加载完」的照片，而拍它的那一帧从来没被 resize

审查本轮建议的是 `.more-menu` 打开态的图与 `polish` 那一刀。这两条都没做——做的是另一件事，
理由写在下面第一句：**逐张对哈希时量到，`docs/screenshots/` 里有两张图在说谎**，而说谎的那两张正是
`docs/state-walkthrough.md` 与 `docs/manual-verification.md` 发给走查人的「加载态」证据。五态签字这件事
卡了六轮，每一轮都在说「缺一个人」；而这一次缺的不是人——**拿着图的人也答不了那三条判据**，
因为图上是加载完的界面，两处 `加载中…` 一张都没有。这条不改，签字这一项仍然不可能完成。

1. **量到的第一件（产品证据侧）**：`docs/screenshots/states/loading.png` 与 `docs/screenshots/chat.png`
   **逐字节相同**（`sha256:d9490b3da032…`），`states/loading-768x700.png` 与 768×700 那张已加载的界面
   逐字节相同。上一轮那句「14 张图与这一跑新拍的逐张 sha256 相同」是真的——图没抄错，**抄来的那一帧
   本身就不是加载态**。根因写在 `apps/desktop/src/renderer/src/dev/scenarios.ts` 里，而且写得明明白白：
   「`loading` delays every read, so the settled screen is the ordinary populated one」——这一态只是把
   每次读取推迟 120ms，settle 之后就是一般的 populated 界面。而 `state-loading*` 这两个 target 走的正是
   `waitForData()`（`await seam.idle()`），所以它们拍出来的一定是加载完的画面。
   `docs/manual-verification.md` 那一行承诺的是「读取未返回的那一帧：会话列与对话区都在说「加载中…」」
   ——文档承诺的东西，图里一个像素都没有。
2. **量到的第二件（门禁侧，是前一件能藏住的原因）**：`scripts/layout-probe.mjs` 的 in-flight 分支
   **从不调用 `setContentSize`**。它 `loadURL` 之后直接跑 `inFlightScript()` 再拍照，于是窗口停留在
   **上一个 target 留下的尺寸**上：`loading-frame` 那个 target 声明 1440×900，实际拍到的是 768×700。
   没有任何一道门会响，原因是这套门禁自己的规则把这一行挡在外面——in-flight 的结果带
   `geometry: false`，而所有比尺寸的断言只遍历 `GEOMETRY`（`geometry !== false`）。
   **一行「量的是内容不是几何」的豁免，让同一行关于尺寸的谎话一起免检了。**
3. **改法**（产品行为一字未动，动的是探针与门禁）：
   - in-flight 分支在跑页面脚本之前先按 target 声明的尺寸 `setContentSize` 并等两帧，
     和 settled 分支同一条路径；`step()` 里打印这一次 resize，崩了也报得出死在哪一步。
   - `tests/contract/layout.test.ts` 新增一个 768×700 的 in-flight target（`loading-frame-tight`），
     窄窗口那一张从此有它自己的等待帧，而不是宽图的降级替身。两个 target 都用
     `IN_FLIGHT_SCENARIO` 拼 URL——`scenario-states.test.ts` 不许 target 手写状态名，这一条照旧绿。
   - 三条新断言（见下面那张表），其中两条是**关于图本身的元数据**，不是像素比对：这张图画在哪个窗口上
     （读它自己的 IHDR），以及两个不同状态不许是同一份字节。文件头原本写着「截图只作证据，绝不做断言」，
     本轮把那句改成写清楚**哪两种关于图的断言是允许的**，否则文件与自己矛盾。
   - `tests/contract/screenshots.test.ts` 新增一张「已提交的图不许两张逐字节相同」的门禁
     （`duplicateGroups()` 是纯函数，四条款）。上一轮 `states/error.png` 与 `error.png` 相同是**人眼**发现
     后手工删掉的；这一轮同一形状第二次出现，说明它需要的是一条规则而不是又一次好眼力。
   - 两张加载态图重拍为真正的等待帧，`node scripts/screenshot-sources.mjs --write` 重新记账。
4. **本轮量到的两处「settle 之后的加载态」与「已加载」的关系，也被写成断言**：
   `state-loading-chat.png` 与 `layout-1440-chat.png` 必须逐字节相同。这句话听起来像缺陷，实际是把
   `apps/desktop/src/renderer/src/dev/scenarios.ts` 里那句散文变成会红的数——**哪天 fixture 改成真的一直不返回，这一条会红**，
   红的时候该做的是重读 `layout.test.ts` 顶上那段注释（那里写了「先别删任何一半」），而不是把断言放宽。

**证明它会红**（三条都是本轮真实跑出来的原文，不是推演；恢复后全绿）。

| 当时的写法 | 打红的断言与原文 |
|---|---|
| HEAD 上的探针（in-flight 分支不 resize） | `layout.test.ts > layout in a real browser engine > photographs each in-flight frame at the size that target declares` → `loading-frame: the picture is 768x700 and the target declares 1440x900 — the window was never resized to the size being measured: expected { width: 768, height: 700 } to deeply equal { width: 1440, height: 900 }`（同一次跑 46 passed / 1 failed，93.63s） |
| HEAD 上那两张已提交的加载态图 | `screenshots.test.ts > no two committed screenshots are the same picture > finds no two pictures with the same bytes` → `these committed screenshots are the same bytes under different names, so the documents that point at them are showing one picture to two audiences: docs/screenshots/chat.png == docs/screenshots/states/loading.png (sha256:d9490b3da03231833ce39d0ffec6e6c8a9085065f9315c1082360c3dc1122624)`（2 failed / 15 passed） |
| 本轮我自己犯的错：上一次跑还没写完就复制图 | 于是 `states/loading.png` 里装进了一张 768×700 的图，当场红在既有那条上：`docs/state-walkthrough.md: docs/screenshots/states/loading.png is 768x700 and the app opens at 1440x900 — retake it, or the walkthrough is judging a window the product does not open`。同时新的重复门禁也红了——两张加载态图变成同一份字节。**复制图之前必须等那一次跑打印出结果**，这句话写在这里而不是当作已经发生过的事 |
| 把入库的加载态图换成 settled 那一帧（也就是本轮开始前的状态） | `ships loading-state pictures that are not photographs of a finished load` → `docs/screenshots/states/loading.png is the same picture as layout-1440-chat.png: the walkthrough asks a person to judge what a waiting screen looks like using a photograph of a screen that already loaded. Copy the in-flight frame instead — the probe writes it as loading-frame.png / loading-frame-tight.png` |
| 合成输入：把一张已提交图的字节挂到第二个名字上 | 同一个 describe 里 `names the pair when a real picture is filed under a second name` 指名那一对。这一条本轮修过一次：它原本取目录里第一张图当诱饵，而真实树上**已经有**一对重复，于是报出来的是三个名字——现在先数一遍 digest，取一张当前唯一的图，并留一条「一张都不唯一就说明上面那条已经判了整棵树」的前置 |

**这一轮没有做的事**：
- **`.more-menu` 打开态那张图**（审查本轮的 P0-2）：仍然欠。探针现在有了「先按声明尺寸 resize 再取证」
  这条路，点开浮层需要的正是这条路，所以下一轮做它时不必先解决「量的是哪一帧」；
- **`polish` 那一刀**（P0-1）：仍然欠，理由与上一轮同——它需要独立的 critique→逐条改→每条重拍；
- **上传修正版 feed**（无令牌）、**Windows 桌面六步**（无 Windows 机器）、**五态人眼签字**（需要一个人）。
  三条本轮各重跑一次，退出码是这一轮跑出来的：`release-gate.mjs --simulate-missing-sha` → **1**
  （八行与 `docs/blockers.md` 贴的逐字相同）；`verify-main-chain.mjs --judge …win-YYYYMMDD.json` → **1**
  （`report-unreadable`，那个目录里仍然没有报告）；`screenshot-sources.mjs --check` → **0**
  （`PASS — 33 renderer source(s) and 14 screenshot(s)`）。`docs/blockers.md` 上那三个 2026-11-05
  的日期因此不用改新，也不需要改旧——它们背后各有一次今天的真实退出码。

门禁（每一条都是本轮跑出来的）：
`TMPDIR=$PWD/.run-logs/tmp DISPLAY=:140 ELECTRON_DISABLE_SANDBOX=1 npm test` →
`Test Files 105 passed (105)`、`Tests 1690 passed | 1 skipped (1691)`；
`npm run test:e2e` → `19 passed (19)` / `149 passed (149)`；`npm run typecheck`、`npm run lint`、
`npm run knip` 均退出码 0。两个数对得上：`1683 + 3`（本轮布局那三条）`+ 4`（截图那张新表四条）`= 1690`；
布局门禁本身从 `45` 条变成 `48` 条，跳过的仍然只有那 1 条与本轮无关的。

## 本轮（2026-11-05 夜）判绿/判红那两块样例，从「照着写的」变成「命令打印的」

`docs/manual-verification/README.md` 是 DOD-4.1 的带回包，它教读者认两样东西：一份判绿的输出、
一份判红的输出。两块都是手写的，而手写的输出错在**块的形状**上，不在句子上——所以
`handoff-packs.test.ts` 看不见：它钉的每个片段都在，也都还在脚本源码里。

量到的两处：

1. **判绿那块从 `PASS —` 开始**，漏掉了命令在它之前打印的六行（`report:`、`platform:`、
   五行 `step N: pass`）。照着这一页敲的人会看到六行没被承诺过的输出，然后自己判断是不是哪里错了。
   「期望输出」和命令打印的东西对不上，正是这一页最不该犯的错。
2. **判红那块指向 `docs/manual-verification/win-20261105.json`**，一个不存在的文件。这一页自己的
   规矩是「报告是带回来的，不是编的」，然后它拿一份编出来的报告当期望输出——读者无法复现。

改法是把样例接到一次**真的运行**上，而不是再抄一遍：

- `tests/fixtures/judge/{fail,green,claim}.json` 三份报告夹具，`note` 字段自己写着「这是夹具，不是证据」；
- 这一页在每个样例上方写一行命令（`` `node scripts/verify-main-chain.mjs --judge tests/fixtures/judge/…` ``），
  下面的块就是那条命令的**完整输出**，从第一行到最后一行；
- `tests/contract/judge-samples.test.ts` 跑 `judgeReportCommand()`，把块与输出逐行比对，并核对退出码
  （`fail` → 1、`green` → 0、`claim` → 1）。唯一的归一化是第一行：命令打印解析后的绝对路径，
  这一页按仓库根目录写成相对路径，其余逐字。

第三份夹具 `claim.json` 是这一轮补的：五行 `pass`、证据行是占位符。它教的是「说 pass 却什么都没记」
这一种红——和「某一步 fail」是两种红，下一步动作不同，只给一种读者就认不出另一种。

**证明它会红**（本轮真实跑出来的）：把判绿那块改回从 `PASS —` 开始，`judge-samples.test.ts` 当场红在
`are what the command prints, line for line`，并指名 `tests/fixtures/judge/green.json` 的行数与命令打印的
行数不一致；恢复后 7/7 绿。另外四条反向用例（改一个字、删掉一个样例、多贴一个本检查不跑的报告、
块里少一行）各自打红，都是纯函数驱动，不碰磁盘。

**这一轮没有做的事**：三条外部阻塞一条都没解除（无令牌、无 Windows 机器、无人眼签字），
`docs/blockers.md` 上那三个 2026-11-05 的日期照旧；本轮改的是「读者照着这一页敲，看到的东西对不对」，
不是「阻塞解没解」。

门禁：`npm run typecheck`、`npm run lint`、`npm run knip` 退出码 0；`npx vitest run tests/contract/judge-samples.test.ts
tests/contract/handoff-packs.test.ts tests/contract/manual-check-docs.test.ts` → 39 passed。

## 本轮（2026-11-05，第五刀）解除一条阻塞时「总数也要跟着动」变成会红的断言，本机全量门禁第一次留档

上一轮末尾的三条「没做」一字未变：上传 feed（无令牌）、Windows 六步（无 Windows 机器）、
五态人眼签字（需要一个人）。这一轮只做审查给的三个 P0，产品代码一行未改。

1. **解除一条阻塞时，`docs/dod-status.md` 顶部那句四态合计也要一起改——现在有断言了。**
   此前 `blocker-closing.test.ts` 钉住「`blockers.md` 节数 = 演示页块数 = `DEGRADED_COMMANDS` 长度」，
   `dod-status.test.ts` 钉住「四态合计 = 表里的行数」，但**没有**任何东西把这两件事连起来：
   删掉第 1 节、把 DOD-4.2 改成「通过」、把合计从「未过 1」改成「未过 0」，这三处只有前两处会红。
   现在 `dod-status.test.ts` 新增 `describe('closing a blocker moves the total, not only the section')`（6 项），
   断言一条跨文档的恒等式：

   ```
   未过 + 外部阻塞  ==  blockers 节数 − 映射到「无对应 DoD 句子」的节数
   ```

   左边是四态表说「还缺什么」，右边是阻塞页说「有几条要解除」。两个方向各驱动一次：
   删掉第 1 节而 DOD-4.2 仍是「未过」→ 指名 `DOD-4.2 is still "未过", but docs/blockers.md no longer has 第 1 节`；
   把 DOD-4.2 改成「通过」并同步合计、却留着那一节 → 指名
   `closing a blocker moves the total, not only the section` 并给出两边的数。
   同一句话也写进了 `docs/blockers.md` 三处 `### 解除时` 的末尾——**改文档的人读的是那一节，不是测试文件**，
   而那句话本身也被断言钉住（三节里少一句就红）。
2. **`scripts/test-local.mjs` 的 scratch 目录与 `.gitignore` 的那一行，从「两处各自正确」变成「同一个常量」。**
   脚本导出 `TEMP_DIR_ENTRY = '.tmp/'`，`--dry-run` 多打一行 `temp-dir-entry: .tmp/`，
   `tests/contract/local-test-env.test.ts` 从脚本**导入**这个常量（不再自己写一份 `.tmp/`），
   断言 `.gitignore` 的那一行逐字等于它、`--dry-run` 报出来的名字也等于它。
   红方向：把脚本里的 `.tmp/` 改成 `.tmp-scratch/`（内存变异）→ 指名「脚本写的目录与 `.gitignore` 挡的目录
   是两个会各自正确却指向不同地方的事实」。脚本同时加了「只有作为入口点才跑」的判断，
   否则测试 import 它拿常量会启动一次全量套件。
3. **本机全量门禁第一次留档**（`docs/manual-verification.md`「本机全量门禁的一次跑」一节）：
   `typecheck` / `lint` / `knip` / `test:local`（109 文件 1805 项）/ e2e（20 文件 154 项）退出码全 0，
   `layout.test.ts` 在真 Chromium 里 48 项全绿。**顺带量到一件事**：裸的 `npm run test:e2e` 在本机
   20 个文件里 18 个红在 `import` 那一行（`ENOENT … /tmp/<hash>/client/<hash>`）——`vite` 的依赖缓存
   也写在 `os.tmpdir()` 下，与 `npm test` 同一个根因，而 `test:local` 原来只覆盖了单测。
   替代命令 `npm run test:local -- --config vitest.e2e.config.ts` 已写进 `docs/blockers.md`，
   并由 `local-test-env.test.ts` 钉住「这一节点名的配置文件名 = `package.json#scripts['test:e2e']` 里的那一个」。

**证明它会红**（各演示一次，恢复后全绿）：把 `docs/dod-status.md` 的 DOD-4.2 改成「通过」并同步合计 →
`未过 + 外部阻塞 = 1 row(s) (DOD-4.1), but docs/blockers.md has 3 section(s) and 1 of them map to
"无对应 DoD 句子", so 2 DoD row(s) should be blocked — closing a blocker moves the total, not only the section`；
删掉 `docs/blockers.md` 第 1 节 → `DOD-4.2 is still "未过", but docs/blockers.md no longer has 第 1 节`；
把脚本的 `.tmp/` 改成 `.tmp-scratch/` → `does not declare '.tmp/' as its scratch directory`。

门禁：`npm run test:local -- tests/contract/dod-status.test.ts tests/contract/local-test-env.test.ts
tests/contract/blocker-closing.test.ts tests/contract/doc-routing.test.ts tests/contract/blocker-freshness.test.ts`
76 项全绿；`typecheck` / `lint` / `knip` 无输出。

**这一轮没有做的事**：上传修正版 feed（无令牌）、Windows 桌面六步（无 Windows 机器）、
步骤 6 的人眼观感签字（需要一个人）。三条仍是上表里的缺口，不假装完成。

## 本轮（2026-11-05，第六刀）文档指向的每一张图都要能打开，表里写的尺寸要是那张图的尺寸

上一轮末尾的三条「没做」一字未变：上传 feed（无令牌）、Windows 六步（无 Windows 机器）、
五态人眼签字（需要一个人）。这一轮只做「文档对一张图说的每句话都要能被量」，产品代码一行未改。

1. **反向门禁早就有了，正向没有。** `screenshots.test.ts` 问的是「每张入库的图有没有人点名」，
   `state-walkthrough.test.ts` 问的是「走查那十张在不在」。**没有人问「文档里这条路径打不打得开」**——
   而那是读者真正会撞上的那一问。缺口在没接线的两份文档里：`docs/demo-script.md` 用一个大括号
   简写点名五张窄图，`docs/manual-verification.md` 用一张表点名十张，两处都没有任何东西去解析。
   改一张图的名字、漏改其中一份文档，仓库是绿的：清单还记着那个文件，孤儿检查还能找到一处提及，
   读者拿到的是 404。
2. **`scripts/screenshot-sources.mjs` 新增三个纯函数**：`expandBraces()`（`{empty,error}.png` 展开成
   两条路径，嵌套与未闭合都按「原样返回」处理——展不开的引用仍然是一条引用，丢掉它就等于藏起它点名的文件）、
   `collectDocScreenshotRefs()`（一份 markdown 里每一处 `docs/screenshots/**.png`，带行号与
   `inLog` 标记）、`markdownDocuments()`（README + CONTRIBUTING + `docs/**/*.md`，从
   `screenshots.test.ts` 里搬过来，现在只有一份）。
3. **「带日期的标题是日志，不带日期的是指令」**。`docs/dod-status.md` 与 `docs/manual-verification.md`
   的带日期小节记的是每一轮做了什么，而一轮里做的事包括删掉一张没人点名的图——那两份文档点名
   `states/empty.png`、`states/error.png` 正是因为它们被删了。把日志当指令读，日志就没法写；
   为了让门禁变绿去改历史，是这个仓库在别处一律拒绝的事。所以规则是：只有指令必须打得开。
   这条规则不是藏引用的许可——`screenshot-refs.test.ts` 的第二条是另一半：**只被日志点名的图没有读者**，
   它是孤儿（日志说它被删了，而文件还在，就是一份没人维护的字节）。
4. **走查表里那一列 `尺寸` 也是断言了。** `pictureProblems` 读的是**小节**（每态一张宽图一张窄图、
   各自等于产品开窗/最小窗口），它一个字都没说表里那一列——而表才是走查人打开图之前读的东西。
   一行写着 `1440×900` 而文件是 768×700，此前是绿的。现在 `sizeClaimProblems()` 逐行比对
   IHDR，并断言十行都在（五态 × 两个尺寸，少一行就是有一行要读者自己猜）。

**证明它会红**（两条都是本轮真实跑出来的原文，恢复后全绿）：

| 当时的写法 | 打红的断言与原文 |
|---|---|
| 把 `docs/demo-script.md:144` 的 `states/partial.png` 改名成 `partial-moved.png` | `screenshot-refs.test.ts > resolves every screenshot a document sends a reader to` → `docs/demo-script.md:144 sends a reader to docs/screenshots/states/partial-moved.png, which is not in the repository` |
| 把走查表第 7 行的 `1440×900` 改成 `768×700` | `state-walkthrough.test.ts > the size the script table claims for each picture is the picture` → `docs/state-walkthrough.md: the script table says \`docs/screenshots/states/partial.png\` is 768x700 and the picture is 1440x900 — a walker opening it is told the wrong size` |

**这一轮没有做的事**：三条外部阻塞一条都没解除（无令牌、无 Windows 机器、无人眼签字），
`docs/blockers.md` 上那三个 2026-11-05 的日期照旧；`postbuild` 只在 `npm run build` 走这条反馈回路缺口
（审查缺陷 3）仍然登记不修——把 `postbuild` 挂到 `npm test` 会拖慢日常测试，是权衡不是缺陷。

门禁：`npx vitest run tests/contract/screenshot-refs.test.ts tests/contract/screenshots.test.ts
tests/contract/state-walkthrough.test.ts` → 9 + 17 + 33 全绿；`node scripts/screenshot-sources.mjs --check`
→ `PASS — 34 renderer source(s) and 14 screenshot(s)`。

## 本轮（2026-11-06）中英混排间距：把上一轮那句「决定不做」拆成「字母做、数字不做」

起点是审查清单 A 里唯一还没过的一条——**中英文之间要有适度的空隙**。上一轮量过一次这件事，
并在上面那张索引表里写下「量过，决定不做」，理由是「一条会拒绝『第1步』这类正常写法的规则，
是把风格偏好伪装成排版错误」。本轮没有推翻那句话，而是把它混在一起的两件事分开：

- **汉字紧邻拉丁字母**（`显示Agent`、`改base_url`）：这不是风格偏好。而且它**复制到别处会丢**——
  引擎的空隙只在屏幕上存在，同一句话被抄进 handoff 提示词、issue 或纯文本日志时一个像素都不剩。
  所以这一半收进门禁，管在写字面的地方。
- **汉字紧邻数字**（`第1步`、`3条改动`）：中文里的正常写法，上一轮的判断继续成立。
  屏幕上它由 `text-autospace` 负责，而那是引擎那一半的事，不是文案的错。

五条实现，都是先量再写：

1. **「什么算汉字」收成一份**。`HAN_CLASS` / `LATIN_CLASS` 从 `scripts/layout-page-scripts.mjs`
   导出，页面脚本的正则由它插值，`tests/contract/typography.test.ts` 从同一份源码读回。
   此前 `typography.test.ts` 自己另写了 `U+4E00–U+9FFF`，比测量的范围窄：同一句中文，
   字典侧放行而量测侧要管，两侧各自看着都对，diff 里看不出来。
2. **句子侧**：665 条中文值扫下来「汉字紧邻拉丁字母」0 处；已经写了空格的 178 处，分布在 90 条里
   （另有 3 处挨的是数字）；插值槽位 45 个，没有一个紧贴汉字——所以这条规则今天是零成本的，
   它只挡下一句。**槽位也算**：写句子的人看不到将来填进来的是什么，而本仓的槽位多数是路径、键、
   引擎名。这几个数从本轮起不是抄的：`typography.test.ts` 新增
   `counts the boundaries the gap rule guards, so the guard is not green over nothing`——先用六条
   fixture 钉住每种形状各算出几个（计数器本身若能看见紧贴的字母、数字、槽位，才有资格说「词典里
   是 0」），再对真词典压下限：空格 > 100、槽位 > 20、紧贴的字母与紧贴的槽位必须为 0。
3. **引擎侧量法换了**。第一版读的是「后一字的左缘减前一字的右缘」，而**开关 `text-autospace`
   那个数一动不动**——因为 Chromium 把 autospace 加在*前一个字的前进宽度*上，两个边缘一起走，
   差值只剩侧 bearing。现在量的是同一对字的 range 在继承值下与 `no-autospace` 下的宽度差，
   除以**那个汉字自己的字号**（一行里混排的字级字号不同）；这条差值是会动的：带着声明量到
   0.125em，删掉声明量到 0em，两个数都在下面那张表里。
4. **两个方向都量，因为今天只有一个是实数**：屏幕上紧贴的边界 **0** 处、带空格的 **509** 处
   （64 个进门禁的帧，共扫 66 帧）。带空格那 509 处必须加 0em——否则中文散成一列洞，这是「适度」
   的另一半，也是本轮唯一能压在真墨上的断言；紧贴那 0 处一旦出现就必须给到 1/8em。
   非空性由 `spacedBoundaries > 100` 与 `crossRunEdges > 50` 两个计数保证，不是由一句「应该会量到」
   保证——后一个数（本轮 225 处，单帧 0 到 13 处）同时也是「这遍真的走过两个框的接缝」的证据。
5. **草稿里的数复测不上，就改成量出来的**。这节第一版写的是 453 处带空格边界、「22 处槽位两侧都带
   空格」、「每帧 1 到 13 处接缝」；重跑一遍是 **509 处**（64 个进门禁的帧）、**45 个槽位、0 个紧贴
   汉字**、**0 到 13 处**（合计 225）。复测顺手清掉两处「设计改了、代码留在原地」的东西：元素遍历里
   为这条规则加的 `pendingSpace`（连同从没被读过的 `node`/`index`/`space` 三个字段）和 flow 遍历旁边
   没人调用过的 `edgeOf`——两处注释都写得像还在承重。第三处是「跨框接缝引擎不给空气」：它先前只是
   豁免的理由，没有数；现在每帧把那些接缝实测的最大间隙（`crossRunMaxEm`）带出来，
   `layout.test.ts` 要求它落在噪音容差内，引擎哪天改了口径就红，而不是继续被一句注释豁免着。

**证明它会红**（除最后一行，都是本轮真实跑出来的原文，恢复后全绿；最后一行是写 `en` 用例时自己踩到的坑）：

| 当时的改动 | 打红的断言与原文 |
|---|---|
| 把 `i18n.ts:441` 的 `显示 Agent 实际` 改成 `显示Agent实际` | `typography.test.ts > sets every Chinese sentence so no line starts or ends on a forbidden mark, and no two scripts meet without air` → `apps/desktop/src/shared/i18n.ts:441 (zh-CN.context.waiting): … sets a Han character directly against a Latin one ('示A') — 中英混排 wants a space at that boundary` |
| 同上 | 新增那条点收也同时红：`counts the boundaries the gap rule guards…` → `the dictionary writes 2 Han/letter boundary(ies) with no space at all … expected 2 to be +0`。两个数是两处接缝（`示A` 与 `t实`），一句话改一处、边界是两个——**这条正是「计数器看得见」的证据**，看不见就报不出 2 |
| 同上，且把 `MIN_HAN_LATIN_GAP_EM` 临时抬到 0.2 | `layout.test.ts > has the engine give air where one run puts the two scripts together` → `state-empty#chat: …` + `{"element":"div.faint","pair":"示A","gapEm":0.125,"fontSize":13,"floorEm":0.18…}`，`pair":"t实"` 那条也是 0.125。这一条同时是**引擎确实给了 1/8 em** 的数：13px 上 1.625px |
| 同上，再把 `styles.css` body 里那行声明删掉 | 同一断言的 `gapEm` 变成 **0**，并多出 `resolves the gap the stylesheet declared, in this engine`（body 解析值不再是 `normal`）；`typography.test.ts` 另两条同时红：`sets the gap on the document rather than restating it per surface`（`body` 不再读那个 token）、`switches the gap off nowhere`（全表 `text-autospace` 一处都找不到） |
| **只删那行声明**，词典一字不改 | 52 项里**只有一条**红：`resolves the gap the stylesheet declared, in this engine`。其余量测全绿——因为紧贴集合今天是空的，`underGap` 与 `doubleSpaced` 都无话可说。这就是为什么那条断言必须存在：它不看结果集合空不空，只看 `body` 在这台引擎里把声明解析成了什么。而屏幕上不是没动：两次绿跑都一致的 59 张图里 **49 张**变了（66 张中有 7 张本来就随帧抖动） |
| 反向：`en` 侧那条嵌套用例先用 `source.replace(anchor, …)` 插 fixture | `'app.name': 'UCAD',` 在两个块里逐字节相同，`replace` 改的是**中文块**，英文块计数照常 → 用例绿着，什么都没证明。改成按行号 `splice`，并断言插入点落在 `const enUS` 之后 |

**顺带把 `en` 词典纳入字面量覆盖率**（P1 里「两半只做一半」那条）。开这条当场撞到一个真缺陷：
`stringLiterals()` 只数单引号，而 `i18n.ts:984` 的值用双引号写（句子里有撇号），于是
「每条 = 两个字面量」在英文块上永远差 1（1329 对 1330）——门禁会去怪字典，其实怪计数器。
计数器改成认两种引号、由**开启它的那个引号**闭合（双引号句子里的撇号是文本，不是第二个字面量）；
现在 665 条 × 2 = 1330，两个块都对上，并且各有一条 fixture 证明它能红。

## 本轮（2026-11-06）14 张图被迫重拍，以及看过之后的一句话

改 `styles.css` 不是免费的：`docs/screenshots/sources.json` 记的是每个渲染层源文件在拍照那一刻的
sha256，源文件一动，`screenshots.test.ts > records the renderer sources that are actually in the
tree` 就红（本轮开工前 HEAD 上那条哈希还是对的，所以这一红是**本刀造成的**，不是历史欠账）。
`demo-script.test.ts` 跟着一起红：面板里引用了 `screenshot-sources.mjs --check` 打印的那行 PASS，
而那条命令当时正在失败——文档、清单、面板三处约好的一句话，脚本已经不说了。

按 `CONTRIBUTING.md` 写好的三步走：图从布局门禁自己写的 `.run-logs/layout/` 里取（映射是仓库里
已经写明的：四张主屏取 `panels-1440-*`，五态取 `state-*-chat` / `state-*-tight-chat`，两张加载态
取 `loading-frame` / `loading-frame-tight`——门禁里就有一条盯着这两张，拿成 settled 那帧会红），
`--write` 重新记录，`--check` 现在打印 `PASS — 34 renderer source(s) and 14 screenshot(s)`。
14 张图的尺寸一张没变，所以走查表里写的 1440×900 / 768×700 仍然对得上那张图。**变了的只有 6 张**：
四张主屏加 `states/permission*`；没变的 8 张是 `empty` / `error` / `loading` / `partial` 那几屏和它们的
窄窗口版——同一条声明能让 59 张稳定帧里的 49 张重排，在一屏只有三行字的界面上却一个字节都不动。
这正是「图」和「配对字距的量测」要同时存在的原因：一个说像素，一个说像素为什么这样。

**看过之后**（`--write` 记录不了有没有人看，所以把看的结论写下来）：

| 图 | 一句话 |
|---|---|
| `chat.png` | 三栏都在，中文正文里 `renderContextPack`、`renderedHash` 两侧有空格；中间只有一条对话，诚实但空 |
| `decision.png` | 引擎链表 + 预览 + 决策记录三张卡，读得下去；第三张是「本会话决策 (0)」，一张几乎全空的卡 |
| `states/permission-768x700.png` | 遮罩、五件、四个回答在窄窗口里分得清，没撑破 |
| `error.png` | **这一张有问题**：整屏九成是黑的，标题 + 一行机器码 + 三个按钮挤在左上角。它想说的是「加载失败、可以怎么办」，看上去像「还没做完的页面」 |

`error` 那张是本轮看出来的唯一观感缺陷，**本轮不动它**：那是第二刀（给失败态一张有版面的卡：
哪个工作区、哪一步、为什么、三条动作），和本轮的排版/门禁不是同一件事，混在一起提交会让 diff
说不清自己在做什么。记在这里，作为下一刀的第一个具体目标。

走查表（`docs/state-walkthrough.md`）的签字栏**仍然没人签**：看过图的是本轮的编码侧，不是一个人。
本轮做的是「图是新的、尺寸是对的、有人写过看了什么」，「一个人对着十张图答是/否/说不清」仍是
`docs/blockers.md` 第 3 条。

**这一轮没有做的事**：三条外部阻塞一条没解（无令牌 / 无 Windows 机器 / 无人眼签字），
`docs/blockers.md` 上那三个 2026-11-05 的日期照旧；P0 的第二刀做了一半——图重拍了、看过、结论写在
上面那一节，但**没有一个人对着十张图答题**，走查表的签字栏因此仍然没人能签，而 `error.png` 看出来的
那个版面问题也只落成了下一刀的目标，没有在本轮动手；产品功能一条都没加——DoD 没勾满之前不堆功能。
汉字与**数字**之间的空隙仍只在屏幕上由引擎负责，不进字典规则——那是上一轮留下的判断，本轮
保留了它，并把理由写进 `typography.test.ts` 的 `LATIN_LETTER` 而不是只留在这份文档里。
一个副产品：本轮点收发现词典里连「汉字紧贴数字」也是 **0** 处，所以那条豁免今天是空转的。
不压它（压成 0 就等于禁止 `第1步` 这类正常写法），只把数记在 `gapCensus` 里，等它哪天真出现
再说该不该管。

门禁：`node scripts/gate-local.mjs` → `PASS — 7 gate step(s) green on linux with node v22.23.4`
（typecheck 1.8s / lint 9.1s / knip 1.9s / test 99.1s，113 个文件全绿 / test:e2e 32.2s，21 个文件 /
build 4.9s / clean+build:packages 5.7s）。**这一条要写明跑法**：`TMPDIR` 挪到 `.run-logs/tmp` 之后才成立——
这台共享机的 `/tmp` 有配额，vite 的 SSR 临时目录写不进去时，同一份代码会假红 83 个文件（本轮第一次
跑就是这样，量出来的数不可信）。本轮改到的两个用例文件：`tests/contract/typography.test.ts` 49 项、
`tests/contract/layout.test.ts` 52 项全绿；`node scripts/screenshot-sources.mjs --check` →
`PASS — 34 renderer source(s) and 14 screenshot(s)`。

## 本轮（2026-11-06）失败那一屏从「左上角三行字」变成「原因 + 下一步」，走查表因此多出一条判据

上一节 1680 行记下的那条观感缺陷就是本轮那一刀：那时候 `error.png` 是「整屏九成黑，标题 + 一行机器码 +
三个按钮挤在左上角」，读起来像没做完的页面而不是失败的页面。范围只此一张屏，加上它带出来的判据变化
与一条门禁加固；产品功能一条没加。

**屏幕上改了什么**（`apps/desktop/src/renderer/src/App.tsx` 的 `if (fatal)` 分支）：

- 原来标题下面那个 `<p>{fatal}</p>` 就是全部正文——机器码直接接在 `出错了` 后面，中间没有一句话说明
  这行是什么。现在标题下先接 `error.fatalLead`（「这一步没有完成。下面这行是它返回的原文，可以直接贴给别人。」），
  失败原文本身挪进 `.notice.error`——和 `partial` 那一态同一个盒子、同一条 `overflow-wrap: anywhere`，
  于是它也是 `?reason=long` 那条门禁一直在量的那个框；按钮之前再接 `error.fatalNext`
  （「先点重试，它会把刚才失败的那一步重新跑一遍…」）。
- 版面：`.pane.fatal` 把这一列在窗口里居中，四个块共用 `--sp-3` 的 gap，子元素自带的 margin 全部收掉
  （`.pane-head` 的 16px 与两个 `<p>` 的 UA `1em 0`）——flex 列里 margin 不折叠，不收就会在红框上下
  各多出一截，那正是「像 assembled 不像 designed」的那口气。没有新颜色、没有新字号档：`--err`、
  `--surface`、`--measure-prose`、`--sp-3` 都是既有 token。
- `justify-content` 用 `safe center` 而不是 `center`：`?reason=long` 那一格（200 字符无断点路径）在
  768×700 下能把这一列顶得比 pane 高，普通 `center` 会把顶部推出滚动区、再也滚不回去。本轮量过那一帧：
  横向溢出 0、无元素出屏、无裁字，`重试` 仍在折叠线以上。
- **没有做的**：这一屏仍然只有一列文字，窗口其余部分仍是背景色。本轮改的是「这一块读起来像不像一个
  屏幕」，不是「把窗口填满」——要在 fatal 分支里重建 rail / statusbar 是另一件事，而且那正是
  `layout-page-scripts.mjs` 里写明「fatal 那一屏没有 shell」的那条形状。

**判据跟着动**：`docs/state-walkthrough.md` 的 `error` 一节多出第四条「这一屏说得出下一步」，
答题纸因此从三十行变三十二行（判据十五条→十六条），`## 10 分钟速查表` 的标题、回执模板与记录表
的「30 条全满足」一起改到 32。门禁那侧把两处**假设每态三条**的算术改成**从判据推导**
（`quickProblems` 的差额消息与 `toHaveLength`），所以以后任何一态加一条判据，答题纸会跟着动，
而不是让下一个人答一份对不上的题。`docs/defense-checklist.md` 第 6 步加了能当场照念的那一句，
`tests/e2e/scenarios.e2e.test.tsx` 加了一条断言：`error.fatalNext` 必须出现在 `error.retry` **之前**
（`compareDocumentPosition`）——「说了下一步」和「在按钮下面补一句解释」是两屏不同的东西，
所以这条判据量的是顺序，不是存在。

**另一条门禁（假红）**：本轮真的踩到了它。`npm test` 在 HEAD 未变的情况下红了 **2 个文件 8 个用例**，
stderr 是 `Unknown system error -122, write`（EDQUOT）。这台共享机的 `/tmp` 是带 `usrquota` 的 tmpfs：
`df` 报还有 348M，而该用户实际只剩不到 256K 的块——**64 KiB 写得进、256 KiB 写不进**，写到本轮收尾时
连 1 字节都写不进（`printf` 直接 `write error`）。`mkdtempSync(tmpdir())` 全灭，所以红的是文件系统，
不是产品。`scripts/temp-dir-probe.mjs` 是一个 1 MiB 的分配探测（0 字节 create 抓不到这个状态：inode 还有、
块没有），`scripts/gate-local.mjs` 在跑任何步骤之前用它拒绝执行并打出可照抄的
`TMPDIR=… node scripts/gate-local.mjs`，`tests/global-setup.ts` 在构建应用规则之前抛同一条消息——
一个实现，两个入口。探测**只说它量到的事**：那 1 MiB 写得进去与否，不承诺整轮跑得下，
消息里也没有承诺。红方向有用例：`tests/contract/temp-dir.test.ts` 7 项 + `ci-gate-local.test.ts` 3 项
（拒绝、换到可写目录后转绿、`--list` 不探测）。

**这一轮没有做的事**：三条外部阻塞一条没解——已发布 feed 仍缺 `sha256`（本机无令牌）、
Windows 六步仍无机器、五态走查签字仍没有那个人；本轮只把 `error` 那一态的判据从三条改成四条，
签字栏仍然空，`docs/blockers.md` 第 3 节因此改的是「为什么仍然阻塞」那一段，不是状态。
P0 第二条（`release-gate --simulate-missing-sha` 与真实 `npm run dist` 逐字一致、有令牌那几条命令
在三处双向一致）**核对后无需改动**：`tests/contract/release-gate-simulation.test.ts` 与
`publish-rehearsal.test.ts` 本轮全绿，`docs/release/REPLACE-FEED.md`、`docs/blockers.md` 第 1 节与
本节上面那张表列的是同一组命令，没有发现漏——没有为了「本轮也动一点」去改它。

门禁（本轮实跑）：`TMPDIR=/var/tmp/ucad-gate DISPLAY=:140 ELECTRON_DISABLE_SANDBOX=1` 下逐步跑 CI 的
七个 `run:` 步骤 → typecheck / lint / knip 退出 0，`npm test` **114 个文件全绿**
（1951 passed / 1 skipped，其中 `layout.test.ts` 52 项、`state-walkthrough.test.ts` 40 项、
`typography.test.ts` 49 项、新增的 `temp-dir.test.ts` 7 项），`npm run test:e2e` **21 个文件 163 项全绿**，
`npm run build` 与 `npm run clean && npm run build:packages` 退出 0；
`node scripts/screenshot-sources.mjs --check` → `PASS — 34 renderer source(s) and 14 screenshot(s)`。

**为什么这里没有一行 `gate-local` 的 PASS**：那条命令的 `test` 步骤写着 `xvfb-run`，而 Xvfb 要在
`/tmp` 里写一个 7 字节的 lock 文件——本轮收尾时这台机器的 `/tmp` 用户配额已经**连 1 字节都写不进**
（`printf 'x' > /tmp/…` 直接 `write error`），`-nolock` 又只允许 root 用。这正是本轮那道新探测要说的事，
所以把它跑出来的原文贴在这里：不带 `TMPDIR` 执行 `node scripts/gate-local.mjs` 打的是

```
[refused] /tmp is not usable: allocating 1 MiB there failed with UNKNOWN (errno -122). …
REFUSED — nothing ran and nothing is proven. Re-run against a directory that passed the
same write: TMPDIR=/var/tmp node scripts/gate-local.mjs
```

退出 1、一步没跑，而不是几十个文件的红。`errno -122` 是 Node 没有名字的那个码（EDQUOT），
所以消息里带数字而不是只带 `UNKNOWN`。

截图：`error.png` 17258 → 36378 字节、`states/error-768x700.png` 14326 → 32863，是本轮那一屏在
两个窗口下的新框；另外 `decision.png` 差 1 字节、`handoff.png` 差 8 字节，两张都对照旧图**看过**，
画面没有变化——同一份 DOM 两次编码的字节差，正是本仓不做像素 diff 的那条已知限度
（`screenshot-sources.mjs` 文件头写明它量的是渲染层源码哈希，不是像素）。其余 10 张与上一轮提交的
逐字节相同，所以这个 diff 里只动了四张图。

## 本轮（2026-11-06）日期、抄本、折叠线：三处「说了，但没有任何东西读它」

产品代码一行未改：`App.tsx`、`styles.css`、`i18n.ts` 一字未动，所以 14 张截图不需要重拍，
`node scripts/screenshot-sources.mjs --check` 从头到尾都是
`PASS — 34 renderer source(s) and 14 screenshot(s)`。本轮改的是三处看守，加上为了让看守成立
而必须收敛的两处措辞——这三件事是同一个形状的三个方向：**文档说了，没人量**。

1. **这一页的日期不再各说各的。** 标题写着 `（2026-11-03）`，`## 本轮 DoD 加载来源与未勾项`
   写着 `（2026-11-05）`，而 HEAD 是 `2026-11-06`——三个日期都在这一页上，没有任何一条门禁读过
   它们。两处日期都收到 `2026-11-06`；同时把那一节里「第三条是本轮新增的」改成
   「第三条是 2026-11-05 那一轮新增的」：**把日期改新不能顺手把别人的「本轮」抢过来**，那一句
   记录的是一轮的产出，不是一个字段。
   `tests/contract/dod-status.test.ts` 新增 `describe('the status page is dated the round it
   describes')`（8 项）：两处标题的日期必须相等、必须是日历上真实的一天（`YYYY-MM-DD` 占位符与
   `2026-02-30` 各一条），且不得早于 `git log -1 --format=%cs`。**取不到 git 时只跳过与提交日比较
   的那一半**——这一条被写成用例而不是注释：`dateProblems(status, null)` 在两份日期不一致时
   仍然要红，否则「没有 git」就成了让整条门禁闭嘴的开关。日期的算术用 `blockers-doc.ts` 里
   `utcDays()`，不在这里再写一份「什么算一天」。
   **红（本轮真跑）**：把标题 sed 回 `（2026-11-03）` 之后，同一节 3 failed / 5 passed，打出来的是
   ```
   docs/dod-status.md: the H1 says the page is current as of `2026-11-03` and `## 本轮 DoD 加载来源与未勾项` says `2026-11-06` — one page, two dates, and a reader cannot tell which round the tables below were written under
   docs/dod-status.md: the H1 is dated `2026-11-03` and the last commit landed on `2026-11-06` — a status page older than the code it describes is describing a state that no longer exists; move that date to the round this edit belongs to
   ```
   恢复后 `tests/contract/dod-status.test.ts` 57 项全绿。「加载来源」那一句（三份 DoD 逐字相同）
   本轮重测了一次：三个文件的 sha256 前缀都是 `ae8737a27a793adb`，`diff` 为空。

2. **三条阻塞在四份抄本里说的是同一句话——现在有人比了。** 新增
   `tests/contract/blocker-parity.test.ts`（10 项）。三样字面量**从 `docs/blockers.md` 读出来**
   （节标题括号里的「需要…」、`**重跑这一条**` 命令、`### 解除时` 的 `**屏幕上第一行**`），
   再比对四个抄本：`blockers.md` 自己、`docs/dod-status.md`、README 中文半、README 英文半。
   两半**分开读**是这条门禁的关键：不分开时，英文半丢了 `--judge` 那条命令也会被中文半顶上去——
   那是「两个读者算作一个人」，和上一轮那个只查一遍全文的 `describe` 是同一种错。
   - 为了让两个门禁共用一份读法，`blockAfter()`、`closingRecipe()` 和那两个 marker 从
     `blocker-closing.test.ts` 搬进 `blockers-doc.ts`：现在四个门禁（routing / freshness /
     closing / parity）共一份「什么算一节、什么算这个 marker 下的第一行」。两处各写一份时，
     一处失配就变成「一个门禁读不到东西却照旧绿，另一个还在报它那一份」。
   - README 不承诺「屏幕上第一行」，这件事被写成**数据**而不是循环里的一次跳过：
     `README_EXEMPTION` 带着范围、字面量与理由，另一条用例钉住「两个操作页不许自己豁免」。
     理由是：README 是前门，`PASS —` 那种运行手册里的行放在这里是噪声；前门必须说的是
     缺什么、跑哪条——而它**不许**再用自己的话复述那行，复述正是这次漂移的来源。
   - 文档侧收敛（把同一句话说成同一句，不是新增事实）：`docs/dod-status.md` 三条「未关闭」
     bullet 现在各带「需要…」／判定命令／关掉那天屏幕上第一行是什么；README 中英两半的
     五态那条各补一句 `node scripts/screenshot-sources.mjs --check`，并写明它量的是「图还对着
     拍下它们的那一版渲染层」，量不到「有没有人看过」。
   **红（本轮真跑，改的是真实文档）**：把 dod-status 那三条 bullet 里的「需要写权限令牌」抹掉 →
   ```
   docs/dod-status.md: 第 1 节 says the gap as "需要写权限令牌" in docs/blockers.md, and that string is not in this copy — three copies of one blocker now describe different things, and a reader has to guess which page is stale
   ```
   反方向也驱动过：把 `blockers.md` 第 3 节标题改成一句别处不可能出现的新措辞，红的是**另外两处**
   （README 中文半 + dod-status），各指名新措辞——权威页改了，抄本要跟；不是抄本守住旧说法。
   - 这两条用例本轮**先写错过一次，在全量门禁上当场打红**：第一版把标题改成
     「（需要一位评审人）」，期望 2 条 problem，实跑只有 1 条；另一条期望 1 条，实跑 0 条。
     原因不是门禁错，是**本节上面那段话自己引用了那两个字面量**——「未关闭」bullet 里的措辞被
     抹掉之后，历史小节里的引用又把那个字符串补回来了，于是那份抄本「带着」这句话，而带的方式
     是引用。改成 `replaceAll`（真的让这个词在整页消失）与哨兵措辞之后，两条都按预期红。
   - 由此留下这条门禁证明不了的事，写在文件头而不藏：**引用不算承载**，但要把「自己那句陈述」和
     「别处引用这句话」分开，需要给每份文档再建一层小节模型，而这几份文档已经有四道门禁在读了。
     所以这条门禁令牌上写的是「三处用词一致」，不是「三处各自陈述过一次」。
   `blocker-closing` / `blocker-freshness` / `doc-routing` / `dod-status` 在重构后 101 项全绿。

3. **`error` 那一屏的「下一步」现在在窄窗口也被看得见。** 上一轮断言的是顺序
   （`error.fatalNext` 必须出现在 `error.retry` 之前），本轮补上另一根轴：**顺序对而看不见，
   等于没说**。`scripts/layout-page-scripts.mjs` 的量测多带一个 `content.fatalFold`——
   `.fatal-next` 与 `.row-gap button.primary` 的 `getBoundingClientRect()` 上下缘、
   `window.innerHeight`、以及 `.pane.fatal` 自己的 `scrollHeight`（带上它是为了红的时候能分清
   「整列溢出了窗口」和「只有一格太低」，这两种是不同的缺陷）；三个框任缺其一记 `null`，
   而门禁在 error 态把 `null` 判成**红**，不是跳过。
   `tests/contract/layout.test.ts` 新增 `keeps the failed-load screen above the fold, not merely
   above the buttons`（该文件 53 项，本轮 +1），对**所有** error 帧生效：1440×900、768×700，
   以及 768×700 配 200 字符无断点 reason 那一格。
   **红（两条方向都是本轮真跑出来的）**：
   - 把 `.fatal-next` 的 class 改名（那一屏失去「下一步」那句话）→ 三个 error 帧各一句
     `no next-step line or retry button was found to place — the failed-load pane lost one of them`，
     1 failed / 52 skipped。
   - 第一次试图用一个 `height: 300px` 的空 div 把内容顶下去，**门禁照绿**；换成 600px 仍然绿——
     flex 列里的子项默认可以收缩，那个 div 被压回去了。换成 `marginTop: 600` 才真的把两行推到
     折叠线以下，红的是：
     ```
     state-error-tight: the next-step line ends at 820.4px in a 700px window (the column is 861px tall) — it is below the fold, so the screen says what to do next somewhere the reader cannot see
     state-error-tight: the retry button ends at 865.2px in a 700px window (the column is 861px tall) — …
     state-error-tight-long-reason: the next-step line ends at 897.1px in a 700px window (the column is 938px tall) — …
     state-error-tight-long-reason: the retry button ends at 941.9px in a 700px window (the column is 938px tall) — …
     ```
     同一次跑里 1440×900 那一帧是绿的（820 < 900）——这条断言按窗口判，不是一句「应该看得见」。
     **这里量到的是自己**：「我加了 600px，所以它一定会红」不是证据，跑出来的绿才是；
     如果没有那一次绿跑，这条断言会带着一个从没被走到的失败分支进仓库。

**这一轮没有做的事**：

- 三条外部阻塞一条没解——已发布 feed 仍缺 `sha256`（本机无令牌）、Windows 六步仍无机器、
  五态走查仍没有那个人。本轮动的是这三条**在别人的文档里怎么说**，不是它们本身；
  `docs/blockers.md` 上那三个 `2026-11-05` 的日期本轮**没有**改新，因为本轮没有重跑那三条命令，
  就没有资格让它们变新（`blocker-freshness` 自己承认的盲点，不是可以顺手填的格子）。
- P1 的两件没做。答题纸判据上限（每态 ≤ 5、总数 ≤ 40）与本轮的折叠线不是同一件事，留着；
  `scripts/temp-dir-probe.mjs` 的已知限度登记**不是纯文档动作**——「已知残留」那张表要求被点名的
  文件里真的有 `KNOWN RESIDUAL` 标记，本轮既不打算为了填表去改那个脚本，也不打算只改表让门禁去红。
  那一行留给下一刀，连标记一起。
- shell 的 stdout 这一轮仍然被 `/tmp` 配额吃掉（每条命令的捕获文件都写不进去，`echo` 也一样），
  所以本轮每一句「跑过 / 绿 / 退出码」都来自重定向进被 `.gitignore` 挡住的 `.run-logs/`
  再读回来的输出，与上一轮记的是同一个绕法；上面的红原文就是这么抄下来的。

**门禁（本轮各跑一次，数字是这几跑打印的）**：`npm run typecheck`、`npx eslint .`、`npx knip`、
`node scripts/screenshot-sources.mjs --check` 退出码都是 0；
`TMPDIR=$PWD/.run-logs/tmp DISPLAY=:140 ELECTRON_DISABLE_SANDBOX=1 npm test` →
`Test Files 115 passed (115)`、`Tests 1970 passed | 1 skipped (1971)`；`npm run test:e2e` →
21 个文件 163 项全绿。三个数对得上，不需要读者猜：上一轮 1951 + 8（日期）+ 10（抄本）
+ 1（折叠线）= 1970；`layout.test.ts` 自己从 52 项变成 53 项。
