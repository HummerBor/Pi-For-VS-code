# pi Chat — VS Code 图形界面

用 pi 的 RPC 模式做后端、VS Code 侧边栏做前端的聊天插件。
pi 的模型配置、登录状态（`/login`）、扩展、skill 全部直接复用。

## 架构

```
侧边栏 Webview（聊天界面）
   ↕ postMessage
扩展进程 src/extension.ts + src/panel.ts
   ↕ stdin/stdout（JSON 行协议，见 pi 文档 docs/rpc.md）
pi --mode rpc 后台进程（真正的 agent）
```

## 首次运行（只需要两次终端操作）

1. 用 VS Code 打开本文件夹（`pi-vscode`）
2. `Ctrl + ~` 打开终端，输入：
   ```
   npm install
   ```
3. 按 **F5**（或菜单 运行 → 启动调试）
   - 会弹出一个新的 VS Code 窗口
   - 左侧活动栏出现聊天图标（或点右下角状态栏 `pi`）
   - 直接输入消息即可对话

以后每次开发：打开文件夹 → F5，不需要再用终端。
改了代码后，调试窗口里按 `Ctrl+Shift+F5`（重启调试）即可生效。

## 功能

| 功能 | 说明 |
|---|---|
| 侧边栏聊天 | 流式输出，Markdown 渲染（代码块/标题/列表/行内代码/粗体） |
| 思考过程 | thinking 块折叠显示，流式展开 |
| 工具调用 | 显示工具名和状态，鼠标悬停/下方预览输出（前 300 字符） |
| 插话 | agent 工作中继续发送 → 自动作为 steering 消息排队 |
| 停止 | ■ 按钮或输入框里按 Esc |
| 新会话 | 头部 "＋新会话" |
| 切模型 | 点头部模型名，QuickPick 列出所有已配置可用模型 |
| 思考等级 | 点头部 "思考: x"，QuickPick 切换 off/low/medium/high… |
| 用量统计 | 头部显示上下文占用 % 和费用（每轮结束刷新） |
| 扩展交互 | pi 扩展的 select/confirm/input 自动映射到 VS Code QuickPick/模态框/输入框 |
| 会话模式 | 设置 `piChat.sessionMode`：ephemeral（默认不保存）/ continue（继续上次）/ new（持久化） |

## 会话持久化

默认 `ephemeral` 不保存会话。想保存：VS Code 设置里搜 `piChat`，
把 `Session Mode` 改成 `continue`（每次继续最近会话）或 `new`（新建持久会话）。
改完需重启调试（Ctrl+Shift+F5）。

## 已知限制

- 多行编辑器类型的扩展交互（`editor`）降级为单行输入框
- pi 扩展的自定义 TUI 组件（`ctx.ui.custom`）在 RPC 模式下不可用（pi 协议限制）
- 工具输出完整内容在悬停提示里，面板只预览 300 字符
- `ephemeral` 模式下 pi 退出后聊天记录不保存（协议有 `get_entries`/会话树，可后续做 /resume 列表）

## 文件说明

| 文件 | 作用 |
|---|---|
| `src/extension.ts` | 插件入口，注册侧边栏视图和状态栏按钮 |
| `src/panel.ts` | 聊天面板（Webview HTML/JS/CSS + 事件桥接 + 原生对话框） |
| `src/piClient.ts` | pi RPC 客户端（进程管理 + JSON 协议 + 全部命令） |
| `media/pi.svg` | 活动栏图标 |

## 后续可扩展方向（RPC 协议都支持）

- `/resume` 会话列表（`SessionManager.list` 语义 → RPC `get_entries` + 会话文件）
- 文件 diff 展示（edit/write 工具的 `details.diff`）
- 跟随模型 token 计数实时刷新（`message_update.usage`）
- 图片粘贴发送（`prompt.images`）
