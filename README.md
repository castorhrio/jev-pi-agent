# UCAD

**Unified Coding Agent Desktop** — a local-first desktop workbench for running multiple coding agents against one workspace, with a verifiable context-injection layer and an explainable decision trail.

**统一编码代理桌面** —— 本地优先的多 Agent 编码工作台：多个编码 Agent 在同一个工作区上运行，上下文注入可核对、决策链路可解释。

[English](#english) · [中文](#中文)

---

## English

### What it is

UCAD is a control plane, not an editor and not an agent framework. It owns three things
that other tools leave implicit:

- **Verifiable injection.** The exact bytes an agent receives are produced by a pure
  function and carry a content hash. What the agent got can be checked, reproduced and
  audited — `@ucad/context` renders it, `@ucad/bench` measures it.
- **Explainable routing.** Every routing decision produces a rationale, a confidence and
  the id of the engine that made it, and a fallback is recorded as a fallback
  (`@ucad/decision`).
- **Honest capability reporting.** A probe that fails says it failed, an integration that
  is not wired says it is not wired. Silent degradation is treated as a defect.

### Requirements

| | |
|---|---|
| Node.js | `>= 20.11.0` |
| Platform | Windows / macOS / Linux (Electron 33) |
| Credentials | none to build or test; a provider key only to call a real model |

### Quick start

```bash
npm install
npm run dev        # build everything, then launch Electron
```

To work on the interface without Electron or real credentials:

```bash
npm run dev:web    # opens in a browser against an in-memory fixture
```

`?scenario=` selects a fixture state: `default`, `empty`, `loading`, `error`, `partial`,
`permission`.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Build all artifacts and launch Electron |
| `npm run dev:web` | Renderer only, in a browser, no Electron required |
| `npm run typecheck` | Typecheck packages, main process and renderer |
| `npm run lint` | ESLint |
| `npm run knip` | Unused files, exports and dependencies |
| `npm test` | Unit, contract and integration tests (builds packages first) |
| `npm run test:e2e` | Interface E2E: the real app in a DOM |
| `npm run build` | Build every artifact |
| `npm run package` | Unpackaged build, for a local smoke test |
| `npm run dist` | Windows NSIS installer |

`npm test` runs `build:packages` first on purpose. The unit suite resolves `@ucad/*`
through the workspace symlinks, so it runs against `packages/*/dist` rather than `src`;
without the rebuild, a green run can mean the old code passed.

### Layout

```
apps/desktop/      Electron shell: main process, typed preload, React renderer
packages/          20 workspace packages, each with a single responsibility
tests/contract/    Contract, integration and gate tests
tests/e2e/         Interface tests driving the real App
scripts/           Layout probe and page scripts
```

### Quality gates

The suite is the definition of done, and each gate is expected to be able to fail.
Coverage includes contract conformance, adapter loading, the injected-bytes hash, the
handoff chain, the permission loop, the compatibility and version pinning of shipped
agents, the secret vault (writes that cannot be reported must not be reported as saved),
layout geometry measured in a real Chromium window at seven widths, accessibility scans
over every surface, colour contrast, focus indicators, hard-coded UI copy, menu commands
reaching a renderer handler, and the build graph matching the dependency manifests.

`tests/contract/layout.test.ts` measures the real thing rather than a DOM approximation:
it drives a Chromium window, walks every surface at several widths and asserts that
nothing overflows, collapses, overlaps or falls outside its scroll container.

### Honest limitations

- **The installer is unsigned.** Windows SmartScreen will warn on first run.
- **Auto-update is inert until a feed is configured.** The app says so rather than failing
  quietly; set `UCAD_UPDATE_FEED` to an `https://` URL to enable it.
- **One provider protocol ships.** `@ucad/adapter-universal` speaks the OpenAI-compatible
  protocol; native vendor adapters are not implemented.
- **`node-pty` is optional.** Without it the terminal panel reports that it is unavailable
  instead of pretending to work.
- **Building the Windows installer needs symlink privilege.** `electron-builder` extracts
  a cache archive containing symbolic links, so Developer Mode must be on, or the command
  must run elevated. The unpacked build is unaffected.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `npm run typecheck && npm run
lint && npm run knip && npm test && npm run test:e2e` must be green before a change is
considered done.

### License

[MIT](LICENSE) — see the `LICENSE` file.

---

## 中文

### 它是什么

UCAD 是**控制面**，不是编辑器，也不是 Agent 框架。它把三件别处默认隐式的事情变成显式的：

- **注入可验证。** Agent 实际收到的字节由纯函数产出，并带内容哈希——
  「Agent 到底拿到了什么」可以被核对、复现和审计
  （`packages/context` 负责渲染，`packages/bench` 负责度量）。
- **决策可解释。** 每次路由产出 `rationale`、`confidence` 与产出它的引擎 id，
  回落会**作为回落被记录**（`packages/decision`）。
- **能力探测不谎报。** 探测失败就说失败，没接线就说没接线。
  **静默降级在本项目里算缺陷，不算简化。**

### 环境要求

| | |
|---|---|
| Node.js | `>= 20.11.0` |
| 平台 | Windows / macOS / Linux（Electron 33） |
| 凭据 | 构建与测试都不需要；只有真正调用模型时才需要厂商密钥 |

### 快速开始

```bash
npm install
npm run dev        # 构建全部产物并启动 Electron
```

只做界面开发、不需要 Electron 与真实凭据：

```bash
npm run dev:web    # 在浏览器里打开，走内存 fixture
```

`?scenario=` 选择 fixture 状态：`default`、`empty`、`loading`、`error`、`partial`、
`permission`。

### 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 构建全部产物并启动 Electron |
| `npm run dev:web` | 只跑 renderer，浏览器打开，不需要 Electron |
| `npm run typecheck` | 类型检查（packages + 主进程 + 渲染层） |
| `npm run lint` | ESLint |
| `npm run knip` | 未引用的文件、导出与依赖 |
| `npm test` | 单元 / 契约 / 集成测试（会先构建 packages） |
| `npm run test:e2e` | 界面 E2E：在 DOM 里跑真实 App |
| `npm run build` | 构建全部产物 |
| `npm run package` | 免安装目录，用于本地冒烟 |
| `npm run dist` | Windows NSIS 安装包 |

`npm test` 会先跑 `build:packages`，这是**故意的**：单测通过 workspace 符号链接解析
`@ucad/*`，跑的是 `packages/*/dist` 而不是 `src`——不重编译的话，一次「绿」可能只是
旧代码通过了。

### 目录结构

```
apps/desktop/      Electron 外壳：主进程、类型化 preload、React 渲染层
packages/          20 个 workspace 包，各自单一职责
tests/contract/    契约、集成与门禁测试
tests/e2e/         驱动真实 App 的界面测试
scripts/           布局探针与页面脚本
```

### 质量门禁

测试套件就是完成的定义，而且**每道门禁都应当能变红**。覆盖范围包括契约一致性、适配器加载、
注入字节哈希、交接链、权限循环、已发布 Agent 的兼容性与版本锁定、凭据保险库
（写不下去的写入不得报告为已保存）、在真实 Chromium 窗口里按七档宽度测量的布局几何、
全表面无障碍扫描、颜色对比度、焦点指示器、界面硬编码文案、菜单命令是否有渲染层处理，
以及构建图与依赖清单是否一致。

`tests/contract/layout.test.ts` 测的是真东西而不是 DOM 近似：它驱动一个 Chromium 窗口，
逐个走完每个表面，断言没有溢出、塌陷、重叠或跑出可滚动容器。

### 如实说明的局限

- **安装包未签名**，Windows 首次运行会有 SmartScreen 提示。
- **自动更新在配置更新源之前是空的。** 应用会直说而不是静默失败；
  把 `UCAD_UPDATE_FEED` 指向一个 `https://` 地址即可启用。
- **只随包发布一种厂商协议。** `packages/adapter-universal` 走 OpenAI 兼容协议；
  厂商原生适配器未实现。
- **`node-pty` 是可选依赖。** 缺失时终端面板会如实说不可用，而不是假装能跑。
- **构建 Windows 安装包需要符号链接权限。** `electron-builder` 要解包一个内含符号链接的
  缓存包，因此需要开启 Windows 开发者模式或以管理员身份运行；免安装目录不受影响。

### 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。简单说：改动被认为完成之前，
`npm run typecheck && npm run lint && npm run knip && npm test && npm run test:e2e`
必须全绿。

### 许可

[MIT](LICENSE) —— 见根目录的 `LICENSE` 文件。
