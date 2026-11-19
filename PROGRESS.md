# PROGRESS.md — 交接卡

> 只回答「新会话怎么接上」，不记动作流水（那些在 `git log`）。
> 接任顺序：本篇 → `AGENTS.md`（铁律 + 工作方法）→ 按待办找对应文档。

## 在做

**真机验收 webview 拆分**：用户「一直在用没遇问题」→ 判定事实通过，不逐域勾选（revert 表留在交接 §七）。
**工单 34（记忆接力一期）派单失败**：builder 402 余额不足，代码零改动，单仍待施工（见 DIRECTOR）。

## 待办（按优先级）

1. **真机验收 9 个域**：清单在 `docs/history/交接-webview拆分完成.md` §七，每域对应一个 `git revert <commit>`。
2. **`applyState` 只认 `⏱` 前缀**：state 帧会清掉刚冻结的用时（既有 bug 非拆分引入），未立票。
3. **记忆机制 = 工单 34**（`harness/memory` 扩展）：一期指针注入 + digest 探针，二期才接管摘要。
4. **`slim-subagent-frames.mjs` 修好前禁 `--apply`**（洗会话历史：566→21 条），修法见 `docs/history/交接-webview拆分完成.md` §五 第 8 条。
5. **`归档.md` 待清**（3,323 行 / 74k token，仓库最后一个膨胀源）：每工单压成 3-5 行，目标 400-600 行。等用户拍板。
6. **6b 页面级 chrome** 未搬（≈230 行，可选；不做 `main.ts` 368 行也可维护）
7. 小债：`scheduleStream` 死代码（存量未删）、大纲注释口径（写 1/3 线，代码 `clientHeight/2`）

## 风险

- **12 个拆分单全部只验到「compile + 16 组回归 + 逐字核对 + headless 探针」，真机 0 单验过。**
  真机行为不对就按 §七 表逐域 revert。
- **harness 运行副本已是 v27（只升不降）**：回退插件版本不会自动降级，需把
  `<agentDir>/extensions/subagent` 改名或删掉，旧插件才会重新同步。
- **今天定的文档/流程规则只有 1 天寿命**（AGENTS 瘦身、docs 分层、PROGRESS 滚动窗口），
  未经实战检验；发现不好用直接改，不要因为"文档写了"就硬守。

## 关键位置

| 东西 | 位置 |
|---|---|
| 回滚锚点 | tag `baseline-before-split` = `9530019`（单刀 `git revert <commit>`） |
| 安装包 | **不存**，`npm run package` 现打（任意 commit 都能重建） |
| 拆分总账 | `docs/history/交接-webview拆分完成.md`（12 刀 commit 表 + 模块表 + 决策理由 + 待验清单） |
| 架构与事故 | `docs/decisions.md`（17 节：pi 内置 / 壳原则 / harness 版本门 / 还原边界 / 文档治理 / 压缩机制…） |
| 工单索引 | `归档.md`（只存结论 + commit，历史遗留较臃肿） |
| 交接会话 jsonl | `~/.pi/agent/sessions/--D--work-docs-pi test-pi-vscode--/2026-11-18T08-29-53-267Z_01a1edc6-d4f3-75ed-8bf3-21e0eb1ca403.jsonl` |

## 上次交接时没定的事

- `归档.md` 是否按新标准清一遍（见待办 5）—— 等用户拍板
- 全局 `~/.pi/agent/AGENTS.md` 不加「边干边记」：避免每个项目多一个文件（已商量）
- `DIRECTOR.md` 只读属性已去掉，未设回
