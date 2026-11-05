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

**它退出 1 时**：屏幕上是 `[unrecorded] …` 或 `no walkthrough images: …`，说的是**图与
`docs/screenshots/sources.json` 不同步**，不是图坏了。先跑下面这条，让它说清是哪一张：

```bash
node scripts/screenshot-sources.mjs --check
```

它逐张报 `[stale] …` 或一行 `PASS — …`。`[stale]` 的那几张是渲染层源码改过之后没重拍的：
**现场不要重拍**（重拍要跑布局门禁，时长不可控，见第 8 步），照念旧图，并说清「这几张是
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

## 8. 当天不要做

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

同一个 `describe` 还核对**每一步的降级路径**：第 6 步那条 `--walkthrough` 退出 1 时没有第二条
路可走，所以它后面必须跟着 `--check`，而且必须写在 `--walkthrough` **之后**——写在前面就成了
「先查再列」，读者照着敲会先看到 `[stale]` 再看到十行路径，顺序反了。这条断言在
`CHECKLIST_FALLBACKS` 里，删掉那句降级说明会打红并指名第 6 步。
