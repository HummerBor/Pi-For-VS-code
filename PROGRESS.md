# PROGRESS.md — 交接卡

> 只回答「新会话怎么接上」，不记动作流水（那些在 `git log`）。
> 接任顺序：本篇 → `AGENTS.md`（铁律 + 工作方法）→ 按待办找对应文档。

## 在做

**无在施工工单**：记忆接力一期 + 数据安全 + 归档瘦身七单已收（2026-11-19，账在 `归档.md`）。
**本次发版**：0.1.48 已发市场（commit `6645640`）——会话行右键换自绘菜单「复制 jsonl 路径」。
**工作区干净**：此前 668 行 WIP 已由并行会话落地（`custom` 渲染见 `bb66b35`）。

## 待办（按优先级）

1. **`applyState` 只认 `⏱` 前缀**：state 帧会清掉刚冻结的用时（既有 bug，非拆分引入），未立票。
2. **记忆二期未开**：接管摘要（`session_before_compact` 返回 `{compaction}`）需另立单；开口前先调预算（样本已到 3993/4000）。
3. **真机验收 9 个域**：清单在 `docs/history/交接-webview拆分完成.md` §七，每域对应一个 `git revert <commit>`。
4. **6b 页面级 chrome** 未搬（≈230 行，可选；不做 `main.ts` 368 行也可维护）。
5. 小债：`DIRECTOR.md` 只读属性已去掉、未设回；全局 `~/.pi/agent/AGENTS.md` 不加「边干边记」（已商量）。

## 风险

- **12 个拆分单真机 0 单验过**（只到 compile + 回归 + 逐字核对 + headless 探针），行为不对按 §七 表逐域 revert。
- **harness 运行副本版本只升不降**：回退插件版本不会自动降级，需把 `<agentDir>/extensions/subagent`（及 `memory`）改名或删掉才会重同步。
- **近期定的文档/流程规则未经实战检验**（AGENTS 瘦身、docs 分层、PROGRESS 滚动窗口），不好用直接改，不要因为「文档写了」就硬守。

## 关键位置

| 东西 | 位置 |
|---|---|
| 回滚锚点 | tag `baseline-before-split` = `9530019`（单刀 `git revert <commit>`） |
| 安装包 | **不存**，`npm run package` 现打（任意 commit 都能重建） |
| 拆分总账 | `docs/history/交接-webview拆分完成.md`（12 刀 commit 表 + 待验清单） |
| 架构与事故 | `docs/decisions.md`（17 节，§十七 = 压缩机制） |
| 记忆机制 | `harness/memory/{index.ts,digest.ts}` + `harness/memory/harness.json` v1 |
| 工单索引 | `归档.md`（只存结论 + commit） |
| 交接会话 jsonl | `~/.pi/agent/sessions/--D--work-docs-pi test-pi-vscode--/2026-11-18T08-29-53-267Z_01a1edc6-d4f3-75ed-8bf3-21e0eb1ca403.jsonl` |
