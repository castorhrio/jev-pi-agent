# 从 Windows 机器带回的证据：命名、放哪、怎么判

这个目录只放**从别的机器带回来的证据**，不放生成物、不放截图源文件。它存在的理由很窄：
`docs/dod-status.md` 的 DOD-4.1（Releases 上 NSIS 可装）是 `外部阻塞`，解除条件是
「一台 Windows 机器上跑一次，把报告带回来，被判成过」。在那之前，这条路径上唯一的缺口是
**没人说清楚带回来的文件该叫什么、放哪、谁判**——于是「跑过了」只能靠转述。

这一页就是那个约定。它**不改产品行为**，也不改判定规则：判定在
`scripts/verify-main-chain.mjs` 的 `judgeReport()` 里，`tests/contract/win-report.test.ts`
两个方向都钉住。这一页只回答「文件叫什么、放哪、判完改哪三处」。

## 一、文件命名（唯一约定）

```
docs/manual-verification/win-YYYYMMDD.json
```

- `win` 是平台，不是「Windows 版」的意思——`--judge` 会核对报告自报的 `platform` 是不是 `win32`，
  文件名写 `win` 而报告写 `linux` 会被判红（`a run on another platform is a real result about that platform`）。
- `YYYYMMDD` 是**跑的那天**，不是提交的那天。同一天跑两次就加后缀：`win-20261105-2.json`。
- **一份报告一个文件，不覆盖。** 一份红的报告是结果，不是一次失败的上传；把它改成绿才是。
  重跑就新增一个文件，旧的那份留着——它记着当时那台机器上真的发生了什么。

## 二、三张截图（同一套命名）

DPAPI、托盘、NSIS 三条链路在 Windows 与 Linux 上行为不同，而报告只能记文字。
所以每次跑分**顺带**拍三张，命名跟着报告走：

| 文件 | 拍什么 | 为什么它不能省 |
|---|---|---|
| `win-YYYYMMDD-dpapi.png` | 应用正常开窗（说明 `safeStorage` 走通了 DPAPI） | 钥匙串不可用时应用在开窗之前就停下，报告里只有一行 `[BLOCKED]`；有窗就是反证 |
| `win-YYYYMMDD-tray.png` | 通知区里的 UCAD 图标与展开的菜单 | 托盘是原生对象，DevTools 碰不到；报告断言的是应用自己写的 `tray menu built` 日志，图是它的旁证 |
| `win-YYYYMMDD-nsis.png` | 安装向导（选目录那一屏）或装完后的开始菜单项 | `npm run package` 出的是免安装目录，**不是** NSIS 安装包；这一张证明的是 `npm run dist` 那条路 |

三张都放这个目录，和报告同名不同后缀。

**这三张图是旁证，不参与判定。** `--judge` 只读 `win-YYYYMMDD.json`，不打开这三张图，
也不检查它们是否存在、是否清晰——它没有像素，也不该假装有。所以：

- 报告判绿而图缺失，判定仍然是绿；缺的是旁证，不是结论。读报告的人自己看一眼图，
  就知道「这台机器上确实开过窗」有没有被证实。
- 反过来，图拍得再清楚也关不掉 DOD-4.1：那一行只认 `--judge` 的退出码 0。
- 「能看清是哪一屏」是给读图的人的标准，不是给命令的标准：一张图只要能让没跑过这次的人
  认出「这是应用主窗口 / 这是通知区菜单 / 这是安装向导」，它就够用了。不必精修、不必裁切、
  不必打码（图里没有令牌，令牌只出现在 `Authorization` 头里，从不落盘）。

这条边界由命令自己说出来：`--judge` 判绿时会打印
`[note] the three screenshots a run carries home are evidence for a reader, not for this command`，
`tests/contract/handoff-packs.test.ts` 钉住这一行——把这一页改成「图会被检查」会打红。

## 三、在 Windows 机器上跑什么

先 `git clone` 本仓库、`npm ci`，然后：

```powershell
npm run package
node scripts\verify-main-chain.mjs --exec release\win-unpacked\UCAD.exe --report win-report.json
```

`npm run package` 产出 `release\win-unpacked\UCAD.exe`（`--exec` 指的就是它，Windows 上的默认值
也是这个路径）。第二行跑步骤 1–5，把每一步的判定与它自己记的证据行写成 `win-report.json`——
它**不上传任何东西**，报告就是仓库根目录里的一个文件。跑之前不需要令牌。

顺带跑一次打包适配器解析（这一步在 Windows 上尤其值得跑，因为 asar 真读只有手验）：

```powershell
node scripts\verify-packaged-adapters.mjs
```

期望看到 `adapters resolved: universal, mock`，退出码 0。

## 四、带回来之后怎么判（读的人跑这条，不必读 JSON）

```bash
node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json
```

**期望输出**（退出码 0）：

```
PASS — the report covers steps 1, 2, 3, 4, 5 on win32 against build 1.0.0
[note] every `pass` row carries the evidence lines the step recorded, not just a verdict
[note] this judges what the file says, not that the run happened — see the `note` inside the report
[note] step 6 is the five states a person walks in `npm run dev:web`; no report closes it
[note] the three screenshots a run carries home are evidence for a reader, not for this command — it reads the report and nothing else
```

判定要求四件事同时成立，每一条各自会红、各有一句话：

| 不满足 | 原文 |
|---|---|
| 报告自报的平台不是 `win32` | `a run on another platform is a real result about that platform, not about this one` |
| 某一步 `fail` | `step N failed in that run — a red report is a result, and the row stays open` |
| 某一步 `skip` | `step N was not run in that run (\`skip\`), so it is not covered` |
| 报告里没有这一步 | `step N is not in the report` |
| 某一步说 `pass` 却没有证据行 | `… behind it is a claim, not a result; run it again so the step records what it saw` |

最后一条是这份报告**唯一能被查的**那件事：报告是文档，文档可以手写，所以「这些步骤真的跑过」
证明不了；但「说 pass 却什么都没记」可以拒。真正的运行里，一步只有先 `record()` 过才会 `pass()`，
所以这条规则不会冤枉真跑的报告；而手写五行 `pass` 会被拒，不再和一份真报告长得一样。

它判的是**文件里写了什么**，不是这次运行真的发生过——这句话在 `judgeReport()` 的注释里、
在报告自己的 `note` 字段里、也在这条命令的输出里。它也不能替 step 6 收口：
五态是人眼走查（`docs/state-walkthrough.md`），任何报告都关不掉那一行。

## 五、报告长什么样

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

`build.version` 必须等于本仓库 `package.json` 的版本。版本一升，旧报告就判红——
「关于另一个构建的报告只证明另一个构建」，那时的正确答案是重跑，不是「我们跑过了」。

### 形状的出处：`docs/manual-verification/report-schema.json`

上面那段 JSON 不是举例，它有一个**可读的出处**：`docs/manual-verification/report-schema.json`
（JSON Schema 2020-12）。`--judge` 先按这份 schema 校验形状，再问 schema 问不了的那几件事
（`platform` 是不是这一行要的平台、`build.version` 是不是本仓库的版本、每一步在不在且是不是
`pass`、每个 `pass` 有没有带证据行）。所以拿到一份报告的人**不必读脚本**就能知道它该长什么样：

- 根上五个字段 `platform` / `build` / `ranAt` / `steps` / `note` 都必填；
- `build` 必填 `executable` 与 `version`（`sizeBytes` / `modifiedAt` 可空，它们只用来区分两次跑分）；
- `steps` 至少一行，每行必填 `n` / `verdict` / `evidence`，`verdict` 只能是 `pass` / `fail` / `skip`，
  `evidence` 至少一条字符串。

形状不对的报告**不再往下判**——形状是后面每一个问题的前提。这条边界由
`tests/contract/main-chain-report-schema.test.ts` 钉住：`buildReport()` 写出来的报告必须过 schema，
把某个字段从 schema 的 `required` 里删掉之后同一份报告就不再被拒（证明 schema 是事实来源，
不是脚本旁边的装饰），schema 里出现的每个关键字都必须是校验器真的实现了的那几个。

## 六、不许做什么

- **不许手写一份报告。** 报告是文档，文档可以手写，所以手写出来的东西和真报告长得一样；
  `--judge` 只能拒掉「说 pass 却什么都没记」这一种。手写一份带证据行的假报告，骗过的是自己。
- **不许把「跑过 Linux」写成「Windows 通过」。** 平台是判定的一部分，不是备注。
- **不许把被阻塞的运行（退出码 2）当成报告。** 钥匙串不可用时应用在开窗之前就停下，
  那一段 `[BLOCKED] …` 的控制台原文就是证据，请连同它一起贴回来，报告不会写。

## 七、判过之后改哪三处

1. **`docs/manual-verification.md`** 的记录表追加一行（日期 / 平台 / 构建 / 覆盖步骤 / 结果），
   证据写 `见 docs/manual-verification/win-YYYYMMDD.json`，再补一句结论。
2. **`docs/dod-status.md`** 的 DOD-4.1 一行从 `外部阻塞` 改成 `通过`，证据列加上
   `docs/manual-verification/win-YYYYMMDD.json`，并把「还差什么」改成 `—`。
3. **`docs/blockers.md`** 的交接记录表追加一行，判定写「第 2 条已解除」。

三处都改完，`npx vitest run tests/contract/dod-status.test.ts tests/contract/doc-routing.test.ts`
仍然要绿——它们会核对证据列里的每个路径真的存在。

## 这一页由门禁钉住

`tests/contract/handoff-packs.test.ts` 断言：这一页引用的每一行「期望输出」都还在
`scripts/verify-main-chain.mjs` 的源码里（改了脚本的措辞而没改这一页，会打红），
`docs/manual-verification/` 这个目录真的存在，并且 `win-YYYYMMDD.json` 这个命名约定在
`docs/blockers.md`、`docs/manual-verification.md` 与这一页里是**同一个字面量**。
第二节那条「三张图是旁证、不参与判定」的边界也在其中：它引用的 `[note]` 行由
`judgeReportCommand()` 打印，这一页说「图会被检查」会打红。
命令的旗标由 `tests/contract/manual-check-docs.test.ts` 钉住。
