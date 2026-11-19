# dispatch-t36 — `slim-subagent-frames.mjs` 返修（数据红线）

> 派单日 2026-11-19。工单全文见 `DIRECTOR.md`「工单36」。收单即删本文件。

## 一、背景（已取证，不用重跑大样本）

现状：脚本只删 `subagent-async-stream` 这类帧，**不重接 `parentId`** → 被删节点的子节点失去祖先链。

299MB 样本实测（历史数据，信它就是，别再造 299MB）：

| 指标 | 改前 | `--apply` 后 | 结论 |
|---|---|---|---|
| 体积 | 299.92MB | 20.69MB（-93.1%） | 达标 |
| 上下文条数（pi `SessionManager` 加载） | 566 | **21** | 灾难 |
| thinkingLevel | high | **off** | 退化 |
| 从 leaf 可达节点 | 619 | **24** | 历史断裂 |

修法清单（`docs/history/交接-webview拆分完成.md` §五 第 8 条，已验证可行）：

1. **`parentId` 上溯压缩**：删节点时把子节点的 `parentId` 指向被删节点的最近存活祖先。只改引用、不改体积，实测 566 条完全复原。
2. **原子替换**：写 `temp` → `fsync` → `rename`，不许原地写。
3. **`.bak` 存在即拒跑**：拒绝重复 apply，退出码 ≠0。
4. **`--apply` 后自检**：用 `SessionManager` 重新加载，条数/可达性不达预期就自动回滚。
5. **`frames.jsonl` 终态守卫**：该删的帧删净，不该删的一条不动。
6. **流分支改 `JSON.parse` 判类型**：不许用 `include("subagent-async-stream")` 这种字符串匹配。

## 二、范围

- `scripts/migrate/slim-subagent-frames.mjs`
- `scripts/test/test-migration.mjs`（扩充断言；既有用例一条不许删）

## 三、边界（违反即退单）

- **严禁对真实会话目录跑 `--apply`**：`~/.pi/agent/sessions/**` 一下都不许写。要样本就 `cp` 到 `$TEMP` 下的临时目录再跑，跑完删。**这条是红线，违规即退单。**
- **不跑 `npm run compile`**：`.mjs` 不在构建链里，且另一个施工单正在编译，并发会抢 `dist/`。
- 不动 `src/`、`webview/`、`harness/`、`scripts/migrate/backfill-parent-session.mjs`、任何 `.md`。
- 工作区有**别人**未提交的 668 行改动（`webview/**`、`src/core/**`、`package.json`）——一律不碰。
- 不许 `git add -A`；提交用 `git commit -m "..." -- <你的文件>`，提交后 `git show --stat HEAD` 自检。
- 不许 `git push`。

## 四、验证

1. `node scripts/test/test-migration.mjs`（或 `npm run test:migration`）全绿，基线不降
2. 用一份**手工构造的小样本**（几百行足够，不必 299MB）跑完整 `--apply`：
   - 断言 `SessionManager` 加载后消息条数与改前**完全相等**
   - 断言体积显著下降
   - 断言 `.bak` 已生成、`.bak` 已存在时第二次拒跑（退出码 ≠0）
3. 断电模拟：apply 过程中 kill，断言原文件未被破坏（temp 残留不覆盖原文件）
4. 终态守卫：样本里混一条不该删的帧，断言它还在

## 五、交接

- 回报写 `.pi/reports/REPORT-t36.md`（不进 git）：逐条修法对照 + 实测输出 + 遗留债
- commit message 写「为什么」；不 push
- 若发现修法清单有第 7 条遗漏（例如还有别的字段依赖被删节点），**实现级自裁修掉并写进回报**，不要放着
