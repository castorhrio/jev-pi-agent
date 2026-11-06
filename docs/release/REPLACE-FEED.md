# 换掉 v1.0.0 的 `update-feed.json`：一页操作单

这一页只做一件事：**把 GitHub Releases 上那份缺 `sha256` 的 `update-feed.json` 换成仓库里这份
已经判干净的文档**。它写给一个拿到 `contents: write` 令牌、但没读过本仓库代码的人——
照着从上往下敲，不需要先理解 `update-feed.ts` 的规则，也不需要下载那 120 MB 的安装包。

它**不是**发布流程：不建 release、不动安装包、不改版本号。它**不改产品行为**：
跑完它，变的是线上那份 JSON 资产，产品代码一个字节都没动。

判据的来源没有变：`docs/PRODUCT-DOD.md` 的 DOD-4.2 是标准，`docs/dod-status.md` 里那一行
是现状，`docs/blockers.md` 第 1 节是同一件事的摘要。这一页是它的**执行面**。

> **这一页引用的每一行「期望输出」都由 `tests/contract/handoff-packs.test.ts` 钉住。**
> 下面每一段 `期望输出` 里的句子，都是脚本源码里真的会打印的那一句；脚本改了措辞而这一页没改，
> 门禁会打红并指名是哪一句。所以照着这一页敲、看到对不上的输出时，先怀疑自己敲错了命令，
> 不要怀疑这一页——它和脚本是同一份事实。

## 前置条件（四条，缺一条就别开始）

1. **一个令牌**：对 `castorhrio/jev-pi-agent` 有 `contents: write`，放进 `GITHUB_TOKEN`
   （或 `GH_TOKEN`）。令牌只出现在 `Authorization` 头里，命令不会打印它。
2. **能连 `api.github.com` 与 `uploads.github.com`**。本机到 `github.com` 不通，所以这一步
   必须在另一台机器上做——这也是它一直没做的原因。
3. **仓库已 clone，且主进程已构建**：判定用的是应用自己的规则（`checkChannelUrl()` /
   `normalizeSha256()`），它们从构建产物里读。没构建时命令会直接说「先构建」，不会静默跳过判定。
4. **`docs/release/update-feed-v1.0.0.json` 在仓库里**（已提交，431 字节）。不需要重新生成，
   也不需要重新算哈希：里面的 `sha256=76bbe0c6…` 与 `size=122806279` 取自 GitHub 自己给该资产的
   digest，不是人抄的。

```bash
npm run build
```

## 离线预演：一条命令看四条命令的期望输出

上面四条命令里有两条在这台机器上跑不了：第 0 步要连 `github.com`，第 2 步要一个写权限令牌。
所以「这四条命令到底会打印什么」在拿到令牌之前只能靠读三份文档拼——而拼出来的东西没人跑过。
这一条命令把四条命令与它们的期望输出一次打印出来，**不联网、不需要令牌、不写任何文件、
不替换任何资产**：

```bash
node scripts/publish-feed.mjs --rehearse
```

**期望输出**（本机 2026-11-05 实跑，逐字；退出码 0）：

```text
[rehearse] feed: docs/release/update-feed-v1.0.0.json (431 bytes) — judged clean by the app’s own rules, offline
[rehearse] this run touches nothing: no network, no token, no file written, no asset replaced
[rehearse] the four commands below are the ones in `docs/dod-status.md` `### 有令牌时` and `docs/release/REPLACE-FEED.md`
[rehearse]
[rehearse] 1/4 node scripts/publish-feed.mjs --preflight
[rehearse]   exit 0 = the published feed is still the broken one — the direction is reversed on purpose
[rehearse]   last line: [preflight] verdict: the published feed is still the broken one — exit 0 means "still broken, run --apply --verify"
[rehearse]   the finding lines above it come from the host, so this rehearsal cannot print them
[rehearse]
[rehearse] 2/4 node scripts/publish-feed.mjs --dry-run
[rehearse]   exit 0 = the plan printed and nothing was written
[rehearse]   expected output, computed here from the committed document:
[rehearse]   feed: docs/release/update-feed-v1.0.0.json (431 bytes)
[rehearse]   version: 1.0.0
[rehearse]   installer: UCAD-Setup-1.0.0.exe (76bbe0c612ac67575ac40a543929a7691ba9f9e185343297cbc3badda9ea5a48, 122806279 bytes)
[rehearse]   target: update-feed.json on castorhrio/jev-pi-agent v1.0.0
[rehearse]   [plan] check 1 (already ran, before any token was read): the app’s own feed rules — docs/release/update-feed-v1.0.0.json produced no failure
[rehearse]   [plan] check 2: the host’s digest for UCAD-Setup-1.0.0.exe equals the feed’s sha256/size, before anything is deleted
[rehearse]   [plan] check 3 is not requested: add --verify to judge the published bytes after uploading
[rehearse]   [plan] GET https://api.github.com/repos/castorhrio/jev-pi-agent/releases/tags/v1.0.0
[rehearse]   [plan] compare the feed’s sha256/size with the host’s digest for UCAD-Setup-1.0.0.exe
[rehearse]   [plan] DELETE https://api.github.com/repos/castorhrio/jev-pi-agent/releases/assets/<existing update-feed.json id> (if present)
[rehearse]   [plan] POST https://uploads.github.com/repos/castorhrio/jev-pi-agent/releases/<release id>/assets?name=update-feed.json
[rehearse]   [plan] token: none — --apply needs GITHUB_TOKEN or GH_TOKEN
[rehearse]   dry run — nothing was fetched and nothing was uploaded. Add --apply to replace the asset.
[rehearse]
[rehearse] 3/4 GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify
[rehearse]   exit 0 = the asset was replaced and the published bytes were judged again
[rehearse]   the line that decides it: PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=76bbe0c612ac67575ac40a543929a7691ba9f9e185343297cbc3badda9ea5a48
[rehearse]   that line is a promise, not a measurement: only a real upload prints it
[rehearse]
[rehearse] 4/4 node scripts/verify-release-feed.mjs
[rehearse]   exit 0 = the published bytes pass the app’s own rules
[rehearse]   the line that decides it: PASS — 0 warning(s), nothing the app would refuse
[rehearse]   that line is a promise too: it reads the host, and this rehearsal does not
[rehearse]
[rehearse] verdict: the runbook is complete — 4 command(s), 1 printed from the committed document, 3 quoted from the scripts that print them
```

三件要读的东西：

- **第 2 段是算出来的**：它走的是 `--dry-run` 用的同一个 `planLines()`，输入是仓库里这份文档，
  所以这一段与真的 `--dry-run` 逐行相同——`tests/contract/publish-rehearsal.test.ts` 把两段
  逐行比对，改了 `--dry-run` 的措辞而没改预演（或反过来）会打红。
- **第 1、3、4 段是引用的**：`[preflight] verdict:` 那一行、`PASS — … now carries sha256=` 那一行、
  `PASS — 0 warning(s), nothing the app would refuse` 那一行，都取自真正打印它们的常量
  （`PREFLIGHT_VERDICT` / `uploadPassLine()` / `summaryLine()`），不是这一页抄的。
- **第 3、4 段自己写着「that line is a promise, not a measurement」**：预演**不**证明线上那份
  已经被换掉，也不证明安装包 URL 应答；它证明的是「照着敲会看到什么」。把预演的输出当成一次
  测量，正是这一页整页在防的事。

它退出 1 只有一种情形：仓库里这份文档本身被应用自己的规则拒了（那时它连预演都不打印，
与 `--apply` 在找令牌之前就拒绝是同一条判定）。`--rehearse` 是它自己的一次运行——
和 `--apply` / `--dry-run` / `--preflight` 写在同一条命令上会被拒绝，而不是按参数顺序挑一个。

## 第 0 步：先确认线上那份还是坏的（只读，一次 GET，不写任何东西）

```bash
node scripts/publish-feed.mjs --preflight
```

**期望输出**（本机 2026-11-04 实跑，逐字；这一跑真的读到了 GitHub 上那份资产）：

```
[preflight] target: update-feed.json on castorhrio/jev-pi-agent v1.0.0
[preflight] GET https://github.com/castorhrio/jev-pi-agent/releases/download/v1.0.0/update-feed.json (read-only, anonymous)
[preflight] before: 3 finding(s) on the published document
[FAIL] no-sha256: the feed publishes no sha256, so the app refuses to install what it downloads — null
[warn] no-size: the feed publishes no size, so a truncated download is only caught after hashing — absent
[FAIL] installer-latest-url: the installer URL uses releases/latest, which 404s once a newer release exists — https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe
[preflight] after: 0 finding(s) on docs/release/update-feed-v1.0.0.json
[preflight] fixed by this upload: no-sha256, no-size, installer-latest-url
[preflight] still there after the upload: (none)
[preflight] introduced by this upload: (none)
[preflight] field version: 1.0.0 (unchanged)
[preflight] field url: https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe → https://github.com/castorhrio/jev-pi-agent/releases/download/v1.0.0/UCAD-Setup-1.0.0.exe
[preflight] field sha256: (absent) → 76bbe0c612ac67575ac40a543929a7691ba9f9e185343297cbc3badda9ea5a48
[preflight] field size: (absent) → 122806279
[preflight] field notes: First release published on GitHub Releases. Layout order restored; tr… (unchanged)
[preflight] overwrites: https://github.com/castorhrio/jev-pi-agent/releases/download/v1.0.0/update-feed.json
[preflight] writes: none — this run only read the published document
[preflight] verdict: the published feed is still the broken one — exit 0 means "still broken, run --apply --verify"
```

四件要读的东西：

- **`before` 与 `after` 是同一个判定函数问的同一个问题**：`judgeFeedDocument()`，同一套应用规则，
  同一个 `expectedVersion`（取自仓库里这份文档的 `version`）。所以这两段不是两种意见，是同一把尺子
  量两份文档——`fixed by this upload` 那一行就是两段的差。
- **`still there after the upload` 是诚实的那一半**：两份文档共有的 finding 不会被上传修掉。
  今天它是 `(none)`；哪天不是，说明上传之后这一行仍然是红的。
- **`field` 行是字节层面的变化**：`url` 从 `releases/latest` 变成 `releases/download/v1.0.0`，
  `sha256` / `size` 从 `(absent)` 变成具体值。`notes` 是唯一会被截断的字段（自由文本），
  其余字段逐字打印——`url` 被截断就正好藏起了这次要修的那一段。
- **退出码是「线上那份还是坏的吗」的答案**，而且方向是反的，所以判定行把它写出来了：
  `0` = 还是坏的（下面这份计划是当前的，接着跑 `--apply --verify`）；
  `1` = 已经不是坏的了（线上已经是修正版，或者主机没应答——上一行会说清是哪一种）。
  这一跑退出 0，所以线上那份**确实还是坏的**。

这一步**不需要令牌**（公开仓库的资产匿名可读），也**不写任何东西**：不删资产、不落文件、不写日志。
`tests/contract/publish-preflight.test.ts` 把这两件事都钉住了——请求日志里只有一条 `GET`，
仓库里这份文档的字节与 mtime 前后一致。

## 第 1 步：再看计划，不联网、不写文件、不上传

```bash
node scripts/publish-feed.mjs --dry-run
```

**期望输出**（本机 2026-11-04 实跑，逐字）：

```
feed: docs/release/update-feed-v1.0.0.json (431 bytes)
version: 1.0.0
installer: UCAD-Setup-1.0.0.exe (76bbe0c612ac67575ac40a543929a7691ba9f9e185343297cbc3badda9ea5a48, 122806279 bytes)
target: update-feed.json on castorhrio/jev-pi-agent v1.0.0
[plan] check 1 (already ran, before any token was read): the app’s own feed rules — docs/release/update-feed-v1.0.0.json produced no failure
[plan] check 2: the host’s digest for UCAD-Setup-1.0.0.exe equals the feed’s sha256/size, before anything is deleted
[plan] check 3 is not requested: add --verify to judge the published bytes after uploading
[plan] GET https://api.github.com/repos/castorhrio/jev-pi-agent/releases/tags/v1.0.0
[plan] compare the feed’s sha256/size with the host’s digest for UCAD-Setup-1.0.0.exe
[plan] DELETE https://api.github.com/repos/castorhrio/jev-pi-agent/releases/assets/<existing update-feed.json id> (if present)
[plan] POST https://uploads.github.com/repos/castorhrio/jev-pi-agent/releases/<release id>/assets?name=update-feed.json
[plan] token: none — --apply needs GITHUB_TOKEN or GH_TOKEN

dry run — nothing was fetched and nothing was uploaded. Add --apply to replace the asset.
```

三件要读的东西：

- `check 1` 已经跑过了，**在找令牌之前**。文档不合格时命令在这里就退出 1，
  所以「有令牌的人手滑上传一份坏文档」这条路不存在。
- `token: none` 是**预期**的：这一步本来就不需要令牌。看到它说明命令没在偷偷联网。
- 最后一行是判据：`dry run — nothing was fetched and nothing was uploaded`。

## 第 2 步：再按

```bash
GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify
```

**期望输出**（最后一行是判据）：

```
PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=76bbe0c6…
```

`--verify` 会在上传之后**再跑一次读的一方**，所以「换好了」是两条命令的输出，不是一句声明。
不加 `--verify` 也能上传成功，但那样「换好了」就只剩上传方自己说的那一句。

## 第 3 步：读的一方复核（退出码 0 才算数）

```bash
node scripts/verify-release-feed.mjs
```

```
PASS — 0 warning(s), nothing the app would refuse
```

这一步**不需要令牌**，任何一台能连 `github.com` 的机器都能跑。它读的是线上那份字节，
不是仓库里这份——两者一致，才说明第 2 步真的落到了线上。

## 失败与回滚

三种失败，各有一句原文，都**不会**留下半成品：

| 看到什么 | 意思 | 怎么办 |
|---|---|---|
| `refused: … the app’s own feed check rejects this document` | 仓库里这份文档本身不合格（不该发生；发生了说明有人改过它） | 别上传。`git checkout docs/release/update-feed-v1.0.0.json` 后重来 |
| `blocked: no GitHub write token` | 令牌没设或没权限 | 设 `GITHUB_TOKEN` 再跑；线上资产**没变** |
| `refused: the host disagrees with …` | 宿主给的安装包 digest 与文档里的 `sha256`/`size` 不一致 | 别上传。先查安装包是不是被重新上传过；文档里的哈希取自 GitHub 的 digest，不一致说明资产变了 |
| `[preflight] unreachable: …` | 第 0 步没读到线上那份（主机不应答 / 404） | 重试。**什么都没比较、什么都没写**——这不是「线上是好的」，也不是「线上是坏的」 |

上面这四种都发生在**动线上资产之前**：命令在删任何东西之前就退出了，所以线上那份一个字节都没变。
动过之后才失败的那一半在下一节——那一半的退出码也是 1，但线上那份的状态完全不同。

**回滚**：这个命令只替换一个 JSON 资产，旧的那份是缺 `sha256` 的坏文档，**没有回滚的必要**——
回到旧状态等于回到「更新通道对所有人失效」。真要退回，用 GitHub 网页的 release 编辑页重新上传
任意一份 `update-feed.json` 即可，不涉及安装包。

## 如果 `--apply` 中途失败

`--apply` 不是一次写入，是三步：读 release、删旧资产、传新资产（`--verify` 再加一次复核）。
中间任何一步都可能断，而**退出码 1 不等于什么都没发生**——这是这一节存在的唯一理由。
拿到令牌那天最可能遇到的正是这一半，而它以前只写在脚本源码里。

| 断在哪一步 | 屏幕上那一行 | 线上那份 `update-feed.json` 处于什么状态 | 下一步跑什么 |
|---|---|---|---|
| 判定 / 令牌 / 读 release / 宿主 digest 不一致 | `refused: …` · `blocked: no GitHub write token` · `release-unreadable: …` · `refused: the host disagrees with …` | **没变**，还是那份缺 `sha256` 的旧文档 | 修掉原因，重跑同一条命令 |
| 删旧资产失败 | `asset-delete-failed: DELETE assets/<id> answered <status>; the old document is still published.` | **没变**，旧文档还在（删除没成功） | 重跑同一条命令；连续失败说明令牌没有 `contents: write` |
| 删成功、传失败 | `asset-upload-failed: POST assets answered <status>; rerun this command once the cause is fixed.` | **不存在了**：release 上没有 `update-feed.json`。应用侧读不到 feed，判定是 `feed-unreachable: the feed could not be fetched, so every update check fails` | 重跑 `GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify`；它会打印 `[note] no asset named update-feed.json on v1.0.0 — uploading a new one` 并直接上传 |
| 传成功、`--verify` 失败 | 退出码是 `verify-release-feed.mjs` 的退出码（1），而上传那一行 `PASS — … now carries sha256=…` 已经打印过 | **已经是新的那份**：上传落地了，是复核没过 | 单独跑 `node scripts/verify-release-feed.mjs`，看它指名哪一条 finding；**不要**重跑上传那一步——那会再删再传一次，而问题在复核那一侧 |

三件要读的东西：

- **只有第三行是「比之前更糟」**：旧文档是坏的但读得动，没有文档是读不动。这个窗口只有 DELETE 与
  POST 之间那一次请求那么长，而它**没有回滚**——回滚到旧文档等于回到「更新通道对所有人失效」。
  所以恢复动作不是回滚，是**重跑同一条命令**：`--apply` 在 release 上找不到同名资产时会走
  `[note] no asset named …` 分支直接上传，不需要先手工补一份。
- **第四行不是失败的上传**：`--verify` 是上传之后另跑的一次复核，它红了说明线上那份字节没过应用自己的
  规则（最常见的是主机不应答安装包 URL）。这时**不要**重跑 `--apply`——那会再删再传一次，而问题在复核那一侧。
- **每一行都有一句原文可对**：表格里反引号包住的句子都是 `scripts/publish-feed.mjs` 真的会打印的字面量，
  `tests/contract/publish-rehearsal.test.ts` 逐句核对它们还在脚本源码里——脚本改了措辞而这一页没改，
  红的是这一页，并指名是哪一句。

**这一节不改实现。** 它写的是 `--apply` 今天的行为，不是「应该怎样」：删旧资产与传新资产之间没有事务，
所以中间断掉就是没有资产。要改这一点是另一件事（先传后删、或传成临时名再改名），不在这一轮。

## 做完把什么放回哪里（三件，缺一件这行就还是红的）

1. **完整 stdout/stderr 追加进 `docs/manual-verification.md`**，含 `PASS —` 那一行，不要转述。
2. **`docs/dod-status.md` 的 DOD-4.2 一行**从 `未过` 改成 `通过`，证据列加上
   `docs/manual-verification.md`，并把「还差什么」改成 `—`。
3. **`README.md` 中英两半**删掉那条 v1.0.0 局限，并同步 `tests/contract/readme-parity.test.ts`
   的 `LIMITATIONS` 表——少改一处会打红，这是故意的。

## 没有令牌时能做什么（本机现在能做的）

```bash
node scripts/replay-feed-local.mjs
```

它把仓库里这份修正版文档原封不动地用一个本地 TLS 地址托起来，让 `scripts/verify-release-feed.mjs`
与 `scripts/release-gate.mjs` 对着它跑一次**绿分支**（退出码 0，两行 `PASS`）。
它证明的是**链路**，不是**发布**：GitHub Releases 上那份 asset 在这之前和之后都还是旧的。
这一次的输出已经写在 `docs/manual-verification.md` 里，任何人可以在自己的机器上重跑复现。

## 这一页由门禁钉住

`tests/contract/handoff-packs.test.ts` 断言：这一页引用的每一行「期望输出」都还在对应脚本的源码里
（改了脚本的措辞而没改这一页，会打红），并且这一页与 `docs/blockers.md` 指向同一个返回路径。
命令本身的旗标由 `tests/contract/manual-check-docs.test.ts` 钉住——写一个脚本不接受的 `--flag`，
同样会打红。

第 0 步那一段还多一层：`tests/contract/publish-preflight.test.ts` 钉住「preflight 只读、不写」，
以及「它和 `--apply` 用的是同一个判定」——同一份 `judgeFeedDocument()`、同一套规则、同一个
`expectedVersion`。所以这一页说的「两份判定」不是两种意见，是同一把尺子量两次。
