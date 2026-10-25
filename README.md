# UCAD

**Run several coding agents on one workspace — and be able to prove what each of them actually received.**

[English](#english) · [中文](#中文)

![The context panel: the exact bytes injected into the last turn, with a content hash](docs/screenshots/context.png)

---

## English

When you run more than one coding agent, two questions stay open:

- **What context did the agent actually get?** The prompt you wrote, the files
  that were summarised, the rules that were prepended — after three hops through
  a broker, a budget ledger and a token estimator, the answer is usually "roughly
  that".
- **Why did it take that route?** Which engine decided, on what signal, with how
  much confidence, and did anything fall back?

UCAD is a control plane for that. It does not try to be an editor, a terminal
agent, or a model provider. It makes the two answers checkable.

### What it does

- **Verifiable injection.** The context pack is produced by a pure function and
  carries a content hash. You can read the rendered text and compare the hash —
  change one byte and it stops matching.
- **Explainable routing.** Every decision records its rationale, its confidence
  and the engine that produced it. A fallback is recorded as a fallback.
- **Honest estimates.** Token counts say whether they came from the vendor's
  tokenizer or from a heuristic, and say so on screen.
- **A permission gate that cannot be bypassed.** An agent asking to run
  something gets a decision recorded, with the reason, before it happens.
- **Handoffs between agents.** A readable record of what was decided, changed,
  run and left open — the next agent reads it instead of re-asking you.
- **Project rules that follow the project.** A repository's own instructions
  live in `<project>/.ucad/skills/<name>/SKILL.md`. They are injected as
  ordinary context items, so you can read them in the Context Drawer, and they
  change with the project you have open — not with the one you opened first.
- **Any OpenAI-compatible provider.** One protocol, many vendors; credentials
  are stored one-way in the OS keychain and never leave the main process.
- **MCP servers.** Configure a server, see its health honestly, remove it.
- **Bilingual.** The interface is Chinese and English, switchable at runtime.

### Screenshots

| | |
|---|---|
| ![Chat](docs/screenshots/chat.png) | ![Decision](docs/screenshots/decision.png) |
| The conversation surface, with the session list and workspace tree. | The decision plane: engines, what they may decide, and the audit trail. |
| ![Handoff](docs/screenshots/handoff.png) | |
| The handoff chain: every record with its claim state, newest first — the entry a next agent resumes from. | |

### Installers

Windows installers are published on the
[Releases page](https://github.com/castorhrio/jev-pi-agent/releases): each
release carries the NSIS setup (`UCAD-Setup-<version>.exe`) plus an
`update-feed.json` the app's update check can read. The installer is unsigned,
so Windows SmartScreen warns on first run.

The app checks for updates on its own — the feed URL ships inside the
installed build. `UCAD_UPDATE_FEED` overrides it for a private or
self-hosted feed.

The feed is generated from the installer, so the digest in it is the digest
of the file that was uploaded:

```bash
node scripts/make-update-feed.mjs --version 1.1.0 \
  --installer release/UCAD-Setup-1.1.0.exe \
  --out release/update-feed.json
```

Upload the result as `update-feed.json` on the release. It must carry a
`sha256`: the app hashes the downloaded installer and refuses to launch one
that does not match. A feed without a hash can announce a version, but
nothing is installed from it — the update button says why.

### Quick start

Requires Node.js 22.12 or newer (the Electron 44 packaging toolchain and the
test suite both declare it as their floor).

```bash
git clone https://github.com/castorhrio/jev-pi-agent.git
cd jev-pi-agent
npm install
npm run dev
```

`npm run dev` builds everything and launches the desktop app. No API key is
needed until you actually call a model.

To work on the interface without Electron or credentials:

```bash
npm run dev:web
```

This serves the renderer in a browser against an in-memory fixture.
Append `?scenario=empty`, `?scenario=loading`, `?scenario=error`,
`?scenario=partial` or `?scenario=permission` to see the other states.

### Building an installer

```bash
npm run dist     # Windows NSIS installer
npm run package  # unpacked build, no installer
```

**On Windows the installer step needs symlink privilege.** `electron-builder`
extracts a cache archive that contains symbolic links, so Developer Mode must be
on, or the command must run elevated. The unpacked build is unaffected.

### Current limitations

Stated plainly, because a tool that hides its edges is harder to trust than one
that does not.

- **One provider protocol ships.** The bundled adapter speaks the
  OpenAI-compatible protocol. Native vendor adapters are not implemented.
- **The installer is unsigned.** Windows SmartScreen warns on first run. The
  download is still checked: the feed publishes a SHA-256, and the app
  refuses to launch an installer whose digest does not match.
- **Auto-update needs a feed URL.** Releases publish one, and the released
  build carries it — nothing to configure. To point at another feed, set
  `UCAD_UPDATE_FEED=https://github.com/castorhrio/jev-pi-agent/releases/latest/download/update-feed.json`
  and the update check (Settings → 检查更新) reads it instead. With no feed
  the app says so rather than failing quietly.
- **The interactive terminal needs `node-pty`.** It is an optional dependency;
  without it the terminal panel reports that it is unavailable instead of
  pretending to work. The command channel still runs.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — how to run the gates, what the
repository expects of a change, and how to add a workspace package.

### License

[MIT](LICENSE)

---

## 中文

同时跑多个编码 Agent 时，有两个问题始终没有答案：

- **Agent 到底拿到了什么上下文？** 你写的提示词、被摘要的文件、被前置的规则——
  经过 broker、预算账本、token 估算器三层之后，答案通常只是"大概那些"。
- **它为什么走了这条路由？** 哪个引擎、依据什么信号、置信度多少、有没有发生回落？

UCAD 就是为这两个问题做的控制面。它不试图当编辑器、当终端 Agent、当模型厂商，
它让这两个答案**可核对**。

### 它能做什么

- **注入可验证。** Context Pack 由纯函数产出并带内容哈希，
  你可以读渲染后的原文、比对哈希——改动一个字节就对不上了。
- **决策可解释。** 每次决策都记录 `rationale`、`confidence` 和产出它的引擎；
  回落会**作为回落被记录**。
- **估算说实话。** token 数会标明来自厂商 tokenizer 还是启发式估算，并在界面上写明。
- **绕不过的权限门。** Agent 要执行操作前，先得到一个被记录的决定和它的理由。
- **Agent 之间的交接。** 一份可读的记录：决定了什么、改了什么、跑过什么、还剩什么——
  下一个 Agent 读它，而不是再问你一遍。
- **随项目走的项目规则。** 仓库自己的规矩放在 `<project>/.ucad/skills/<name>/SKILL.md`，
  它们作为普通上下文项注入——在上下文面板里可以逐字核对；换个项目打开，规则也跟着换，
  而不是留在第一次打开的那个项目上。
- **任意 OpenAI 兼容厂商。** 一个协议覆盖多家；凭据单向存进系统钥匙串，
  永不离开主进程。
- **MCP 服务器。** 添加、看健康状态、移除。
- **中英双语。** 界面中英可切换。

### 截图

| | |
|---|---|
| ![对话](docs/screenshots/chat.png) | ![决策](docs/screenshots/decision.png) |
| 对话界面，左侧会话列表与工作区文件树。 | 决策平面：可用引擎、各自的决策类型、审计记录。 |
| ![交接](docs/screenshots/handoff.png) | |
| 交接链：每一份记录及其认领状态，最新在前——下一个 Agent 从那一条继续。 | |

### 安装包

Windows 安装包发布在
[Releases 页](https://github.com/castorhrio/jev-pi-agent/releases)：每个 release
带 NSIS 安装包（`UCAD-Setup-<版本>.exe`）与一份 `update-feed.json`，供应用的
更新检查读取。安装包未签名，Windows SmartScreen 首次运行会提示。

应用会自己检查更新——feed 地址随安装包一起发布，不需要用户配置。
`UCAD_UPDATE_FEED` 可以覆盖它，指向私有或自建的 feed。

feed 由安装包生成，里面的摘要就是上传的那个文件的摘要：

```bash
node scripts/make-update-feed.mjs --version 1.1.0 \
  --installer release/UCAD-Setup-1.1.0.exe \
  --out release/update-feed.json
```

把生成的文件作为 `update-feed.json` 上传到该 release。它必须带 `sha256`：
应用会对下载到的安装包做哈希校验，对不上的绝不启动。没有哈希的 feed 仍能
播报新版本，但不会从中安装任何东西——更新按钮会说明原因。

### 快速开始

需要 Node.js 22.12 或更高版本（Electron 44 打包工具链与测试套件都以它为下限）。

```bash
git clone https://github.com/castorhrio/jev-pi-agent.git
cd jev-pi-agent
npm install
npm run dev
```

`npm run dev` 会构建全部产物并启动桌面应用。**不配任何 API key 也能跑起来**，
直到你真的去调用模型。

只做界面开发、不需要 Electron 和凭据：

```bash
npm run dev:web
```

在浏览器里跑渲染层，数据来自内存 fixture。
追加 `?scenario=empty`、`?scenario=loading`、`?scenario=error`、
`?scenario=partial` 或 `?scenario=permission` 可以看其他状态。

### 构建安装包

```bash
npm run dist     # Windows NSIS 安装包
npm run package  # 免安装目录，不出安装包
```

**Windows 上出安装包需要符号链接权限。** `electron-builder` 要解包一个内含符号链接的
缓存包，因此需要开启开发者模式或以管理员身份运行；免安装目录不受影响。

### 当前局限

直说，因为**藏边界的工具比不藏的更不值得信任**。

- **只随包发布一种厂商协议。** 内置适配器走 OpenAI 兼容协议，厂商原生适配器未实现。
- **安装包未签名。** Windows 首次运行会有 SmartScreen 提示。下载本身仍然过校验：
  feed 里带 SHA-256，摘要对不上的安装包不会被启动。
- **自动更新需要一个 feed 地址。** Releases 发布了一份，发布版也把它带在身上——
  不需要配置。要指向别处，把 `UCAD_UPDATE_FEED` 设为
  `https://github.com/castorhrio/jev-pi-agent/releases/latest/download/update-feed.json`，
  更新检查（设置 → 检查更新）即会改读它；没有配置时应用会直说，而不是静默失败。
- **交互式终端依赖 `node-pty`。** 它是可选依赖；缺失时终端面板会如实说不可用，
  而不是假装能跑。命令通道仍然可用。

### 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) —— 怎么跑门禁、这个仓库对一次改动有什么要求、
以及怎么新增一个 workspace 包。

### 许可

[MIT](LICENSE)
