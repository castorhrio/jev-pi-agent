# 三条外部阻塞：解除命令、期望输出、结果放到哪个路径

这三条不是本仓库里没做完的活，而是**需要这台机器没有的东西**：一个 `contents: write` 令牌、
一台 Windows 机器、一个人。三条的解除条件都已经收敛成可执行的命令，但它们原先散在
`README.md` 的「当前局限」、`docs/dod-status.md` 的表和 `docs/manual-verification.md` 里，
想知道「我该做什么、做完把什么放回哪里」得跨三份文档拼。

这一页只回答这三件事：**敲什么**、**应该看到什么**、**结果贴回哪个路径**。
要演示产品本身（可证明注入 + 可解释路由 + 权限门），读 `docs/demo-script.md`，不必先读这一页。
判据的来源没有变：`docs/PRODUCT-DOD.md` 是锁定稿，`docs/dod-status.md` 逐条对照现状。
**审查与下一轮必须先读 `docs/PRODUCT-DOD.md`**，否则分不清「缺口」和「已完成」。

三条都**不改产品行为**：跑通了它们，改的是证据与文档；产品代码在它们之外没有任何变化。

## 这三条都记着日期，而日期会红

每一节的第一行都写着 **最近核对** 与 **重跑这一条**，`tests/contract/blocker-freshness.test.ts`
读这两样：这一节没写日期、写的不是真的日历日、或者日期超过 **14 天**，就打红，并指名该重跑哪一条命令。

为什么「没人看过」也值得门禁：三条阻塞都在这一页放了好几轮，而**文档不会过期**。一条三个月没被
重新核对的「仍阻塞」和一条上周量过的「仍阻塞」，读起来一模一样——这个差别很实在：前者可能早已被
别人解除、只是这里没人回来改，后者是刚刚量出来的。冲第一的口径里，「线上那份还是坏的吗」必须
是量出来的，而不是这一页某天写下的话。

**它证明不了什么，写在这里而不是糊过去**：这条门禁只看日期新不新，看不出日期是**怎么**变新的。
把日期改成今天而不跑那一行命令，它读不出来。所以每个日期旁边都钉着一条命令——改日期的人要么真的
跑了它，要么就是在骗这张表，而骗的成本从此是显式的、有名字的。真正的判定在那一行命令自己的退出码里，
不在这个日期里；日期变新而命令的输出照旧，说的是「这条阻塞还在原地」，那是这条页面上最好的消息。

## 1. 已发布的 v1.0.0 feed 缺 `sha256`（需要写权限令牌）

- **最近核对**：2026-11-05 ｜ **重跑这一条**：`node scripts/release-gate.mjs --simulate-missing-sha`

这一条有两个人要分开照顾。**有令牌的人**能把线上那份换掉，他要的是「敲哪两条、按哪个判据算成、
结果贴回哪里」；**没有令牌的人**换不了，他要的是看懂「现在发布会被挡在哪一句上」，
而不是读一段关于那句拒绝的描述。两半都在这一节里，不必再翻 `docs/dod-status.md` 与
`docs/manual-verification.md`。

### 有令牌的人：先看，后按

**解除命令**

先看——不联网、不写文件、不上传，把第二步要做的事按顺序打印出来：

```bash
node scripts/publish-feed.mjs --dry-run
```

再按——需要 `castorhrio/jev-pi-agent` 的 `contents: write`：

```bash
GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify
```

**期望输出**（最后一行是判据）：

```
PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=76bbe0c6…
```

上传之后用读的一方复核，退出码 0 才算数：

```bash
node scripts/verify-release-feed.mjs
```

```
PASS — 0 warning(s), nothing the app would refuse
```

**结果放到哪个路径**

1. 完整 stdout/stderr 追加进 `docs/manual-verification.md`（含 `PASS —` 那一行，不要转述）；
2. `docs/dod-status.md`「Windows 安装包航运 · 随包 feed 真实网络」一行从**红**改成**有证据**；
3. `README.md` 中英两半删掉那条 v1.0.0 局限，并同步 `tests/contract/readme-parity.test.ts` 的
   `LIMITATIONS` 表（少改一处会打红）。

**一页操作单**：`docs/release/REPLACE-FEED.md` 把上面这些收成一页——前置条件四条、
`--dry-run` 的逐字期望输出、`--apply --verify` 的判据行、三种失败各一句、以及做完改哪三处。
拿到令牌的人照着从上往下敲即可，不需要先读代码。这一页引用的每一行输出都由
`tests/contract/handoff-packs.test.ts` 对着脚本源码核对，脚本改了措辞而文档没改会打红。

### 没有令牌的人：同一次拒绝，离线也看得见

没有 `contents: write` 的人换不了线上那份 feed，但他应该能**看见**这次发布会被挡在哪一句上，
而不是读一段关于那句拒绝的描述。这一半不需要令牌、不需要联网、不需要 Windows。

**这一半的命令**：

```bash
node scripts/release-gate.mjs --simulate-missing-sha
```

**期望输出**（2026-11-05 在本机跑的一次，逐字复制；**退出码 1**）：

```text
source: SIMULATED — the v1.0.0 feed as published, judged by the app’s own rules; nothing was fetched
version: this build is 1.0.0
[FAIL] no-sha256: the feed publishes no sha256, so the app refuses to install what it downloads — null
[warn] no-size: the feed publishes no size, so a truncated download is only caught after hashing — absent
[FAIL] installer-latest-url: the installer URL uses releases/latest, which 404s once a newer release exists — https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe
[skipped] the installer URL: not fetched (--simulate-missing-sha never touches the network)
verify-release-feed: FAIL — 2 failure(s), 1 warning(s); 1 check(s) did not run
REFUSED — the published feed is one the app refuses to install from, so a release published now would not reach anyone through it: no version may ship until the feed is fixed (node scripts/publish-feed.mjs --dry-run, then --apply --verify)
```

上面这八行与它自己跑的那条命令**逐字对齐**由 `tests/contract/release-gate-simulation.test.ts` 核对：
闸门改了措辞而这一页没跟着改，会打红；这一页被人改了一个字，也会打红。

**这是离线演示，不是真替换。** 判定用的是同一个 `judgeFeedDocument()`——线上那份 feed 交给
**应用自己的规则**判一遍，所以 `REFUSED` 那一行与 `npm run dist` 现在被挡住时打印的是同一句话。
它**不**上传任何东西、**不**改变任何判定、**不**证明 Releases 上那份 asset 已经被换掉；
`source:` 与 `[skipped]` 两行就是为了让它不被读成一次真的测量。

想再看一次「feed 正确时闸门放行」的另一半：`node scripts/replay-feed-local.mjs` 把仓库里这份修正版
文档原封不动地用一个本地 TLS 地址托起来，让 `scripts/verify-release-feed.mjs` 与
`scripts/release-gate.mjs` 对着它跑一次**绿分支**（退出码 0，两行 `PASS`）。它证明的也是**链路**，
不是**发布**：GitHub Releases 上那份 asset 在这之前和之后都还是旧的。这一次的输出已经写在
`docs/manual-verification.md` 里，任何人可以在自己的机器上重跑复现。

**做不到时不要做什么**：不许把 `--simulate-missing-sha` 接进 `npm run dist`——它退出 1 是给
演示用的，不是给发布路径的（`tests/contract/release-gate.test.ts` 钉着这条旗标不许出现在
`dist` / `verify:release` 里）；也不许改 `PUBLISHED_V1_FEED` 让演示变绿，那份记录的是 2026-11-04
从 GitHub 抄下来的**线上字节**，改它等于把缺陷擦掉。

### 解除时：令牌到手之后，一条命令、一行输出、四处要改的文档

上面两半说的是「阻塞还在时怎么演示」。这一节说的是**解除的那一刻**：敲什么、看到什么算过、过完改哪几处。
写在这里是因为解除之后如果不改文档，文档就会开始说谎——而说谎的那几处现在有名字，少改一处会打红。

**跑这一条**（需要 `castorhrio/jev-pi-agent` 的 `contents: write`）：

```bash
GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify
```

**屏幕上第一行**（判据是退出码 0，不是这一行好看）：

```console
PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=…
```

**解除后要改的四处**：

1. `docs/demo-script.md`「三条阻塞的现场降级路径」里**第一条**整块删掉（命令 + 输出 + 那句念法），
   并把开头那句「三条外部阻塞」、小节标题里的「三条」、以及末尾「三条合起来是同一句话」一起改成两条；
   `tests/contract/demo-script.test.ts` 的 `DEGRADED_COMMANDS` 同步删掉这一条——它按常量迭代，删一条
   不会红，但同一 `describe` 里那条用例的名字写着 `is not vacuous: three blocks, three scripts, three
   real sources`，名字要跟着改，否则它说的是三、量的是二；
2. `docs/blockers.md` 这一节整节删掉，`## 2.` / `## 3.` 的编号跟着改，`tests/contract/doc-routing.test.ts`
   的 `BLOCKER_COUNT` 从 3 改成 2（`tests/contract/blocker-freshness.test.ts` 只要求「至少有一节」，
   不数个数，不用改）；
3. `docs/dod-status.md`「Windows 安装包航运 · 随包 feed 真实网络」一行从**红**改成**有证据**，证据引用
   上面那条 `--apply --verify` 的退出码 0，以及读的一方复核时
   `node scripts/verify-release-feed.mjs` 打印的 `PASS —` 行；
4. `README.md` 中英两半删掉那条 v1.0.0 局限，并同步 `tests/contract/readme-parity.test.ts` 的 `LIMITATIONS` 表。

**这一节的断言在哪**：`tests/contract/release-gate-simulation.test.ts` 的
`describe('the blockers page shows the refusal instead of describing it')` 逐行比对上面那段粘贴与
`--simulate-missing-sha` 今天的输出；`tests/contract/demo-script.test.ts` 的
`describe('each external blocker has a command and a line on screen')` 钉住演示页里那条命令与它的首行。

## 2. Windows 桌面六步（需要一台 Windows 机器）

- **最近核对**：2026-11-05 ｜ **重跑这一条**：`node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json`

**解除命令**

在 Windows 机器上，先 `git clone` 本仓库、`npm ci`、`npm run package`，然后：

```bash
node scripts\verify-main-chain.mjs --exec release\win-unpacked\UCAD.exe --report win-report.json
```

把 `win-report.json` 带回任何一台机器，由读的一方判定（不需要 Windows，也不启动任何进程）：

```bash
node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json
```

**期望输出**（退出码 0）：

```
PASS — the report covers steps 1, 2, 3, 4, 5 on win32 against build 1.0.0
[note] this judges what the file says, not that the run happened …
```

判定要求四件事：报告自报 `platform=win32`、步骤 1–5 全部 `pass`、`build.version` 等于仓库当前版本、
每一步的 `pass` 都带着它自己记的证据行（五行 `pass` 什么都没有，是「声称」而不是「结果」）。

**结果放到哪个路径**

1. 报告文件放在 `docs/manual-verification/win-YYYYMMDD.json`；
2. `docs/manual-verification.md` 加一节记录这次判定的完整输出；
3. `docs/dod-status.md`「Windows 安装包航运 · NSIS 产出与安装」一行改成**有证据**，
   证据引用那份报告与 `--judge` 的退出码 0。

**一页操作单**：`docs/manual-verification/README.md` 是这一条的带回包——报告与三张截图的
命名约定（`win-YYYYMMDD.json`）、`--judge` 的五条红各是什么原文、报告长什么样、判过之后改哪三处。
它和这一节说的是同一件事，区别是它写给「手上只有一台 Windows 机器和一个浏览器」的人。
那一页贴的判绿/判红样例不是照着写的：每一块都是 `tests/fixtures/judge/` 里一份报告喂给 `--judge`
的**完整输出**，由 `tests/contract/judge-samples.test.ts` 逐行比对——所以照着敲的人看到的每一行，
这一页都承诺过。

**做不到时不要做什么**：不许手写一份报告，也不许把「跑过 Linux」写成「Windows 通过」——
`--judge` 只判文件说了什么，而文件可以手写，这句话写在报告自己的 `note` 字段里。

### 解除时：报告带回之后，一条命令、一行输出、五处要改的文档

**跑这一条**（不需要 Windows，也不启动任何进程——判的是文件说了什么）：

```bash
node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json
```

**屏幕上第一行**（判据是退出码 0）：

```console
PASS — the report covers steps 1, 2, 3, 4, 5 on win32 against build 1.0.0
```

**解除后要改的五处**：

1. `docs/demo-script.md`「被问到「真机跑过吗」」里那句 `Windows 六步仍未跑` 与
   `docs/manual-verification.md` 里同一句**必须同时改**——`tests/contract/demo-script.test.ts` 的
   `describe('the demo script answers "did you run it on Windows?" where it is asked')` 两个方向都打红，
   只改一处会指名说「one of the two is now wrong」；
2. `docs/demo-script.md`「三条阻塞的现场降级路径」里**第二条**整块删掉，`DEGRADED_COMMANDS` 同步删掉；
3. `docs/blockers.md` 这一节整节删掉，`tests/contract/doc-routing.test.ts` 的 `BLOCKER_COUNT` 从 3 改成 2
   （`blocker-freshness.test.ts` 不数 section 个数，不用改）；
4. `docs/dod-status.md`「Windows 安装包航运 · NSIS 产出与安装」一行改成**有证据**，证据引用那份报告与
   `--judge` 的退出码 0；
5. `README.md` 中英两半那句「The Windows run of the manual checklist has not happened」/「Windows 六步未跑」
   改成带日期的记录，并同步 `tests/contract/readme-parity.test.ts` 的 `LIMITATIONS` 表。

**这一节的断言在哪**：`tests/contract/judge-samples.test.ts` 的
`describe('the `--judge` samples in the Windows pack')` 逐行比对上面那两行与 `tests/fixtures/judge/` 里
两份报告喂给 `--judge` 的完整输出；`tests/contract/demo-script.test.ts` 的
`describe('each external blocker has a command and a line on screen')` 钉住演示页里那条命令与它的首行。

## 3. 五个界面状态的人眼走查（需要一个人）

- **最近核对**：2026-11-05 ｜ **重跑这一条**：`node scripts/screenshot-sources.mjs --check`

这一条的「重跑」只能量到一半：`--check` 说 PASS，说的是**那十张图还对着当前的渲染层源码**，
签字的人看的确实还是现在这一屏；它说不了任何人有没有看过它们。后一半只有人能回答——
判据与记录表都在 `docs/state-walkthrough.md`，那一页写清了「第一列带日期的一行才算一次签字」。

**解除命令**

有应用：`npm run dev:web`，按 `?scenario=empty` / `loading` / `error` / `partial` / `permission`
依次打开；只有图也行——五张图都在 `docs/screenshots/`，不必装应用、不必联网。
每一态三条「是 / 否」判据写在 `docs/state-walkthrough.md`，照着屏幕上真的会出现的字找。

**期望输出**

`docs/state-walkthrough.md` 的记录表里出现一行带日期、结论写「五态判据全满足」的记录，
并且 `README.md` 中英两半那句「五个界面状态还没有被人眼走查过」同时改口、带上同一个日期。
判据不是命令的输出，是**一个人签的字**；签字之后
`npx vitest run tests/contract/state-walkthrough.test.ts` 才会绿（它在两个方向上都打红提醒：
签了字而 README 没改、或 README 改了而表里没有签字）。

**结果放到哪个路径**

1. `docs/state-walkthrough.md` 记录表追加一行（日期 / 走查人 / 看了哪几张 / 结论）；
2. `README.md` 中英两半对应句子带上这个日期；
3. `docs/dod-status.md`「权限门不可绕」一行的「还差什么」改为已走查（带日期）。

**做不到时不要做什么**：不要代签。五态被断言、被测量、被拍照过，但没有人看过并说
「这读起来像首启 / 像失败 / 像权限请求」——这一条没有机器版本。

**这一轮为什么仍然阻塞，以及下一步落在谁身上**：这台机器上没有一个可派的人来回答那十五问，
而签字不能代。所以「等谁、什么时候、看哪十张、答完改哪三处」已经写进
`docs/state-walkthrough.md` 的 `## 还没有人签：这一节写清等谁、什么时候、看哪十张`——
第一顺位是仓库所有者，因为初审答辩时那句「这一屏我看过」必须由站在评审面前的人自己说。
判据一条没改、图一张没重拍，所以上面那条 `--check` 说 PASS 时，它量到的仍然只是
「那十张图还对着当前的渲染层源码」，而不是「有人看过它们」——这两件事的差别，就是这一节
还留在「外部阻塞」而不是「有证据」的原因。

### 解除时：签完字之后，一条命令、一行输出、四处要改的文档

**跑这一条**（签字之后跑，它量的是「表里那一行与 README 那句是同一件事」）：

```bash
npx vitest run tests/contract/state-walkthrough.test.ts
```

**屏幕上第一行**（判据是退出码 0，且 `docs/state-walkthrough.md` 的记录表里多了一行带日期的签字）：

```text
✓ tests/contract/state-walkthrough.test.ts
```

**解除后要改的四处**：

1. `docs/state-walkthrough.md` 记录表追加一行（日期 / 走查人 / 看了哪几张 / 结论写「五态判据全满足」）；
2. `README.md` 中英两半那句「五个界面状态还没有被人眼走查过」/「has not happened」同时改口、带上同一个日期
   ——`state-walkthrough.test.ts` 两个方向都打红：签了字而 README 没改、或 README 改了而表里没有签字；
3. `docs/dod-status.md`「权限门不可绕」一行的「还差什么」改为已走查（带日期）；
4. `docs/demo-script.md`「三条阻塞的现场降级路径」里**第三条**整块删掉，`DEGRADED_COMMANDS` 同步删掉
   （用例名里的 `three blocks` 一起改，同第 1 条）；「演示之外」那节末尾那句「这一条在
   `docs/manual-verification.md` 里如实写着「仍未做」」要改口，`docs/manual-verification.md` 里两处
   `**仍未做**` 段落（2026-11-04 那节与它上一节各一段）都提到「步骤 6 的人眼走查」，两处一起改。

**这一节的断言在哪**：`tests/contract/state-walkthrough.test.ts` 的
`describe('the five states have criteria a person can answer')` 钉住判据与签字表；
`tests/contract/screenshots.test.ts` 的 `describe('the screenshots are in sync with the renderer')` 钉住
「那十张图还对着当前渲染层源码」；`tests/contract/demo-script.test.ts` 的
`describe('each external blocker has a command and a line on screen')` 钉住演示页里那条命令与它的首行。

## 本机全量测试的已知环境约束（不是外部阻塞）

- **最近核对**：2026-11-05 ｜ **重跑这一条**：`npm run test:local`

这一节不是第四条外部阻塞：它不需要令牌、不需要 Windows、不需要人，**换一台机器就不存在**。
写在这里是因为它连续三轮以「本机 vitest 因 /tmp 不可写大面积失败，与本改动无关」的形式出现在
commit message 里——同一句免责话出现三次之后，读者就不再读它，而这正是这一页整页在防的事。
所以它变成一次根因排查、一条替代命令、一条会红的断言。

**哪台机器**：`VM-0-5-ubuntu`（本仓的开发机）。`/tmp` 不是磁盘，是一块带**用户配额**的 tmpfs：

```console
$ df -h /tmp
Filesystem      Size  Used Avail Use% Mounted on
tmpfs           1.9G  1.5G  348M  82% /tmp

$ df -i /tmp
Filesystem     Inodes  IUsed   IFree IUse% Mounted on
tmpfs         1048576  36120 1012456    4% /tmp

$ mount | grep -w /tmp
tmpfs on /tmp type tmpfs (rw,nosuid,nodev,size=1903632k,nr_inodes=1048576,inode64,usrquota)
```

**根因**：`usrquota` 的额度被历次测试留下的 `mkdtemp` 目录吃满（`/tmp/ucad-*` 近三千个），
于是写入失败在 `EDQUOT` 上——Node 把它报成 `Unknown system error -122`，一个不含「磁盘满」
也不含 `/tmp` 的错误串。`df` 说还有 348M 可用，`dd` 却立刻 `Disk quota exceeded`：**看 `df`
看不出这件事**，这就是它被当成「与本改动无关」的原因。一次全量 `npm test` 的后果是
**108 个测试文件里 77 个红**，红的全是写临时文件的那一步，与被测代码无关。

**替代命令**（本机跑全量用这一条，两条环境约束一起解决）：

```bash
xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" npm run test:local
```

`npm run test:local` 是 `scripts/test-local.mjs`：把 `TMPDIR` / `TEMP` / `TMP` 指到仓库内的
`.tmp/`（已进 `.gitignore`），跑与 `npm test` 完全相同的 `vitest run`，跑完删掉；`xvfb-run`
是第二条约束——`tests/contract/layout.test.ts` 要一个真布局引擎，没有 `$DISPLAY` 时它自己
会红并说明原因。这一条在本机跑出来是 **107 个文件绿、1 个红**（`layout.test.ts`，见下）。

**它证明不了什么**：`npm test` 仍是 CI 跑的那条命令，**没有**被改成依赖 `.tmp/`——GitHub
runner 的 `/tmp` 不是这台机器的 `/tmp`，一条只在挪走临时目录后才绿的闸门，量的是绕法而不是产品。
`test:local` 是给需要它的机器用的，它每次运行都打印自己用的目录，所以一段 transcript 不会被
误读成一次普通的 `npm test`。

**这一节的断言在哪**：`tests/contract/local-test-env.test.ts` 钉住三件事——这一节点名的
`npm run test:local` 真的在 `package.json` 的 `scripts` 里（写一条没人跑的替代命令是这一页
最坏的形态）、`scripts/test-local.mjs` 真的把 `TMPDIR` 指到仓库内、`.tmp/` 真的被 `.gitignore`
挡住；它还跑一次 `--dry-run`，断言脚本自己报出来的目录在仓库里。

## 交接记录（做了就加一行，只追加）

| 阻塞 | 日期 | 做的人 | 结果落在哪 | 判定 |
|---|---|---|---|---|
| — | — | — | — | **三条均未解除**：等一个写权限令牌、一台 Windows 机器、一个人 |

三条都**不阻塞**本仓库的门禁：`npm run typecheck`、`npm run lint`、`npm run knip`、
`npm test`、`npm run test:e2e` 都不需要令牌、Windows 机器或人眼。这五步连同 build 与 clean build
可以用一条命令跑完，而且命令清单是从 `.github/workflows/ci.yml` 读出来的：`npm run verify:gates`。它们阻塞的是
「已发布产物与真机」这两件事，而那正是 `docs/dod-status.md` 表里还红着的行。
