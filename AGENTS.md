# AGENTS.md

pi coding agent 的 VS Code 图形界面（RPC 模式）。给在本仓库工作的 AI agent / 新人的操作手册。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run compile` | 完整构建（webview 类型检查 → vite → tsc），提交前必跑 |
| `npm run package` | 本地打 vsix 手动装（不动 git、不升版本） |
| `npm run ship` | 正式发版一条龙：bump 版本 → 构建 → commit → push → publish 到市场 |

调试：F5（任务 `watch all`，tsc + vite 双 watch 并行）。

## 结构

```
src/            宿主侧（panel.ts 面板逻辑 / piClient.ts pi RPC / i18n.ts / webview-html.ts 装配）
webview/        webview 前端源码：main.ts(交互) style.css(样式) index.html(模板)
dist/webview/   vite 构建产物（不进 git，进 vsix）
out/            tsc 产物（不进 git，进 vsix）
```

## 不可破坏的约定

- **零运行时依赖**：`dependencies` 必须保持为空，工具链只进 devDependencies。
- **vsix 瘦身**：media 只带 `pi-icon.png`/`pi-logo.svg`；README 截图引用 `raw.githubusercontent.com` 仓库 URL——改截图必须 `git push` 才在市场生效。
- **webview/main.ts 是历史代码忠实还原**：ES5 var 风格 + `@ts-nocheck`，已与旧版逐字符校验等价。改它保持风格；注意 `@ts-nocheck` 意味着类型门禁对 main.ts 只查语法不查类型，摘帽清错已立项（工单一），摘掉前别把"compile 全绿"误读为"main.ts 类型安全"。
- **模板纪律**：index.html 只放结构 + 占位符（`{{key}}` 运行时变量 / `{{t:key}}` i18n）。CSS/JS 主体绝不写进模板，样式注入在 src/webview-html.ts 的 `headAssets`。
- **CSP**：nonce 由 getHtml 随机生成，script 标签与 CSP 头必须配对；JS 注入须过 `</script` 转义（已在 js 变量处做）。
- **steering 自愈别删**：prompt 被 pi 以 "already processing" 拒收时自动转 steer 重发（panel.ts case "prompt"），这是 busy 标志竞态的兜底，不是临时代码。
- **4 秒 pendingPrompt 兜底别删**：/llama 等命令式应答不触发 agent_start，没有它面板 busy 永久卡死。
- **注释文化**：记录事故教训的注释（为什么这么写、踩过什么坑）必须随逻辑走，丢注释比丢代码严重。
- **会话持久化格式**（`--- 代码上下文: ---`、`--- 附件: ---` 分隔标记）是磁盘格式，不参与 i18n。

## 文档分工

- DIRECTOR.md（gitignore，不入库）：总监维护的施工工单与验收记录，pi 只读执行；冲突时当前工单以它为准
- 用户发 `2`/`222` = 按 DIRECTOR.md 当前工单施工；执行前 pi 仍需独立判断工单必要性/准确性，发现工单有误先报告再动工

## 已知债务（按性价比排序，别顺手大改；工单化细项见 DIRECTOR.md）

1. `protocol.ts` 判别联合：宿主↔webview 约 30 种消息全走 any，建型后丢字段类 bug 变编译错误。
2. toolDetail 双实现漂移：宿主 `toolDetail` 与 webview `historyDetail` 逻辑不一致，流式/历史重绘摘要可能不同。
3. 同步 IO 在 extension host：listSessions 递归遍历、dbg() appendFileSync 无轮转。
4. 18 个可变状态字段 + 状态机收敛（做之前先读 panel.ts 里各标志上的事故注释）。
5. piClient 加固：send() 无响应超时（pi 卡死时 pending 永久悬挂）、stdin.write 无 error 监听（EPIPE 未处理异常）、piVersion() 可挂起。
