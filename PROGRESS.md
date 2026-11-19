# PROGRESS.md — 当前进度

> **规则**：每完成一个可验证步骤就追加一行（`时间 ✅ 做了什么 → 下一步`），不许攒到会话末尾。
> 只记状态，不记细节（细节进 commit / `docs/history/`）。新会话或压缩后先读最后 20 行。
> 超过 100 行时把旧段落截到 `docs/history/progress-<年月>.md`。

## 当前状态（2026-11-19 19:40）

**在做**：真机验收（用户装机中，包 = `archive/pi-for-vscode-0.1.50-split-done.vsix`，已装成 0.1.51，md5 一致）

**已完成**
- webview/main.ts 拆分收官：3269 → 368 行，12 刀（第 3 刀 → 6c-2），全部 compile + 16 组回归 + 逐字核对
- 子 agent 送帧收敛：删 `frames.jsonl` 双写、失联判定改 pid、删掉私加的 5s 轮询（`ae66924` / `fd268ce`）
- 浮窗时间：完成行显示固定时刻，秒表只在活行跑（`89946be`）
- 文档治理：`docs/decisions.md` 抽走架构细节、6 份交接移入 `docs/history/`、AGENTS.md 瘦身
- 回滚设施：tag `baseline-before-split` + `archive/` 四份 vsix + `ROLLBACK.md`

**待办（按优先级）**
1. 真机验收 9 个域（清单见 `docs/history/交接-webview拆分完成.md` §七）
2. `applyState` 只认 `⏱` 前缀 → 冻结用时被 state 帧清掉（既有 bug，需单独立票）
3. 6b 页面级 chrome 未搬（可选，≈230 行，不做也能维护）
4. `slim-subagent-frames.mjs` 修好前禁止 `--apply`（会洗掉会话历史）
5. `scheduleStream` 死代码、大纲注释口径不符（小债）

## 日志

- 2026-11-19 19:40 ✅ 文档治理：AGENTS.md 191→约 140 行、6 份交接进 docs/history/、新建 docs/decisions.md + PROGRESS.md → 下一步：更新 DIRECTOR.md（去掉只读）
- 2026-11-19 19:20 ✅ 归档.md 登记拆分战役（12 单 commit 表）+ 交接文档补「关键决策与理由」→ 下一步：会话留痕复核
- 2026-11-19 18:11 ✅ 拆分收官 6c-2：main.ts 844→368，16 组回归全绿，打 `split-done` 包 → 下一步：真机验收
- 2026-11-19 17:45 ✅ 第 5 刀收官：main.ts 1164→1136，打 `after-knife5` 包 → 下一步：第 6 刀
- 2026-11-19 17:10 ✅ T2 收单：删 frames.jsonl 双写 + pid 失联判定，删私加 5s 轮询 → 下一步：拆分第 4 刀
