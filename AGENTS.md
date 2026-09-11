# AGENTS.md — 插件通用文档（pi-coding-agent 的 VS Code 图形界面）

pi coding agent 的 VS Code 图形界面（进程内直连 pi SDK）。本文件是插件本身的通用文档：
只写这个插件是什么、怎么构建、有哪些不可破坏的约定——供任何会话参考。
本文件不进 vsix（.vscodeignore 已排除）。

## 角色与协作（新会话接任入口）

> **角色由用户赋予**：新会话先由用户说清担任什么角色再上岗——没有被点名就不是任何角色。

- 被点名**总监** → 读 [总监.md](总监.md) 接任（验收/裁决/签工单，不写业务代码）；用户发 `1`/`111` = 触发验收循环
- 被点名**施工方** → 读 [施工方.md](施工方.md) 接任（按工单施工）；用户发 `2`/`222` = 按 [DIRECTOR.md](DIRECTOR.md) 当前工单开发
- 工单与验收历史：[DIRECTOR.md](DIRECTOR.md)（待施工）/ [归档.md](归档.md)（已完结存档）；施工回报写在 [BUILDER.md](BUILDER.md)

## 不可破坏的约定

- **零运行时依赖**：`dependencies` 必须保持为空，工具链只进 devDependencies（含
  @earendil-works/pi-coding-agent——仅为类型参考，**不进 vsix**，运行时加载用户已装的 pi 包）。
- **进程内直连架构**：piClient 不再 spawn `pi --mode rpc`，改为经
  src/piSdk.ts 定位并 import 用户已装的 pi 包（前置条件不变：机器上必须有 pi）。RPC 版整树
  保留在分支 `rpc-subprocess`。改 piClient 前先读其头注释的「RPC 语义保留对照」——
  preflight 验收即回、拒收报错文案与 steer 自愈正则的匹配是跨模块契约，别动。
- **核心/宿主分层**：piCore.ts（核心控制器，禁 import vscode，宿主能力经
  hostCapabilities.ts 接口注入）+ panel.ts（VS Code adapter：实现 HostCapabilities/UiActions，组装 PiCore）。
  改核心逻辑（状态机/prompt 组装/事件路由）去 piCore.ts，VS Code UI 流程留 panel.ts；
  webview 消息路由入口是 core.onWebviewMessage。
- **vsix 瘦身**：media 只带 `pi-icon.png`/`pi-logo.svg`；README 截图引用 `raw.githubusercontent.com`
  仓库 URL——改截图必须 push 后才在市场生效。
- **webview/main.ts 的类型门禁**：strict:false 下 tsc 零报错（无 @ts-nocheck）。改它保持 ES5 var
  风格，别引入 let/const 大重写；真类型问题用最小断言解决。
- **模板纪律**：index.html 只放结构 + 占位符（`{{key}}` 运行时变量 / `{{t:key}}` i18n）。CSS/JS 主体
  绝不写进模板，样式注入在 src/webview-html.ts 的 `headAssets`。
- **CSP**：nonce 由 getHtml 随机生成，script 标签与 CSP 头必须配对；JS 注入须过 `</script` 转义。
- **还原边界**：还原只对「pi 工具命中」的文件提供；git-only 只展示；
  write 碰过的未跟踪文件一律不可还原；patch 逆向任一行不符即拒打不落盘
  （patchRevert.ts）——破坏性操作红线，别「优化」掉任何一道守卫。
- **steering 自愈别删**：prompt 被 pi 以 "already processing" 拒收时自动转 steer 重发
  （piCore.ts 的 prompt 分支），这是 busy 标志竞态的兜底，不是临时代码。
- **4 秒 pendingPrompt 兜底别删**：/llama 等命令式应答不触发 agent_start，没有它面板 busy 永久卡死
  （piCore.ts 的 4s 兑底）。
- **注释文化**：记录事故教训的注释（为什么这么写、踩过什么坑）必须随逻辑走，丢注释比丢代码严重。
- **会话持久化格式**（`--- 代码上下文: ---`、`--- 附件: ---` 分隔标记）是磁盘格式，不参与 i18n。
- **协议同步**：新增/修改跨边界消息时三处同步——发送方、接收方、protocol.ts。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run compile` | 完整构建（webview 类型检查 → vite → tsc），提交前必跑 |
| `npm run package` | 本地打 vsix 手动装（不动 git、不升版本） |
| `npm run test:detail` | 跑 toolDetail 用例（scripts/toolDetail.test.mts，零依赖） |
| `npm run test:revert` | 跑 patchRevert 逆向还原用例（scripts/patchRevert.test.mts） |
| `npm run ship` | 正式发版一条龙：bump 版本 → 构建 → commit → push → publish 到市场 |

调试：F5（任务 `watch all`，tsc + vite 双 watch 并行）。

## 结构

```
src/            宿主侧（extension.ts 入口 / panel.ts VS Code adapter / piCore.ts 核心控制器 /
                hostCapabilities.ts 宿主能力接口 / piClient.ts pi 适配器 / piSdk.ts pi 包加载器 /
                protocol.ts 消息协议 / patchRevert.ts edit patch 逆向还原 /
                toolDetail.ts 共享摘要 / i18n.ts / webview-html.ts 装配）
webview/        webview 前端源码：main.ts(交互) style.css(样式) index.html(模板)
dist/webview/   vite 构建产物（不进 git，进 vsix）
out/            tsc 产物（不进 git，进 vsix）
```