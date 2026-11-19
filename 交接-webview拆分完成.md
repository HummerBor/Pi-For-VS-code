# 交接：webview/main.ts 拆分完成（2026-11-19）

> 自包含。接手只需读本篇 + `AGENTS.md` + `ROLLBACK.md`。
> 起点：`webview/main.ts` 3269 行 / 单 IIFE / 148 个函数。
> 终点：**368 行**（引导 + 装配 + 页面级 chrome），14 个 `features/` 模块 + `core/state.ts`。

## 一、总账

| 阶段 | commit | main.ts |
|---|---|---|
| 起点（拆分前） | `b706911` | 3269 |
| 第 3 刀 子 agent 浮窗 | `724cc1a` | 2654 → 2229 |
| 第 4 刀 输入区 → `composer.ts` | `bcf9ded` | 2229 → 1934 |
| 5a 渲染基座 → `markdown.ts` / `linkify.ts` | `921e922` | 1934 → 1806 |
| 5b live 流式 → `liveStream.ts` | `35ba761` | 1806 → 1659 |
| 5c 工具行 → `toolRows.ts` | `e8804ed` | 1659 → 1534 |
| 5d+5e 整树重绘 + 粘性气泡 → `messageList.ts` / `sticky.ts` | `2e0e07f` | 1534 → 1244 |
| 5g 大纲轨道 → `outline.ts` | `9283f3f` | 1244 → 1164 |
| 5f 渲染队列 → `renderQueue.ts` | `13a5304` | 1164 → 1136 |
| 6a 页签与路由 → `tabs.ts` | `7d8703c` | 1136 → 1027 |
| 6c-1 状态行/页脚 → `statusBar.ts` | `dd2467d` | 1027 → 844 |
| 6c-2 视图工厂 + handleMsg → `sessionView.ts` | `5a4a456` | 844 → **368** |

同期非拆分提交：
- `986e464` 回滚指南 + 基线包 + ROLLBACK 不进 vsix
- `ae66924` 子 agent 送帧真值收敛（删 `frames.jsonl` 双写 + 失联判定改 pid）
- `4997328` / `fd268ce` 收单补齐（日期更正、liveness 入回归套件、删 5s 轮询）
- `89946be` 浮窗终态行显示完成时刻，秒表只在有活行时跑
- `f5d38d3` / `569f070` / `4a3e6ff` / `7d79fd0` AGENTS.md 规则累积

## 二、模块表

```
webview/main.ts              368  引导 + 各模块装配 + 页面级 chrome（TIPS/emoji/凭证页/头部绑定）
webview/core/state.ts         57  getActiveTabId 等最小共享状态
webview/features/
  sessionView.ts             624  视图工厂 + handleMsg 整条分派链 + per-view 模块装配
  subagentDock.ts            554  子 agent 浮窗（单表、失败原因行、秒表只在活行跑）
  ctxPopover.ts              514  上下文用量弹层
  composer.ts                433  输入区（附件/联想/发送/键位）
  messageList.ts             348  整树重绘 renderAll / addUser / notice / 压缩块
  statusBar.ts               338  状态行 / 页脚 / 横幅 / applyState / fmtSession
  liveStream.ts              244  流式增量（appendDelta/appendThink/finalizeLive）
  tabs.ts                    229  页签 + 路由（views 表 + window.message 判序契约）
  changesPage.ts             232  变更页
  toolRows.ts                197  工具行（×N 成组 / 乱序并组 / OUT 展开）
  outline.ts                 156  右缘消息大纲
  sticky.ts                  136  粘性气泡
  renderQueue.ts             114  渲染队列（快照先画、事件后补）
  markdown.ts                106  渲染基座（inline/plain/table/rich）
  linkify.ts                 112  文件路径/符号可点（FILE_RE 互斥分支）
```

## 三、拆分纪律（这轮验证有效，后续照做）

1. **一刀一提交一报告**，报告放 `reports/REPORT-t<N>.md`，内含本刀 commit 哈希 + `git revert` 命令。
2. **逐字核对**：搬走的函数与 `git show HEAD~1:webview/main.ts` 归一化后必须零差异；允许差异逐条列理由。
3. **验证门**：`npm run compile` 三段全绿 + 全套回归同数（16 组，含 `test:revert`）+ headless 探针（有 DOM 的刀）。
4. **状态唯一持有者**：同一份状态不许两边各存（`linkifyEnabled` / `stickyQ` / `renderTimer` / `views` / `pdet` 全部验证过唯一）。
5. **事故先例写进注释**：`bindComposerOnce` 命脉、`try/finally` 顺序、`window.message` 判序、`linkifyEnabled` 时序、`pdet` 跨域，都在新模块头注释里留了"为什么"。

## 四、回滚

见 `ROLLBACK.md`。三道保险：
- tag `baseline-before-split` = `9530019`
- `archive/pi-for-vscode-0.1.50-as-shipped.vsix`（拆分前装机版）
- `archive/pi-for-vscode-0.1.50-split-done.vsix`（拆分完成版）
- 中间态 `archive/pi-for-vscode-0.1.50-split-baseline.vsix`（第 3 刀后）、
  `archive/pi-for-vscode-0.1.50-after-knife5.vsix`（第 5 刀收尾）

单刀回退：`git revert <该刀 commit>`。

## 五、遗留债（交接时未做，按优先级）

1. **6b 未做**：页面级 chrome（`ico`/`el`/`esc`/欢迎页/凭证页/头部绑定/剪贴板兜底，≈230 行）仍在
   `main.ts`。要做才能到 ≈250 行；不做不影响功能，`main.ts` 368 行是可维护的。
2. **`applyState` 只认 `⏱` 前缀**：`roundFrozen` 是纯时长文本 → state 帧会清掉刚冻结的用时。
   既有口径问题（非拆分引入），属产品行为，需单独立票。
3. **`R15` 不可达分支**：`handleMsg` 里 `tabs` 分支被 `window.message` 层提前截获，原样保留（存量死代码）。
4. **`scheduleStream` 死代码**：随 5b 搬进 `liveStream.ts` 并加了注释，未删（存量）。
5. **deps 注释指代漂移**：部分 `features/*.ts` 的 deps 注释写「住 main.ts」，实际已搬走（6c-2 报告 §六有行号清单）。
6. **`sessionView.ts` 搬入块里两条到期注释**：按零差异原则未改。
7. **大纲判定口径与注释不符**：注释写「视口上 1/3 线」，代码用 `clientHeight / 2` 中线（5g 报告记录）。
8. **`scripts/migrate/slim-subagent-frames.mjs` 现在不能上真数据（红线）**：它只删行、不重接
   `parentId`。299MB 样本实测：体积 299.92 → 20.69MB（-93.1%），但用 pi 自带 `SessionManager`
   加载后**上下文 566 → 21 条、thinkingLevel high → off、从 leaf 只 24/619 可达**——等于把会话历史洗掉。
   修复方向已验证可行：被删节点的 `parentId` 上溯压缩（只改 92 行、体积不变、566 条完全复原）+
   temp/fsync/rename 原子替换 + `.bak` 存在即拒跑 + `--apply` 后自检回滚 + `frames.jsonl` 终态守卫 +
   流分支改 `JSON.parse` 判类型。**修完之前禁止对 `~/.pi/agent/sessions/**` 跑 `--apply`**。

## 六、证据去哪了

各单的过程证据（REPORT-t34~t46、TEST-t32、SCOUT-t34-* 共 17 份，316KB）**已删**，没归档、
没入 git（2026-11-19 用户拍板：仓库不收、C 盘也不堆）。长期结论已在本篇 §一/§二/§五，
更早的记录用 `git log` / `git show <commit>` 查（13 份 REPORT 曾在 git 历史里，能取回）。

> 删报告前唯一抽出来保住的东西：
> **`scripts/migrate/slim-subagent-frames.mjs` 现在不能上真数据**（详见 §五 第 8 条）。

## 七、真机验收状态（未验，装机后第一件事）

本轮所有交付只验到「compile + 回归 + 逐字核对 + headless 探针」，**真机行为一项都没验过**。
装机包：`archive/pi-for-vscode-0.1.50-split-done.vsix`。

按域清单（坏在哪个域就 revert 对应 commit，见 §一 表）：

| 域 | 操作 | 对应回退 |
|---|---|---|
| 输入区 | 打字/Enter/Shift+Enter/↑↓历史/`/` 菜单/`@` 文件/粘贴图/拖文件/chip ×/全角转半角/Esc | `bcf9ded` |
| 流式 | 正文不闪、`**bold` 半截不抖、表格不劈叉、代码围栏、思考折叠、切页签续上 | `35ba761` |
| 工具行 | `×N` 成组、乱序完成并组、点开展开全量 OUT、失败红态 | `e8804ed` |
| 重绘 | 切历史整页正确、压缩块 details、错误气泡、toast 不叠挂、气泡不抖 | `2e0e07f` |
| 大纲 | 锚点数、hover 错峰、点击跳转摘类、resize 重算 | `9283f3f` |
| 渲染队列 | 大会话切历史不卡、流式切页签不丢字 | `13a5304` |
| 页签/路由 | 多页签不串台、后台子 agent 帧回来仍在、Esc 先关浮层 | `7d8703c` |
| 状态行/页脚 | 占比/花费实时、busy 秒表、压缩标签、4s 兜底 | `dd2467d` |
| 视图工厂 | 发消息/中止/重试/换模型/压缩/子 agent 全链路 | `5a4a456` |
| 浮窗时间 | 完成行显示固定时刻（不是「12 分钟前」） | `89946be` |
