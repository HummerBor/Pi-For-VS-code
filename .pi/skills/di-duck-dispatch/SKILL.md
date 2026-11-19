---
name: di-duck-dispatch
description: di-duck 工单派单/验收/收单工作机制（总监流水线）。当在 di-duck 仓要派 subagent 施工、跑独立验收测试、派返修、收单记账、或处理派单事故（断线/content_filter/余额不足/环境坑）时使用。
---

# di-duck 派单工作机制（总监流水线）

> 来源：2026-10 会话实测沉淀（工单 6-16 十余轮跑出来的教训）。
> 只收长青约定；一次性记录进 DIRECTOR.md/BUILDER.md，不进本文件。

## 1. 流程骨架（三段式，串行单写者）

1. **施工**：派 `builder` subagent → 完工写 `reports/REPORT-t<N>.md` + commit
2. **独立验收测试**：另派 subagent **只测不修** → `reports/TEST-t<N>.md`（问题分 P0-P3）——
   不信 REPORT 自评，独立探针不复用施工方用例；测试轮的价值在抓「声称不实」
   （实测两次抓到 P0/P2 级漏报）
3. **返修**（如需）：只修指定项 → 一行级返修走**免复测轮**（总监直验代替复测：
   compile + 全套回归 + grep 守卫在位 + 改动面与声称一致）
4. **收单**：总监记账（§5 清单）

派单任务书**五段自包含**：背景 / 范围 / 边界（不许顺手做）/ 验证 / 交接。

**任务书写在 `task` 参数里，不落文件**（2026-11-19 用户拍板改口径）：
`task` 才是施工方真正收到的指令，再写一份 `dispatch-t<N>.md` 是同一份内容的第二份拷贝——
文本翻倍、多 2-3 次工具调用，并且已经造过一次真实事故：收单删文件时另一个 agent 正在读它
（t34：“对方提交顺带删了 dispatch-t34.md，已读完任务书”），读慢一点就被饿死。

**只有两种情况才落文件**，位置 `.pi/dispatch/`（gitignored，与 `.pi/reports/` 同性质，
**不进仓、不 commit、不落根目录**）：① 重派/换模型，要把同一份 spec 再喂一次（402 那次靠它没重写）；
② 施工方会跑很久，它自己压缩后 `task` 参数会被摘要稀释，文件是可重读的外部锚点。

**产物落盘约定**：REPORT/TEST 写**项目内** `.pi/reports/`（已 gitignore）；收单时只把
「决策 / 坑 / 遗留债」1-5 行写进 `交接-*.md` 或 DIRECTOR 注记，**归档后即抛**（删文件）。
不许写 C 盘 / %TEMP%，也不许入库（2026-11-19 用户拍板）。
派单令（如落过）在 `.pi/dispatch/`，**不进仓不落根目录**（见 §1）。

## 2. subagent 参数与事故处置

- 参数：`agent=builder, agentScope=project, confirmProjectAgents=false, async=true`，
  cwd=项目根。builder 协议在 `.pi/agents/builder.md`（model 用户指定，现 xiaomi flash）
- **断线静默消失**（在册表清空、零产出）：`git status` 核残留 → 零残留**原样重派**
  （任务书加断线备注）；有半成品则任务书列半成品清单走续作模式。长任务断线多发，
  再断就把任务书拆两段派，切小风险面
- **content_filter 偶发**：原样重派即可（重派即过）；再撞换 pro
- **402 余额不足**：换模型/等充值
- 长跑侦察失速（40 分钟还在读码不开写）：`subagent_steer` 递话冻结侦察、
  小步落盘每步 compile、存疑处保守自裁记 REPORT

## 3. 验证纪律（铁律）

- 验证门=`npm run compile` 全绿（typecheck+vite+tsc 三段）+ 全套
  `node scripts/test-*.mjs` 回归（基线数对上、零回退）
- **虚报教训**：任何「已做」必须带核对凭据（git log / grep / 探针输出）；
  测试段专门核 REPORT 声称与实现是否一致，失实按 P 级记
- 冒烟前 **unset ELECTRON_RUN_AS_NODE**（环境污染让 electron 变纯 node，app undefined）
- 涉及拖拽/点击/窗口/托盘/通知的验收=真机手动，脚本冒烟不算
- 待用户真机清单：不催用户，存根进工单尾部/reports/TEST §四，每项「操作路径→预期」，
  列入前先核 UI 路径可达（路径不可达的不配叫验收项）

## 4. 契约与边界

- protocol.ts **只增不改**（新消息追加文末）；核心层/webview 改动必须显著标记
- 边界逐条自查进 REPORT；发现超界退回或折价记录
- 产品级歧义：施工方选最保守方案+显著标记；总监裁决回写工单原文
- 总监改契约注记**先自行 commit 再派单**（别搭施工 commit 的车）

## 5. 收单记账清单

1. DIRECTOR.md 工单标题加【收单】注记（施工/测试/返修 commit 哈希+判定要点+遗留/债务）
2. design/11 排期总表状态列同步（防双处漂移，改动回写储备库）
3. 待用户真机清单存根（reports/TEST §四），债务记入注记
4. 本地 commit（信息写「为什么」）；**push 等用户明确指令**
5. **清自己的临时产物**：`.pi/dispatch/t<N>.md`（如果落过）按需删——
   **不删别人正在读的文件**：收单前先确认对应 agent 已终态（t34 实测过赛跑）。

## 6. Windows 环境坑（实测）

- bash 内联写正则/转义会被吃：写文件方式（heredoc）绕开；`/PID` 等参数被 MSYS
  当路径转换：用 cmd 绕过
- NTFS mtime 粒度：连续写盘 mtime 相同概率 ~88%，依赖 mtime 差异的断言必须
  注入时钟差（≥25ms 跨 tick）
- CRLF：git 的 LF→CRLF warning 属常态，不算失败
