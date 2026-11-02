# 交接 · 子 agent 三件修复 + 面板 boot 杀手（2026-11-02）

> 自包含：新会话读完本文即可开工，不需要回看旧会话。仓库 = pi-vscode（d:/work/docs/pi test/pi-vscode）。

## 一、现状（已验证，勿再动）

- 源码树 = commit `00afe29` 状态（用户真机验证面板正常），HEAD=`d9e447f`，compile 全绿。
- 好态 = `4b54980`（抄 CC UI）+ `a2acf22`（另开页签/台账收口）之上的干净树。
- harness（`~/.pi/agent/extensions/subagent`，源码归属仓内 `harness/subagent/`）已修好并生效：
  删 --no-session、落盘、台账（runsLedger.ts）、帧文件（frames.jsonl）、内置 worker。
  harness 侧不受本交接的回滚影响。

## 二、待办：三件修复（原 commit `9cf636f`，整体回滚在 `00afe29`）

用 `git show 9cf636f` 取 diff，三件拆开逐个重上（**一件一提交，pathspec 提交，禁 git add -u**）：

1. **frames 重放**（B 治本：重启后子 agent 列表还在）：piCore.replaySubagentHistory
   读 `<agentDir>/sessions/subagents/<handle>/frames.jsonl`（harness 已在写）。
2. **句柄收口**：replay 的 toolResult 分支从 `m.toolName === "subagent"` 的内容抓 `sa-\d+`
   进 subagentHandles（不依赖 entry 帧）。
3. **会话列表剔除子会话**（A：调子 agent 后列表被刷）：sessionCache 过滤 `sessions/subagents/` 路径。

## 三、事故根因线索（三件里有一件杀面板 boot，未定位）

- 症状：重载后**webview→宿主方向单向断**——`webviewReady`/`prompt` 在 pi-chat-debug.log
  零留痕，宿主→webview 的 uiState/render 照常（转录渲染正常、能打字，但发送无声消失）。
- 同构建两个窗口只活一个（另一个窗口面板正常 boot）；换回好态构建即恢复。
- 日志：`~/.pi/agent/pi-chat-debug.log`——判据 = 重载后 `in webviewReady` 条数（每面板 1 条）。
- 疑点排序（未证实）：③ sessionCache（激活路径，跨窗口差异嫌疑）> ① frames 重放块
  > ② 句柄正则（`\bsa-\d+\b` 对大 content 的 match）。疑点：好态里 webview 源码与 9cf636f
  完全相同，纯扩展侧代码杀 webview→host 通道的机制没想通——可从「webview state 恢复带
  旧 tabId → 消息被路由丢弃」方向查（vpost 给所有消息盖 `m.tabId = id`）。

## 四、怎么继续（三选一）

- A（推荐）：三件逐个重上，每件后用户重载 + 发一条消息 + 看日志 webviewReady —— 最多 3 轮钉死。
- C：离线破案（按第三节疑点顺序查 tabId 路由），定准了装一件带修丁的。

## 五、纪律（本会话血泪，勿再犯）

- 脏树禁 `git add -u`（曾把坏代码卷回并重新编译，砸了用户面板两次）——一律 pathspec 提交。
- 二分期**不动用户正在用的构建**：每步先报用户、点头才 compile；验证 = 用户重载试发 + 看日志。
- webview/面板改动必过主链路冒烟才交（AGENTS.md 铁律）。
- 调试日志抓取可用（pi-chat-debug.log），但别拿日志分析代替用户真机复验。
