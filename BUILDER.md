# BUILDER.md — 工作记录与交接（pi 维护，总监/后任必读）

> AGENTS.md 只写职责；本文件是**活动工作记录**：当前进度、待实测尾巴、待决请示。
> 已完结工单的施工回报、历史决策与教训已随验收归档到 [归档.md](归档.md)「九、施工回报存档」——
> 交接需复盘历史时去归档.md，本文件只留未完结项。不提交进 git（与 DIRECTOR.md 同）。

最后更新：2026-09-11 归档精简（已完结回报迁 归档.md 第九节，本文件只留活动项）

## 〇、工单十一施工回报（路径锚定工作区根，待用户实测）

**实现（单点 + 一处 slice，均在 panel.ts，piCore 零改动）**：

1. **归因入口锚定**（handleRunSettled）：工具命中 `f.path` 先 `path.isAbsolute` 检查，非绝对则
   `path.join(root, f.path)` 锚定工作区根，归一化后入 changesDetail/changesFiles——下游
   diff/还原全链路收直（`openPrerunDiff`/`openHeadDiff`/`revertFile` 拿到的都是绝对路径）
2. **症状二同根因一并修**：旧代码 `relOf(f.path)` 对相对路径做 `path.relative(root, 相对路径)`
   按 ext host cwd 解析得垃圾值（实测：cwd=dist 时 `path.relative(root,'package.json')` 得
   `dist\package.json`，`startsWith('..')` 拦不住）→ nowStatus 查不到 → inHead 误判 false →
   错进 prerun 通道。锚定后 rel=`package.json` 查得到，tracked 文件正常走 HEAD ↔ 工作区
3. **headContent slice 疑点修复**：实证结论——`URI.parse` 的 query 是**编码形态**（只拆分
   不解码，%3A 原样保留），`openPrerunDiff` 用 `encodeURIComponent` 拼的 query 恒为编码串，
   旧代码 `slice(7)` 把 `prerun%3A...` 切出半编码残片 `3Ad%3A...`，decode 后带前导垃圾 →
   changesDetail 查不到 → 左侧白屏；裸冒号分支实际永远走不到。改为统一
   `decodeURIComponent(uri.query)` 后再 `startsWith("prerun:")`，按 `"prerun:".length` 截，
   分歧结论已写进代码注释，两种分支之谜了结

**实证记录**（node 模拟，非门禁脚本）：锚定前 cwd≠root 时 relOf 得 `dist\package.json` 垃圾值；
锚定后 rel=正确相对路径；slice 新旧两法 decode 对比 3A 垃圾/干净。compile 全绿（EXIT=0）

**边界遵守**：piCore 归因结构/事件回调零改动（锚定全在 adapter）；git 兑底路径本就是
join(root, r) 已绝对，没动；裁决 11 还原边界没动；协议三处无新增消息

**等待实测**：需真 vsix 环境验证——让 pi 用相对路径 edit 一个未跟踪/忽略文件，变更条 diff
能打开且左侧「改动前」内容非空；还原内容回退（工单验收原文，实测尾巴见 DIRECTOR.md 未结事项）

## 一、待实测尾巴（合并清单，全部实测通过才可全结）

- **工单六**：①长对话触发自动压缩看横幅 ②阈值预警（contextWarnPercent 调低如 5 验证）+ 一键压缩
  ③横幅手动关闭 + webview 重建后不重发
- **工单七**：pi 改多文件 → diff 列表 → 单文件还原 → 内容确实回滚（建议场景：2-3 文件正常编辑
  看出条/清单/diff；还原 tracked 文件；未跟踪新文件 edit 后还原；非 git 目录降级提示）
- **工单十一**：让 pi 用**相对路径** edit 一个未跟踪/忽略文件 → 变更条 diff 能打开且左侧
  「改动前」内容非空 → 还原该文件内容回退（顺带复验工单七变更条含 gitignore 场景）
- **附件路径模式**：用户实测拖拽附件路径（pi 能读到文件 + 5 个/200KB 限制语义确认）

## 二、技术债（未排期，按性价比排序；演化见 归档.md「八、后续排队」）

1. panel.ts 状态机收敛：18 个可变标志 + 4s pendingPrompt timer hack（做之前先读各标志上的事故注释）
2. applyHtml 同步读大图转 base64（listSessions 链已由工单十三/后续异步化）
3. .vscodeignore 核查收录完整性（0.0.81 事故，test*.txt 清理随 0.0.87 攒包）

## 三、待总监回复的请示（当前无待决，全部裁决完毕；历史存档见 归档.md 9.9）

## 四、给总监的提醒

- 下一版 **0.0.87** 发版即 ship 闸门全流程终验（hunk→commit→push→publish + PI_CONFIRM_SHIP=1 快车道）
- 最新验证包：pi-for-vscode-0.0.87.vsix（根目录）；若需手测先跑 `npm run package` 重新打包