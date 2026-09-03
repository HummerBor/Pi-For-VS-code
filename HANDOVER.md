# pi-vscode 插件交接文档

> 给新会话的 pi：本项目是一个 VS Code 扩展，为 pi coding agent 提供 Claude Code 风格的聊天面板。
> 本文档是上一个会话的完整交接，读完后即可继续开发。最后更新：2026-09-03

## 项目概览

- 位置：`D:\work\docs\pi test\pi-vscode`
- 用户环境：Windows，pi 已全局安装（npm 方式），Z.ai GLM 5.3 Flash 模型
- 用户不熟悉命令行，所有 pi 能力都要求做成面板可视化操作

## 架构

```
src/extension.ts   - 扩展入口：注册 WebviewViewProvider + 状态栏按钮
src/panel.ts       - 核心（~1800行）：ChatPanelProvider，RPC 事件→UI，所有功能菜单
src/piClient.ts    - RPC 客户端：spawn pi --mode rpc，stdin/stdout JSONL（LF 分帧，勿用 readline）
src/panel.ts 底部  - getHtml()/css()/webviewJs()：webview UI（webviewJs 是字符串数组拼的 JS，改时注意转义！
                     每行必须独立包裹引号；TS 字符串里的 \n 会变成真实换行导致语法错误，要写 \\n）
```

构建：`npm run compile` → `vsce package` → 扩展面板「从 VSIX 安装」→ 重载窗口
调试：F5（已配 .vscode/launch.json + tasks.json）

## 功能清单（全部已实现）

- **会话**：⏱ 历史面板（搜索/删除/切换，项目级过滤 ~/.pi/agent/sessions）、＋新会话、
  agent_start 时同步真实会话记录（排队清空机制）；打开面板不弹任何选择框，静默预热；
  新会话自动补回记住的模型/思考等级（pi 的 new_session 会重置模型）
- **模型/思考**：工具条点击切换，globalState 跨重启记忆（piChat.lastModel/lastThinking）
- **权限模式**：pi 扩展 `~/.pi/agent/extensions/modes.ts` 提供 /mode 命令（manual/edit-auto/plan/auto 四档，
  持久化到 ~/.pi/agent/mode.json，tool_call 事件拦截）；状态栏徽标点击弹出选择（插件直接写 mode.json）
- **消息发送**：Enter 发送；agent 工作中 → steer 插队（虚线⏳排队气泡，agent_start 时清空并以
  getMessages 重绘转正）；agent_settled 时清残留排队并整页重绘
- **代码上下文**：监听编辑器选区（250ms 防抖），选中→附带选中行，无选区→整个文件（>80KB 跳过）；
  工具条胶囊可点击切换带/不带走；发送时拼 "--- 代码上下文: rel (range) ---" 代码块
- **图片**：粘贴/拖拽/＋菜单上传，base64 走 prompt.images，缩略图胶囊可删除（最多4张）
- **/ 菜单**：分组（上下文/会话/模型/配置/命令技能模板），内置项直接触发面板动作（builtin 字段）
- **@ 文件引用**：工作区文件索引（跳过 node_modules/out/隐藏目录，深度6，上限2000）
- **⚡ 命令菜单**：重命名会话/compact/清空排队/导出HTML/fork/clone/bash/get_commands
- **⚙ 设置菜单**：权限模式/插话送达/追问送达/自动压缩/自动重试/会话模式/sessionDir/打开pi配置目录
- **工具渲染**：CC 风格——状态圆点（绿✓/红✗/蓝圈呼吸=运行中）+ 粗体工具名 + 灰色参数摘要，
  点击展开 IN/OUT 块（tool-box）；工作中默认展开，结束/历史默认收起；
  renderAll 把连续同名工具合并为 `● name ×N ▸` 组（展开是每次调用的明细行）
- **流式渲染**：照搬 pi 的模型——维护 liveMsg.content 数组（按 contentIndex 写入），
  每次 delta 后整条消息重绘（renderLive），保证思考/文本按消息结构有序（勿改回按到达顺序拼块）。
  **严禁在 busy/流式中途做整页 renderAll**（会导致同一条回复被拆散、顺序割裂），重绘只发生在 settled。
  **必须处理 message_start**：每条助手消息（含 steer 后继续生成的下一条）都要轮换新气泡
  （post newLive，webview 置空 liveMsg/liveDiv）——插话后 contentIndex 从 0 重新计数，
  不轮换会把新消息增量拼进上一条旧气泡（思考被覆盖成文本、越写越大），工具行却在底部，
  造成 working 与 settled 两套布局错位。toolStart 消息也先切断当前气泡（文本落到工具行下方）
- **状态栏**：模式徽标 + 工作计时秒数 + 排队计数 + 上下文% + 费用
- **排队反馈**：工作中发消息→输入框上方 queuebar 单行 ⏳（紧凑不占位）；
  **steering 是插进当前运行，不会触发 agent_start**——转正信号靠 queue_update 队列变短
  （lastQueueTotal 计数差 → 最早的 ⏳ 逐条转正为普通气泡）；agent_settled 才整页重绘
  （syncRenderKeepQueued，未送达的排队项保留）+ 计数器归零；wasBusy 决定是否带 steer
  （注意：乐观 busy 置位后必须用捕获的 wasBusy 调 prompt，否则空闲消息被当插话变慢）
- **插话送达**：默认 one-at-a-time（CC 风格一条条处理，piChat.steeringMode 可配），启动时自动应用；
  ⚙ 菜单切换会持久化到配置
- **历史重绘**：会话记录里的用户消息可能带 `--- 代码上下文: rel (range) ---` 前缀，renderAll 会解析剥离、
  还原成「附带代码」胶囊；未知 pi 事件若携带 error/reason 字段会透传为面板 notice（避免报错无反馈）
- **启动**：面板首次可见即预热 pi 进程（PI_SKIP_VERSION_CHECK=1），消除首条消息延迟

## 已知问题/限制

- 旧会话文件里存的空文字消息（bug 时期产生的）重绘时显示「📄 (代码上下文)」占位，无法追溯修复，
  开新会话即可
- Z.ai GLM 首字延迟偶尔很长（服务端行为），计时器秒数已可视化；停止按钮测试正常
- webview JS 是字符串数组拼接，历史上多次因「漏引号/换行」产生语法错误导致整个面板静默失效——
  改动后务必 compile + 重装验证；面板全死时 Ctrl+Shift+I 看 Console 红色报错

## 移植/嵌入到其他 App 的注意事项（以后嵌入时读这段）

- **核心只依赖 piClient.ts + panel.ts 的事件桥**：piClient（spawn `pi --mode rpc` + JSONL 分帧 +
  pending 配对）与宿主 UI 无任何耦合，可直接搬；真正要重写的是「panel.ts 的 post() 消息 → webviewJs
  的 m.type 分发」这一层，把它映射到目标 UI 的事件即可
- **事件桥语义**（宿主 UI 需要处理的消息全集）：user/delta/thinking/newLive/toolStart/toolEnd/
  busy/render/queue/notice/status/mode/queuedAdd/queuedDelivered/queuedClear/codeCtx/addImages/
  sessionList/slashList/fileList/state
- **pi 侧要点**：steering 插话不触发 agent_start，转正只能靠 queue_update 队列变短；
  contentIndex 每条消息重计，必须处理 message_start；busy/流式中途严禁整页重绘，重绘只在 settled；
  新建会话会重置模型；JSONL 只按 \n 分帧
- **会话文件**：~/.pi/agent/sessions 下的 jsonl 是唯一事实来源，UI 展示的文本带
  `--- 代码上下文 ---` 前缀时可剥离还原胶囊

## 插件利用了 pi 的哪些能力（原理层，2026-09-03 整理）

**总原理**：pi 的 `--mode rpc` 把 agent 内核完全可编程化——stdin/stdout 跑 JSONL
（命令进→响应出→事件流不断推），插件本质 = piClient（RPC 客户端）+ 事件→UI 的翻译桥。

**面板功能 ↔ pi 能力对照**：
- 对话 = prompt 命令（pi 自己管 LLM 调用/工具执行/循环决策）
- 工作中插话 = prompt + streamingBehavior:"steer"（pi 把消息放入 steering 队列，
  在下一个 LLM 调用点注入当前运行）；set_steering_mode 控制逐条/全部
- 排队管理 = clear_queue + queue_update 事件（靠队列变短感知插话被取走）
- 停止 = abort；模型热切 = set_model / set_thinking_level（无需重启）
- 历史会话 = 磁盘上的 jsonl 追加日志（唯一事实来源）；switch_session/clone/fork/
  set_session_name 都是它的衍生操作；fork = 截断到某条 entryId
- 压缩 = compact / set_auto_compaction（摘要替换旧消息释放窗口）
- /命令・技能 = pi 扩展系统（~/.pi/agent/extensions/ 下的 TS 注册）；
  权限模式四档就是自写的 modes.ts 扩展拦截 tool_call 实现的（mode.json 只是持久化）
- 导出 = export_html；直连 shell = bash（输出注入上下文）

**事件流原理（渲染层）**：
- message_start/update/end：内容块按 contentIndex 逐 delta 推送，客户端自己拼装部分消息；
  **每条消息 contentIndex 从 0 重计，必须监听 message_start 开新气泡**
- tool_execution_start/end：工具生命周期，驱动绿✓/红✗/蓝圈呼吸圆点
- agent_start/agent_settled：运行边界；settled 时整页重读会话重绘纠偏
- auto_retry_*、queue_update：重试与队列变化
- extension_ui_request/response：pi 扩展的人机交互→插件翻译成 VS Code 原生 UI
  （双向能力，pi 侧任何扩展的交互都能可视化）

**三条设计结论**：
1. 面板不自己存消息状态——流式只是乐观预演，纠偏一律以 pi 会话记录重读为准
2. steering 注入不触发 agent_start，转正时机只能靠 queue_update
3. pi 扩展系统是能力放大器——CLI 没有的功能可以给 pi 写扩展补出来

## 用户偏好

- 喜欢Claude Code的交互风格，持续对标 CC
- 要求所有 pi 命令行能力可视化，不碰终端
- 沟通用中文，简洁直接，改完直接给构建命令
