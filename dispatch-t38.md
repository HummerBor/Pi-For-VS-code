# dispatch-t38 — 小债两笔：`scheduleStream` 死代码 + 大纲注释口径

> 派单日 2026-11-19。工单全文见 `DIRECTOR.md`「工单38」。收单即删本文件。

## 一、背景

1. `webview/features/liveStream.ts:171` 的 `scheduleStream` 是**存量死代码**：随拆分 5b 搬进本文件时
   原样留下，文件内注释（第 235 行附近）已自认「只有定义，`appendDelta` 直接调 …」。存量债，本轮清掉。
2. `webview/features/outline.ts:50` 注释写「当前条判定口径：视口上 **1/3 线**以上最近一条」，
   而代码（第 120 行）用的是 `root.scrollTop + root.offsetTop + root.clientHeight / 2`——**中线**。
   注释与实现不一致，后来人会照着注释去改代码。

## 二、范围（只有这两个文件）

- `webview/features/liveStream.ts`：删 `scheduleStream` 定义 + 导出列表里的引用；
  **保留**解释它为什么是死代码的注释（教训要随逻辑走，改写成过去式一行即可）
- `webview/features/outline.ts`：把第 50 行注释改成与代码一致（**只改注释，不改任何一行行为**）

## 三、边界（违反即退单）

- **不改行为**：大纲滚动判定阈值、中线/1-3 线的选择**一律不动**（要改行为得产品拍板，不是本单）
- **不碰这些文件**（正在被别人未提交的改动持有）：`webview/features/composer.ts`、
  `webview/features/messageList.ts`、`webview/features/sessionView.ts`、`webview/style.css`、
  `webview/index.html`、`src/core/piCore.ts`、`src/core/i18n.ts`、`src/core/protocol.ts`、`package.json`
- **不跑 `npm run compile`**（另一个施工单在编译，并发抢 `dist/`）。验证用 `npm run typecheck:webview`
- 不许 `git add -A`；`git commit -m "..." -- <你的两个文件>`；提交后 `git show --stat HEAD` 必须只有这两个文件
- 不许 `git push`

## 四、验证

1. `grep -rn "scheduleStream" webview/` —— 只剩历史注释（无定义、无调用、无导出）。
   注意 `sessionView.ts:140` 有一行注释提到它，**那个文件不许动**，留着即可
2. `npm run typecheck:webview` 零报错（webview 侧 `strict:false` 也要零）
3. `git show --stat HEAD` 只有 `liveStream.ts` + `outline.ts`
4. 回报里贴改后的 `grep` 输出与前后的行数

## 五、交接

- 回报写 `.pi/reports/REPORT-t38.md`（不进 git）
- 若发现 `scheduleStream` 其实还有调用点（grep 出来），**停下不动代码**，把证据写进回报问总监
