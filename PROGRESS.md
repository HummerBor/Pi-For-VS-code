# PROGRESS.md — 交接卡

> 只记「新会话怎么接上」，不记动作流水（那些在 `git log`）。
> 每次接任先读这篇，再读 `AGENTS.md` 的「铁律」与「工作方法」两节。

## 在做

真机验收 webview 拆分。用户已装 `0.1.51`（= `archive/pi-for-vscode-0.1.50-split-done.vsix` 同一构建，md5 已核）。
已跑完冒烟四步？**未知——用户说"一直在测"，具体测到哪一域未回报。**

## 待办（按优先级）

1. **真机验收 9 个域**：清单在 `docs/history/交接-webview拆分完成.md` §七（输入区/流式/工具行/重绘/大纲/渲染队列/页签/状态行/视图工厂），每域都有对应的 `git revert <commit>`
2. **`applyState` 只认 `⏱` 前缀**：`roundFrozen` 是纯时长 → state 帧会清掉刚冻结的用时。既有 bug，未立票，未修。
3. **记忆机制方案**（讨论完未落地）：压缩只压「上下文视图」，jsonl 永远保留全文（`_persist` 是 appendFileSync，压缩只多一条 `compaction` 记录）。结论：会话内不需要额外记录，从 jsonl 提取「user 意图时间线（≈1.1k token）+ 最后结论（≈0.5k）」比摘要更保真。**原型脚本 `scripts/probe/session-digest.mjs` 未写。**
4. **`scripts/migrate/slim-subagent-frames.mjs` 修好前禁止 `--apply`**：会洗掉会话历史（实测 566→21 条）。修复方向见 `docs/history/` 拆分交接 §五 第 8 条。返修单未派。
5. **6b 页面级 chrome** 未搬（≈230 行，可选；不做 `main.ts` 368 行也可维护）
6. 小债：`scheduleStream` 死代码（存量，未删）、大纲注释口径（写 1/3 线，代码是 `clientHeight/2`）

## 风险

- **12 个拆分单全部只验到「compile + 16 组回归 + 逐字核对 + headless 探针」，真机 0 单验过。** 任何一单都可能真机行为不对，按 §七 表逐域 revert。
- harness 运行副本已是 **v27**（只升不降）：回退插件版本不会自动降级，需手动改名 `<agentDir>/extensions/subagent`。
- 记忆/文档机制今天刚改（AGENTS 191→121 行、`docs/` 分层、PROGRESS 滚动窗口），**规则本身只有 1 天寿命，没经过实战检验**。

## 关键位置

| 东西 | 位置 |
|---|---|
| 回滚锚点 | tag `baseline-before-split` = `9530019` |
| 安装包（4 份） | `archive/`（as-shipped / split-baseline / after-knife5 / split-done） |
| 拆分总账 | `docs/history/交接-webview拆分完成.md`（12 刀 commit 表 + 模块表 + 决策理由） |
| 架构与事故档案 | `docs/decisions.md`（15 节） |
| 回滚步骤 | 本篇「关键位置」+ `docs/history/交接-webview拆分完成.md` §四 |
| 本会话 jsonl | `~/.pi/agent/sessions/--D--work-docs-pi test-pi-vscode--/2026-11-18T08-29-53-267Z_01a1edc6.jsonl` |

## 上次交接时没定的事

- 全局 `~/.pi/agent/AGENTS.md` 是否加「边干边记」：已商量不改（避免每个项目多一个文件）
- `DIRECTOR.md` 只读属性已去掉，未设回
- 报告/台账制度已砍：只留 `PROGRESS.md`（本文件）+ `git log` + `归档.md`（战役一段）
