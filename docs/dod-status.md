# DoD 现状对照（2026-11-03）

`docs/PRODUCT-DOD.md` 是锁定稿，不改它；这里逐条写**现在到哪一步、证据在哪、还差什么**。
勾选只代表「有可复现的证据」，不代表「已过线」——过线由审查侧判定。

| DoD 条目 | 现状 | 证据 | 还差什么 |
|---|---|---|---|
| 可证明注入 | **有证据** | Context Pack 纯函数 + 内容哈希；真机步骤 1 通过：`renderedHash=80e256b63523731c…`，同一轮重读同哈希，任务描述多一个字符变 `673b97ec35b5…`，注入原文与 `estimate="heuristic_chars_div_4"` 同屏（`docs/manual-verification.md` 2026-11-03 行） | Windows 桌面复跑一次 |
| 可解释路由 | **有证据** | 真机步骤 2 通过：7 行决策各带 rationale / confidence / 引擎，回落如实记录；`tests/contract/decision-chain.test.ts` 钉住链与实跑一致 | Windows 桌面复跑一次 |
| 权限门不可绕 | **有证据（自动化）** | 执行前允许/拒绝进事件流，审计可查；`tests/contract/permission-*.test.ts`、`tests/e2e/critical-path.e2e.test.tsx` | 真机步骤 6 的权限弹窗人工走查未做 |
| Windows 安装包航运 · NSIS 产出与安装 | **未验证** | `npm run dist` 走 electron-builder 的 `nsis` 目标（`package.json` 的 `build.win`），产物 `UCAD-Setup-<版本>.exe`；未签名 | **Windows 桌面**：装一次、过 SmartScreen、把提示原文记进 `docs/manual-verification.md` |
| Windows 安装包航运 · 随包 feed 真实网络 | **未验证** | feed 合约（`https` + `sha256`）由 `tests/contract/update-feed.test.ts` 覆盖；Linux 桌面会话用 `--feed-url` 指向真实 https 文档跑通「已是最新版本」 | 随包 feed（`github.com/.../releases/latest/download/update-feed.json`）在能连 `github.com` 的机器上跑一次 |
| Windows 安装包航运 · 拒绝路径（明文 / 非 URL） | **有证据** | 真机步骤 4：明文覆盖 → `检查更新失败: 更新源必须使用 https…`，日志 `update feed ignored: …`；`tests/contract/update-feed.test.ts` | — |
| 门禁即 DoD | **有证据** | `npm run typecheck && lint && knip && test && test:e2e` 全绿；注入/交接/凭据/更新合约测试能打红 | CI 等价跑一次留档 |
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

## 下一刀（按 DoD 未勾项）

- **真机复跑 `--steps 5`**：判定与接线已有自动门禁，但「进程真的退出」这一条仍要一次
  `npm run package` + `dbus-run-session`/`gnome-keyring`/`xvfb-run` 的实跑记录落进
  `docs/manual-verification.md`。本轮 `electron-builder --dir` 在产物写完（`app.asar` 已含
  该修复，见上）之后卡住未退出，记录因此顺延到下一轮，没有写进表里。
- Windows 桌面补跑步骤 1–6（唯一硬缺口）。
- 步骤 6 的五个界面状态人工走查（`npm run dev:web`）。
