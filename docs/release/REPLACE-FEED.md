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

## 第 0 步：先看，不联网、不写文件、不上传

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

## 第 1 步：再按

```bash
GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify
```

**期望输出**（最后一行是判据）：

```
PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0 now carries sha256=76bbe0c6…
```

`--verify` 会在上传之后**再跑一次读的一方**，所以「换好了」是两条命令的输出，不是一句声明。
不加 `--verify` 也能上传成功，但那样「换好了」就只剩上传方自己说的那一句。

## 第 2 步：读的一方复核（退出码 0 才算数）

```bash
node scripts/verify-release-feed.mjs
```

```
PASS — 0 warning(s), nothing the app would refuse
```

这一步**不需要令牌**，任何一台能连 `github.com` 的机器都能跑。它读的是线上那份字节，
不是仓库里这份——两者一致，才说明第 1 步真的落到了线上。

## 失败与回滚

三种失败，各有一句原文，都**不会**留下半成品：

| 看到什么 | 意思 | 怎么办 |
|---|---|---|
| `refused: … the app’s own feed check rejects this document` | 仓库里这份文档本身不合格（不该发生；发生了说明有人改过它） | 别上传。`git checkout docs/release/update-feed-v1.0.0.json` 后重来 |
| `blocked: no GitHub write token` | 令牌没设或没权限 | 设 `GITHUB_TOKEN` 再跑；线上资产**没变** |
| `refused: the host disagrees with …` | 宿主给的安装包 digest 与文档里的 `sha256`/`size` 不一致 | 别上传。先查安装包是不是被重新上传过；文档里的哈希取自 GitHub 的 digest，不一致说明资产变了 |

**回滚**：这个命令只替换一个 JSON 资产，旧的那份是缺 `sha256` 的坏文档，**没有回滚的必要**——
回到旧状态等于回到「更新通道对所有人失效」。真要退回，用 GitHub 网页的 release 编辑页重新上传
任意一份 `update-feed.json` 即可，不涉及安装包。

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
