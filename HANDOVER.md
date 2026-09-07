# pi-for-vscode 插件交接文档

> 给新会话的 pi：本项目是一个 VS Code 扩展，为 pi coding agent 提供 Claude Code 风格的聊天面板。
> 本文档是上一个会话的完整交接，读完后即可继续开发。最后更新：2026-09-04

## 项目概览

- 位置：`D:\work\docs\pi test\pi-vscode`（git 仓库根就在这里，**不是上级目录**）
- GitHub：https://github.com/HummerBor/Pi-For-VS-code （公开，MIT LICENSE，README 已重写为正式项目说明）
- 插件名：pi-for-vscode，publisher=HummerBor，版本 0.0.6
- Marketplace 上架材料已备齐（publisher/license/repository/PNG 图标），**用户还没上传**——
  流程：marketplace.visualstudio.com/manage → 建发布者 → Upload VSIX（或 vsce publish）
- 用户环境：Windows，pi 已全局安装；**已切智谱中国区**（`zai-coding-cn` / `glm-5.3-flash`，
  已写入 `~/.pi/agent/settings.json` 的 defaultProvider/defaultModel）；
  Zai 全球站(`zai`/api.z.ai)与中国区(`zai-coding-cn`/open.bigmodel.cn)账号体系不通用，key 二选一
- 用户不熟悉命令行，所有 pi 能力都要求做成面板可视化操作

## 架构

```
src/extension.ts   - 扩展入口：注册 WebviewViewProvider（retainContextWhenHidden 保活）+ 状态栏按钮
src/panel.ts       - 核心（~2100行）：ChatPanelProvider，RPC 事件→UI，所有功能菜单
src/piClient.ts    - RPC 客户端：spawn pi --mode rpc，stdin/stdout JSONL（LF 分帧，勿用 readline）
src/panel.ts 底部  - getHtml()/css()/webviewJs()：webview UI（webviewJs 是字符串数组拼的 JS，改时注意转义！
                     每行必须独立包裹引号；TS 字符串里的 \n 会变成真实换行导致语法错误，要写 \\n）
```

构建：`npm run compile` → `vsce package` → 扩展面板「从 VSIX 安装」→ 重载窗口
调试：F5（已配 .vscode/launch.json + tasks.json）

## 功能清单（全部已实现）

- **会话**：⏱ 历史面板（搜索/删除/切换，项目级过滤 ~/.pi/agent/sessions）、＋新会话、
  agent_start 时同步真实会话记录（排队清空机制）；打开面板不弹任何选择框，静默预热；
  新会话自动补回记住的模型/思考等级（pi 的 new_session 会重置模型）；
  **工作中点 ＋ 会弹确认**（防误终止运行中的任务）
- **主题**：头部 ◐ 按钮，跟随 VS Code / CC 暗黑 / 午夜蓝（css() 里 body[data-theme=...] 规则，
  加新主题就在那里加一段），piChat.theme 持久化，getHtml(theme) 启动即应用
- **统一 SVG 图标（2026-09-04）**：webviewJs 顶部 `ICON_PATHS` + `ico(name,size)` + `esc()`，
  全部图标（时钟/加号/齿轮/主题圆/图片/文档/芯片/箭头/叉/对勾/@/终端…）16 网格描边风、
  currentColor 跟随主题；静态 HTML 里按钮留空壳，JS 注入（见「图标注入」块）。
  ⚠️ **定义必须在使用之前**（脚本自上而下执行，ICON_PATHS 放注入之后会 TypeError 全面板死）
- **菜单合并（2026-09-04）**：头部只留 4 按钮（历史/新会话/齿轮菜单/主题）；齿轮=runCommand
  合并菜单（QuickPick 分隔线分「会话操作」「配置」两组）；settingsMenu() 保留供 / 菜单
  「pi 设置…」单独打开；buildSettingsItems() 是条目工厂
- **会话自动命名（2026-09-04）**：autoTitleSession()——未命名会话首条真实文字消息 →
  前 40 字 setSessionName；readSessionMeta 预览跳过纯代码上下文/占位消息；兜底「未命名会话」
- **历史面板打开文件（2026-09-04）**：会话行悬停有 📄(revealSessionFile→旁栏打开 .jsonl)
  和 ✕(删除)两钮；行悬停 title 显示完整路径；点行=切换会话
- **聊天内文件路径可点击（2026-09-04 晚补完）**：webviewJs `FILE_RE`+`cleanPath()`+`linkify()` 把文本里
  路径包成 .fp span（绝对/相对/中文/空格路径、光文件名（扩展名白名单）、支持 `:行:列` 后缀；
  跳过 URL 与代码块；修复 `s://` `p://` 被盘符分支误认的 bug）；
  **点击监听器在 messages 捕获阶段**（没有它 .fp 就是死样式——曾漏写导致点击无反应）；
  宿主 openFilePath：直接路径找不到 → findFiles 全工作区按文件名搜；二进制扩展名（vsix/zip/exe…）
  不做成链接也不打开；打开栏位固定（第一次 Beside 分栏后记住 viewColumn，不再每次点都往右新分栏）；
  renderRich/工具行 detail/明细块/notice 都接入；renderAll 只对最近 15 条 linkify（老消息跳过，重绘提速）
- **模型/思考**：工具条点击切换，globalState 跨重启记忆（piChat.lastModel/lastThinking）
- **pi 环境自助**：启动时 spawn `pi --version` 检测，没装→弹窗一键 npm 全局安装（进度/结果进面板）；
  ⚙ 菜单可配 API key（写 ~/.pi/agent/auth.json，与 /login 同格式）、订阅登录 /login、
  查看/删除凭证、安装/更新 pi；key 格式 `{ "zai": { "type": "api_key", "key": "..." } }`
- **权限模式**：pi 扩展 `~/.pi/agent/extensions/modes.ts` 提供 /mode 命令（manual/edit-auto/plan/auto 四档，
  持久化到 ~/.pi/agent/mode.json，tool_call 事件拦截）；状态栏徽标点击弹出选择（插件直接写 mode.json）
- **消息发送**：Enter 发送；agent 工作中 → steer 插队（虚线⏳排队气泡，agent_start 时清空并以
  getMessages 重绘转正）；agent_settled 时清残留排队并整页重绘
- **代码上下文**：监听编辑器选区（250ms 防抖），选中→附带选中行，无选区→整个文件（>80KB 跳过）；
  工具条胶囊可点击切换带/不带走；发送时拼 "--- 代码上下文: rel (range) ---" 代码块
- **图片**：粘贴/拖拽/＋菜单上传，base64 走 prompt.images，缩略图胶囊可删除（最多4张）
- **/ 菜单**：分组（上下文/会话/模型/配置/命令技能模板），内置项直接触发面板动作（builtin 字段）；
  TUI 内置命令（/login /settings /theme /hotkeys /help）prompt case 拦截提示正确入口，
  不再静默变成对话消息；**订阅登录**走 openTerminalLogin()（集成终端跑交互式 pi，
  用户在里面输 /login 完成 OAuth——RPC 模式下 TUI 内置命令不可用，这是 pi 官方行为）
- **@ 文件引用**：工作区文件索引（跳过 node_modules/out/隐藏目录，深度6，上限2000）
- **⚡ 命令菜单**：重命名会话/compact/清空排队/导出HTML/fork/clone/bash/get_commands
- **⚙ 设置菜单**：权限模式/插话送达/追问送达/自动压缩/自动重试/会话模式/sessionDir/打开pi配置目录
- **工具渲染**：CC 风格——状态圆点（绿✓/红✗/蓝圈呼吸=运行中）+ 粗体工具名 + 灰色参数摘要，
  点击展开 IN/OUT 块（tool-box）；工作中默认展开，结束/历史默认收起；
  renderAll 把连续同名工具合并为 `● name ×N ▸` 组（展开是每次调用的明细行）
- **流式渲染（2026-09-04 晚三轮迭代后的最终形态：事件驱动 + 行级增量）**：
  **两严禁**：严禁每个 delta 全量重绘整条消息（O(n²) 拖死 UI）；严禁定时攒批重渲染（顿挫感）。
  正确做法（与 pi TUI/CC 同构）：appendDelta 事件驱动，每个增量立刻 streamTick——
  已完成的行（换行结尾且不在未闭合围栏内）调用 renderRich 定型后**永不再碰**；
  当前未完成行只更新一个小尾巴 textContent；代码围栏内原样流进 pre，闭合时整块定型。
  settle 后仍以会话记录重读全量纠偏。必须处理 message_start（newLive→finalizeLive+liveReset，
  新气泡）——插话后 contentIndex 重新计数的坑不变。
  **宿主转发 toolcall_start/toolcall_delta**（之前丢弃）：大 write/edit 光生成参数就要几十秒，
  期间显示呼吸占位行「正在生成调用参数… N 字符」（class=prow，可点击展开看原始参数流），
  工具真正开跑（toolStart）时按 .prow class 全局清除（曾因只置空引用不清 DOM 出现占位行与
  真实行同框的 bug）。toolStart 仍先切断当前气泡（文本落到工具行下方）
- **乐观气泡（2026-09-04 晚）**：prompt case 里 user 气泡/排队项在 `await client.prompt()` **之前**
  就 post（pi 冷启动+发送要几秒，等 await 完才画会被用户当成消息丢了）
- **renderAll 提速（2026-09-04 晚）**：整页重绘是大会话卡顿主因——老消息（非最近 15 条）跳过
  linkify 正则；'render' 消息 setTimeout(0) 延后一拍（用户气泡先上屏再重绘）。
  严禁在 busy/流式中途整页 renderAll 的规则不变
- **状态栏**：模式徽标 + 工作计时秒数 + 排队计数 + 上下文% + 费用
  （曾加过「静默/无响应 Ns」又移除：与工作计时重复、措辞误导；真故障由 auto-retry 提示兜底）
- **排队反馈**：工作中发消息→输入框上方 queuebar 单行 ⏳（紧凑不占位）；
  **steering 是插进当前运行，不会触发 agent_start**——转正信号靠 queue_update 队列变短
  （lastQueueTotal 计数差 → 最早的 ⏳ 逐条转正为普通气泡）；agent_settled 才整页重绘
  （syncRenderKeepQueued，未送达的排队项保留）+ 计数器归零；wasBusy 决定是否带 steer
  （注意：乐观 busy 置位后必须用捕获的 wasBusy 调 prompt，否则空闲消息被当插话变慢）
- **插话送达**：默认 one-at-a-time（CC 风格一条条处理，piChat.steeringMode 可配），启动时自动应用；
  ⚙ 菜单切换会持久化到配置
- **会话记忆（按项目）**：globalState piChat.lastSessionByWs 存「工作区路径→会话文件」映射，
  启动/重启自动恢复对应项目的上次会话（不串项目）；webview retainContextWhenHidden 保活
- **错误反馈**：auto_retry_start 带 errorMessage 弹 notice + 状态栏；auto_retry_end 成功→✅、
  耗尽→❌ 带 finalError；piChat.autoRetry 默认 true，启动自动应用；
  未知 pi 事件若携带 error/reason 字段会透传为面板 notice（避免报错无反馈）
- **启动**：面板首次可见即预热 pi 进程（PI_SKIP_VERSION_CHECK=1），消除首条消息延迟

## 已知问题/限制

- 旧会话文件里存的空文字消息（bug 时期产生的）重绘时显示「📄 (代码上下文)」占位，无法追溯修复，
  开新会话即可
- Z.ai 免费档请求超时/过载常见（服务端行为）：auto-retry 已默认开启，失败原因和 ✅/❌ 结果面板可见
- webview JS 是字符串数组拼接，历史上多次因「漏引号/换行」产生语法错误导致整个面板静默失效——
  改动后务必 compile + 重装验证；面板全死时 Ctrl+Shift+I 看 Console 红色报错。
  **另一个同类型坑（2026-09-04）：脚本是自上而下执行的，库/常量定义必须放在调用之前**——
  图标注入代码写在 `var ICON_PATHS` 定义之前，首次 `ico()` 调用抛 TypeError 整个脚本死掉
  （图标全消失 + 所有事件监听没绑上，症状像「面板全死」）。新增帮助函数时永远定义在最前面
- **迷你 markdown 渲染器（renderPlain/renderInline/renderTable）**：代码块（**围栏必须行首**，
  行内 ``` 曾把大段内容吞进原始代码框）/标题/表格（| 语法 → md-table）/列表（- * → • 圆点、
  编号、嵌套缩进）/引用块 >/行内 code/粗体；表格之外的复杂嵌套不支持
- **中断保留现场（abortSkipRender）**：pi 不把被中断的部分内容写进会话文件（content 为空），
  中断后的 settled 重绘会抹掉已流出的思考/工具行——中断后跳过一次重绘，现场保留到下一轮；
  彻底持久化需 pi 侧支持
- **代码上下文剥离（renderAll 用户分支）**：附带文件里可能含 ```，不能非贪婪找第一个闭合围栏，
  要 lastIndexOf 取最后一个，否则剩余原始 markdown 会灌满用户气泡
- **pi RPC 实测事件名（2026-09-04 实测）**：assistantMessageEvent 有 text_delta/thinking_delta/
  toolcall_start{id,toolName,contentIndex}/toolcall_delta{delta为args原始JSON片段}/toolcall_end；
  auto 模式下 edit/write 不需要审批（modes.ts 只在 manual/edit-auto 拦）
- **同一项目开多个 VS Code 窗口会恢复同一个会话文件（lastSessionByWs 按文件夹映射），
  两窗口的 pi 同时写一个会话文件有冲突风险——多标签功能做掉前，同项目别开双窗口干不同的活
- 编译后可用一行命令快速验证 webview JS 语法（不重装 VSIX）：
  `node -e "const fs=require('fs');let src=fs.readFileSync('out/panel.js','utf8');const html=new Function(src.slice(src.indexOf('function getHtml'),src.indexOf('//# sourceMappingURL'))+';return getHtml(\"auto\")')();new Function(html.match(/<script nonce=\"[^\"]*\">([\\s\\S]*)<\\/script>/)[1]);console.log('OK')"`
  （只能查语法，查不出运行时顺序问题——库定义务必放使用之前）

## 下一个大功能：面板内多标签并行会话（用户已提出，未开工）

用户想在一个面板里开多个会话让 agent 并行干不同的活。设计草案：
- 每个标签页一个独立 PiClient 进程（clients 从单例变 Map<tabId, {client, queued, busy,...}>）
- 所有 post 事件带 tabId，webview 加标签栏 + 每标签独立消息 DOM（或切签时重渲染）
- 后台标签任务完成时标签上亮提示；关闭标签要 dispose 进程
- lastSessionByWs 逻辑需同步扩展为按标签；会话自动命名后标签标题可直接用会话名；
  注意多进程写同一会话文件的隔离
- **架构级改动，改动后需充分测试**（多进程并行/事件路由/资源回收），建议单独排一个会话

## 2026-09-04 会话待验收清单（用户正在测）

① 图标统一显示 ② 齿轮合并菜单两组 ③ 新会话首条消息自动命名
④ 历史面板 📄 打开 .jsonl / 行点击切换 ⑤ 聊天内路径点击打开（含 :行号跳转）
⑥ 输入框敲 /login 有提示并自动开终端 ⑦ 重载后默认模型 glm-5.3-flash（中国区）。
全部通过后：git 提交推送（本轮改动一笔）+ 用户上传 Marketplace VSIX

## 2026-09-04 晚间会话：已验收通过（用户确认「很漂亮」）

流式行级增量、链接当前列打开、乐观气泡、中断保留现场+⏹提示、表格/列表/引用渲染、
光文件名点击+findFiles 兑底、二进制不链接、通知去重/过滤、状态栏精简、代码上下文剥离修复。
后续：git push（等网络）+ Marketplace 上传（最新 VSIX）+ 多标签并行会话（单独排会话）

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
