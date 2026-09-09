# AGENTS.md — pi 的职责手册

pi coding agent 的 VS Code 图形界面（进程内直连 pi SDK）。本文件只写 pi 在本仓库的职责与不可破坏的约定；
工作进度、工单状态、技术债一律记 BUILDER.md（交接时读那份）。

## 我的职责

- 按用户指令施工；用户发 `2`/`222` = 按 DIRECTOR.md 当前工单开发
- 执行前独立判断工单必要性/准确性，发现工单有误先报告再动工，不做盲执行器
- 每张工单独立提交，提交信息写清「改了什么、为什么」；禁止搬运与修 bug 混在一笔
- 改完必须 `npm run compile` 全绿才算完；涉及 webview 行为的改动要构建 vsix 实测
- 工单完成后更新 BUILDER.md（回报 + 验收对账 + 请示），等用户发 `1` 给总监 review
- git 只做本地 commit；push / 发布（`npm run ship`）必须等用户明确发话
- **同一工作区 git 单写方（总监裁决 9）**：并行会话共用工作区时，同一时刻只允许一个
  施工方动 git，另一侧只读或先 status/diff 确认归属；提交前 `git diff` 逐 hunk
  确认归属，只把属于自己的 hunk 进暂存区（工单五实测两次互扫事故沉淀）
- 维护本手册：发现新的不可破坏约定时增补，失效条目删除，保持一屏内读完
- 总监 review 后若更新 DIRECTOR.md，按新工单继续；长期不变量从工单沉淀回本手册

## 不可破坏的约定

- **零运行时依赖**：`dependencies` 必须保持为空，工具链只进 devDependencies（含
  @earendil-works/pi-coding-agent——仅为类型参考，**不进 vsix**，运行时加载用户已装的 pi 包）。
- **进程内直连架构（2026-09-09 用户拍板）**：piClient 不再 spawn `pi --mode rpc`，改为经
  src/piSdk.ts 定位并 import 用户已装的 pi 包（前置条件不变：机器上必须有 pi）。RPC 版整树
  保留在分支 `rpc-subprocess`。改 piClient 前先读其头注释的「RPC 语义保留对照」——
  preflight 验收即回、拒收报错文案与 steer 自愈正则的匹配是跨模块契约，别动。
- **核心/宿主分层（工单四，已接线）**：piCore.ts（核心控制器，禁 import vscode，宿主能力经
  hostCapabilities.ts 接口注入）+ panel.ts（VS Code adapter：实现 HostCapabilities/UiActions，组装 PiCore）。
  改核心逻辑（状态机/prompt 组装/事件路由）去 piCore.ts，VS Code UI 流程留 panel.ts；
  webview 消息路由入口是 core.onWebviewMessage。对账基线：55e977b 的 panel.ts（e04a1dd 已同步漂移）
- **vsix 瘦身**：media 只带 `pi-icon.png`/`pi-logo.svg`；README 截图引用 `raw.githubusercontent.com`
  仓库 URL——改截图必须 push 后才在市场生效。
- **webview/main.ts 的类型门禁**：strict:false 下 tsc 零报错（@ts-nocheck 已摘）。改它保持 ES5 var
  风格，别引入 let/const 大重写；真类型问题用最小断言解决。
- **模板纪律**：index.html 只放结构 + 占位符（`{{key}}` 运行时变量 / `{{t:key}}` i18n）。CSS/JS 主体
  绝不写进模板，样式注入在 src/webview-html.ts 的 `headAssets`。
- **CSP**：nonce 由 getHtml 随机生成，script 标签与 CSP 头必须配对；JS 注入须过 `</script` 转义。
- **steering 自愈别删**：prompt 被 pi 以 "already processing" 拒收时自动转 steer 重发
  （panel.ts case "prompt"），这是 busy 标志竞态的兜底，不是临时代码。
- **4 秒 pendingPrompt 兜底别删**：/llama 等命令式应答不触发 agent_start，没有它面板 busy 永久卡死。
- **注释文化**：记录事故教训的注释（为什么这么写、踩过什么坑）必须随逻辑走，丢注释比丢代码严重。
- **会话持久化格式**（`--- 代码上下文: ---`、`--- 附件: ---` 分隔标记）是磁盘格式，不参与 i18n。
- **协议同步**：新增/修改跨边界消息时三处同步——发送方、接收方、protocol.ts。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run compile` | 完整构建（webview 类型检查 → vite → tsc），提交前必跑 |
| `npm run package` | 本地打 vsix 手动装（不动 git、不升版本） |
| `npm run ship` | 正式发版一条龙：bump 版本 → 构建 → commit → push → publish 到市场 |

调试：F5（任务 `watch all`，tsc + vite 双 watch 并行）。

## 结构

```
src/            宿主侧（panel.ts VS Code adapter / piCore.ts 核心控制器 / hostCapabilities.ts 宿主能力接口 /
                piClient.ts pi 适配器 / piSdk.ts pi 包加载器 /
                protocol.ts 消息协议 /
                toolDetail.ts 共享摘要 / i18n.ts / webview-html.ts 装配）
webview/        webview 前端源码：main.ts(交互) style.css(样式) index.html(模板)
dist/webview/   vite 构建产物（不进 git，进 vsix）
out/            tsc 产物（不进 git，进 vsix）
```
