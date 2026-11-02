# DoD 现状对照（2026-11-03）

`docs/PRODUCT-DOD.md` 是锁定稿，不改它；这里逐条写**现在到哪一步、证据在哪、还差什么**。
勾选只代表「有可复现的证据」，不代表「已过线」——过线由审查侧判定。

| DoD 条目 | 现状 | 证据 | 还差什么 |
|---|---|---|---|
| 可证明注入 | **有证据** | Context Pack 纯函数 + 内容哈希；真机步骤 1 通过：`renderedHash=80e256b63523731c…`，同一轮重读同哈希，任务描述多一个字符变 `673b97ec35b5…`，注入原文与 `estimate="heuristic_chars_div_4"` 同屏（`docs/manual-verification.md` 2026-11-03 行） | Windows 桌面复跑一次 |
| 可解释路由 | **有证据** | 真机步骤 2 通过：7 行决策各带 rationale / confidence / 引擎，回落如实记录；`tests/contract/decision-chain.test.ts` 钉住链与实跑一致 | Windows 桌面复跑一次 |
| 权限门不可绕 | **有证据（自动化）** | 执行前允许/拒绝进事件流，审计可查；`tests/contract/permission-*.test.ts`、`tests/e2e/critical-path.e2e.test.tsx` | 真机步骤 6 的权限弹窗人工走查未做 |
| Windows 安装包航运 | **未验证** | `npm run dist` 产出 NSIS；feed 合约（`https` + `sha256`、明文/非 URL 被拒并打日志）由 `tests/contract/update-feed.test.ts` 与真机步骤 4 的拒绝路径覆盖 | **Windows 桌面**：装包、SmartScreen 说明、随包 feed 真实网络（本机到 `github.com` 不通） |
| 门禁即 DoD | **有证据** | `npm run typecheck && lint && knip && test && test:e2e` 全绿；注入/交接/凭据/更新合约测试能打红 | CI 等价跑一次留档 |
| 诚实估计与凭据 | **有证据** | 估算来源上屏（`heuristic_chars_div_4`）；凭据只进 OS 钥匙串，钥匙串不可用时启动即停并给平台补救话（`apps/desktop/src/main/keyring-gate.ts`，`tests/contract/keyring-gate.test.ts`） | Windows DPAPI 路径真机确认 |

## 本轮据此做的两件事

1. **真机主链路取证**：Linux 桌面会话（`dbus-run-session` + `gnome-keyring` + `xvfb-run`，
   声明 `XDG_CURRENT_DESKTOP=GNOME`）跑通步骤 1–4，记录进 `docs/manual-verification.md`。
2. **把「跑一次」变成命令**：`scripts/verify-main-chain.mjs` 修掉两处就绪竞态
   （窗口挂载 ≠ 应用可用；设置面板按钮晚一拍出现），并加 `--feed-url`，
   让「随包 feed 所在主机不可达」的机器也能跑真实网络分支，且记录用的是哪个 URL。

## 下一刀（按 DoD 未勾项）

- Windows 桌面补跑步骤 1–6（唯一硬缺口）。
- 步骤 6 的五个界面状态人工走查（`npm run dev:web`）。
