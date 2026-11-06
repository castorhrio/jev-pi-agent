# 初审答辩：演示前检查清单

这一页只列**答辩当天要跑、要看**的东西，从上往下走一遍，每一步都要看到它说的那一行。
看不到就停在那一步，别往下讲——现场最贵的不是少讲一段，是讲到一半屏幕上是空的。

判据与签字表在 `docs/state-walkthrough.md`，三条外部阻塞的降级命令在 `docs/demo-script.md`
的「三条阻塞的现场降级路径」，阻塞本身在 `docs/blockers.md`。这一页不重复它们，只把它们
按**当天的时间顺序**排一遍。

**每一步都带一条「它退出 1 时怎么办」**：这一页上六条命令里有三条会在图、报告或 feed 与
仓库不同步时退出 1，而不同步是上一轮改动最常留下的东西。现场没有时间读源码，所以降级路径
写在命令下面，而不是写在「被问到怎么办」里。

## 0. 前一天：门禁先绿

```bash
npm run verify:gates
```

退出码 0 才睡。它跑的是 `.github/workflows/ci.yml` 里那五步（typecheck / lint / knip / test /
test:e2e）加 build 与 clean build，命令清单从 CI 文件里读，不是这一页抄的。
**这一步红着上台，等于把「门禁即 DoD」这句话当场作废。**

## 1. 起得来

```bash
npm run dev
```

窗口起来、托盘有图标、没有白屏。起不来就先修这个，别修别的。

浏览器那条路（不需要 Electron，答辩现场更稳）：

```bash
npm run dev:web
```

打开 `http://localhost:5173`，看到对话区而不是空白页。

## 2. 离线主链路：哈希可核对

```bash
npm run demo
```

屏幕上应看到 `renderedHash 8847aa57a7138fd5` 与 `Pack cp_demo_0000000000000000000000 · 2 条 · 180 tokens`。
这个 hash 在任何机器上都一样（包是固定的、`render()` 是纯函数），所以它可以在台上被念出来、
也可以被评委在自己的机器上重跑一遍对上。

## 3. Context Drawer：哈希与原文同屏

`?scenario=empty` → 发一句「修复登录失败并补测试」→ 打开「上下文」抽屉。

应看到 `注入的原文 <ucad-context pack="cp_demo_0000000000000000000000"` 与
`renderedHash 8847aa57a7138fd5`——**与第 2 步打印的是同一个值**。这一条就是「可证明注入」：
屏幕上的 hash 是屏幕上那段字节的 sha256，不是一句「已注入 3 个文件」。

## 4. 决策链可见

打开「决策」面板。应看到 `引擎链 jev > rule`、`由谁给出 jev · 0.1.0`、`置信度 72%`、
`理由 route -> 'mock' (default runtime)`。

这一条是「可解释路由」：引擎、理由、置信度在同一屏，回落也如实记成回落。

## 5. 权限弹窗可演示

`?scenario=permission` → 读弹窗 → 点「拒绝」。

弹窗标题是 `Agent 请求权限`，正文五件可读（类别 `SHELL`、风险 `high`、资源、命令、原因），
四个回答都在（`允许一次` / `本次会话允许` / `本项目允许` / `拒绝`）。点「拒绝」之后弹窗消失，
事件流里出现 `permission.resolved {"requestId":"req-demo","decision":"deny","decider":"user"}`。

**弹窗消失不算完，事件流里那一行才算完**——决定没被记下来，等于没发生。

## 6. 五态截图能翻

```bash
node scripts/screenshot-sources.mjs --walkthrough
```

十行路径，按走查顺序。翻图从 `docs/screenshots/empty.png` 到
`docs/screenshots/states/permission-768x700.png`，五态 × 两个尺寸。

被问到「这五个状态是真机跑的吗」：图是布局门禁在真实 Chromium 里拍的，不是手绘也不是 mock；
但**观感**仍然要人眼看，判据与签字表在 `docs/state-walkthrough.md`，那一页的
`## 10 分钟速查表` 是三十二行的答题纸。

被问到「失败那一屏呢」，照念 `error` 的第四条判据：**这一屏说得出下一步**——屏幕上那一句
「先点重试，它会把刚才失败的那一步重新跑一遍」在三个按钮**之前**出现，`tests/e2e/scenarios.e2e.test.tsx`
断言的就是这个先后顺序。答「否」的条件也写在那一态的「不合格长什么样」里：原因写了但没说下一步，
三个按钮读起来像占位的。

被追问「为什么这一屏没有侧栏、没有状态栏」时，念**两句**，十秒内念完，不要临场组织：

1. **形状**：「rail 和 statusbar 不该有，topbar 该有——首启失败时那个工作区没加载成功，
   画一个空侧栏等于声称有一个打不开的项目；topbar 上只剩品牌和语言开关，那是这一屏唯一还能用的控件。」
2. **代价**：「这一屏九成是背景色，视觉上确实空；接受它的理由是空得诚实，不是空得好看。」

第二句必须念出来。只念第一句，听起来像在解释为什么没做完；两句一起念，才是在说一个已经做过的判断。
判断本身与代价写在 `docs/dod-status.md` 的 critique 一节，门禁在 `tests/contract/layout.test.ts`
（`topbar` 在、`rail` 与 `statusbar` 不在，两个方向都断言）。

**它退出 1 时**：屏幕上是 `[unrecorded] …` 或 `no walkthrough images: …`，说的是**图与
`docs/screenshots/sources.json` 不同步**，不是图坏了。先跑下面这条，让它说清是哪一张：

```bash
node scripts/screenshot-sources.mjs --check
```

它逐张报 `[stale] …` 或一行 `PASS — …`。`[stale]` 的那几张是渲染层源码改过之后没重拍的：
**现场不要重拍**（重拍要跑布局门禁，时长不可控，见第 9 步），照念旧图，并说清「这几张是
<日期> 拍的，之后渲染层改过，判据没变」。`--check` 说 `PASS` 而 `--walkthrough` 仍退出 1，
说明 `docs/state-walkthrough.md` 的表里有一张图不在 `sources.json` 里——那是文档与清单不同步，
念 `docs/state-walkthrough.md` 的表，跳过那一张。

## 7. 被问到「那你怎么证明」：三条降级命令

三条外部阻塞当天大概率还没解除，三条命令都在本机离线可跑，屏幕上会留下能指着念的一行：

```bash
node scripts/release-gate.mjs --simulate-missing-sha
```

```bash
node scripts/verify-main-chain.mjs --judge docs/manual-verification/win-YYYYMMDD.json
```

```bash
node scripts/screenshot-sources.mjs --check
```

每条念哪一句、退出码是什么、它证明不了什么，写在 `docs/demo-script.md` 的
「三条阻塞的现场降级路径」——**照着念，不要临场组织语言**。

### 7.1 没有 Windows 机器时，当场演示一次「诚实拒绝」

第 7 步第二条命令 `--judge` 判的是**一份报告文件**，不是一次运行。所以它不需要 Windows，
也不需要那台机器在场——而这正是答辩当天最可能缺的东西。缺了不要绕过去，**当场演示这条拒绝**：
它把「没有 Windows 机器」从一次尴尬变成一次可演示的判断。

本机（Linux）先把六步跑一遍，把报告写成文件：

```bash
xvfb-run -a node scripts/verify-main-chain.mjs --report /tmp/linux-report.json
```

它退出 0，最后一行是 `PASS — steps 1, 2, 3, 4, 5 recorded above`。**这是 Linux 上的通过，
不是 Windows 上的通过**——念的时候要把这半句说出来，否则台上就变成了一次冒充。

再把这份报告交给读的一方：

```bash
node scripts/verify-main-chain.mjs --judge /tmp/linux-report.json
```

**退出码 1**，最后两行是：

```text
[FAIL] the report was written on linux, and this row is about win32 — a run on another platform is a real result about that platform, not about this one
FAIL — 1 thing(s) in this report keep the row open
```

念这一句，两句一起念完：

1. **报告是文档，文档可以手写**，所以 `--judge` 拒的是「说 pass 却什么都没记」，不是「没跑过」。
   这份 Linux 报告五步全 `pass`、每一步都带着自己的证据行，`--judge` 仍然拒——因为它说的是
   另一台机器上的事。反过来，一份手写的、五步都写 `pass` 却一行证据都没有的报告，`--judge`
   也会拒，拒在「声称不是结果」上。
2. **所以这一条现在能演示**：没有 Windows 机器时，屏幕上留下的不是一句「还没跑」，而是一次
   有退出码、有原文、有理由的拒绝。评委可以自己敲一遍，得到同一行。

**它证明不了什么**：它不证明 Windows 上跑得通，也不证明那份报告是真是假——`--judge` 只读文件说了
什么。这一点写在报告自己的 `note` 字段里，也写在 `docs/blockers.md` 第 2 节的
「做不到时不要做什么」。

## 8. 三条阻塞什么时候关：三个数

`docs/blockers.md` 三条都写着同一个截止 `2026-11-19`。答辩当天被问「这三条什么时候关」，
答案不是「尽快」，是三个数——**2026-11-06 量到**：

| 阻塞 | 责任人 | 截止 | 距截止 |
|---|---|---|---|
| 第 1 节 · 已发布的 v1.0.0 feed 缺 `sha256` | castorhrio | 2026-11-19 | **距截止 13 天** |
| 第 2 节 · Windows 桌面六步 | castorhrio | 2026-11-19 | **距截止 13 天** |
| 第 3 节 · 五个界面状态的人眼走查 | castorhrio | 2026-11-19 | **距截止 13 天** |

这三个数不是抄的：`tests/contract/blocker-freshness.test.ts` 的 `deadlineCountdown()` 从
`docs/blockers.md` 的 `**截止**` 行读出来，跑一次就能重算：

```bash
npx vitest run tests/contract/blocker-freshness.test.ts
```

**这三个数会过期，而过期的是「今天」，不是文档**——所以这一节带着量它的日期（2026-11-06）。
答辩当天重跑上面那条命令，把三个数念成当天的数；念一个旧数比不念更糟，因为它听起来像刚量过。

被追问「为什么三条是同一个日子」：三条要的东西不同（一个令牌、一台 Windows 机器、一个人），
但它们是同一轮给出的、同一个长度的窗口，所以共用一个截止。三条里最近的一条就是 `2026-11-19`，
没有更近的。

## 9. 当天不要做

- 不要现场 `npm ci` 或 `npm run build`：装依赖与构建的时长不可控，前一天做完。
- 不要现场接真实厂商 key：这次演示只走 `mock`，说清楚，别等评委问。
- 不要现场改代码修一个「顺手发现的小问题」：改完门禁没重跑，讲的就是没验过的东西。
- 不要代签 `docs/state-walkthrough.md` 的记录表：那一行只能由看过十张图的人写。
- 不要说「大概注入了这些文件」：要么念 hash，要么不说。

## 这一页的断言在哪

`tests/contract/demo-script.test.ts` 的
`describe('the defence-day checklist only names things that exist')` 逐条核对：这一页点名的
每一条 `npm run …` 都在 `package.json` 的 `scripts` 里、每一个 `node scripts/…` 都是仓库里
真的有的文件、每一张截图与每一份文档都打得开、以及第 2 步那个 hash 与
`docs/demo-script.md` 里的是**同一个字面量**（两页各写一个 hash，等于两次演示只对上一次）。

第 8 步那三个数**不在这条门禁里**，这是故意的：`deadlineCountdown()` 已经由
`tests/contract/blocker-freshness.test.ts` 对着 `docs/blockers.md` 断言过，再在这一页钉一份
就是同一个数写两遍——两处各自正确却指向不同日期时，两条断言都会绿。这一页只负责把那个数
**搬到答辩稿上**，并写清它是哪一天量的；过期由「重跑那条命令」解决，不由一条新门禁解决。

同一个 `describe` 还核对**每一步的降级路径**：第 6 步那条 `--walkthrough` 退出 1 时没有第二条
路可走，所以它后面必须跟着 `--check`，而且必须写在 `--walkthrough` **之后**——写在前面就成了
「先查再列」，读者照着敲会先看到 `[stale]` 再看到十行路径，顺序反了。这条断言在
`CHECKLIST_FALLBACKS` 里，删掉那句降级说明会打红并指名第 6 步。
