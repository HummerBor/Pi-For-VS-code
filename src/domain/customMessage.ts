/**
 * `role:"custom"` 消息的挑选口径（工单43，2026-11-19）。
 *
 * 为什么需要这份口径：pi 的扩展往会话里塞东西有**两种落盘形态，别混**——
 *  - `custom_message` 条目（`sendMessage` / `appendCustomMessageEntry`）→ **进 LLM 上下文**，
 *    投影成 `{role:"custom", customType, content, display, details, timestamp}` 的 Message
 *    （JSONL 里是 `type:"custom_message"`）。`harness/memory` 注入的压缩指针
 *    （`customType:"memory-pointer"`）就是这一条：模型看得见，面板此前静默穿落。
 *  - `custom` 条目（`appendEntry` / 扩展自己的 `appendEntry("xxx")`）→ **不进上下文**，
 *    永远不会变成 Message（pi 的 TUI 也不画，只交给 entry renderer）。
 *    `subagent-async` / `subagent-async-stream` 帧、`memory-digest` 探针都是这一条——
 *    它们各有自己的通道（浮窗/台账/探针），**不该**走消息流。
 *
 * 判定以 `display` 为准（pi 给扩展的「这条要不要给人看」信号），不写死白名单；
 * 白名单只做兜底：已有专属通道的两个 subagent 帧类型必须排除，否则同一次运行会被画两遍
 * （浮窗一份 + 消息流一份）。
 *
 * display 的准确口径：pi 自己的 TUI 是**真值判定**——`interactive-mode.js` 里
 * `case "custom": if (message.display) { ... } `、`entry_appended` 也是
 * `event.entry.type === "custom_message" && event.entry.display`。这里照抄，
 * 不采用「display !== false」：display 缺失的注入消息 pi 不画，壳也不该画（两侧分裂比漏画更糟）。
 */

/** 已有专属通道的 customType 兜底黑名单（不写白名单：display 才是 pi 的口径） */
const HIDDEN_CUSTOM_TYPES = ["subagent-async", "subagent-async-stream"];

export function isHiddenCustomType(customType: unknown): boolean {
  return typeof customType === "string" && HIDDEN_CUSTOM_TYPES.indexOf(customType) >= 0;
}

/** custom 消息的 content 是 `string | (TextContent|ImageContent)[]`：只取文本。
 *  注入消息里放图的需求不存在，画了也是无源噪声（图像内容留给用户/助手消息那两条路）。
 *  与 piCore 的 extractText 等价，但**不 import piCore**——webview 也要用同一份口径，
 *  不能为了拼个文本把整个宿主核心拖进 webview 包（架构铁律 §五的同一理由）。 */
export function customMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  let out = "";
  if (Array.isArray(content)) {
    for (const c of content) {
      const t = c as { type?: string; text?: string } | null;
      if (t?.type === "text" && t.text) out += t.text;
    }
  }
  return out;
}

/** 该 custom 消息要不要给用户看：display 非真不给（pi TUI 同口径）、
 *  专属通道类型不给（重复渲染）、没文本不给（免得画一条空条）。 */
export function isRenderableCustomMessage(m: unknown): boolean {
  const r = m as
    | { role?: unknown; display?: unknown; customType?: unknown; content?: unknown }
    | null
    | undefined;
  if (!r || r.role !== "custom") return false;
  if (!r.display) return false;
  if (isHiddenCustomType(r.customType)) return false;
  return customMessageText(r.content).length > 0;
}

/** 送 webview 的消息流派生（宿主侧唯一口径，落点见 piCore.webviewMessages）：
 *  只剔「不该露面的 custom 消息」，其余角色逐条原样返回（顺序不动——位置即真实性）。
 *  非 custom 角色一律放行：这里不做业务裁剪，只做「这条该不该给人看」。 */
export function filterCustomMessagesForWebview<T>(messages: readonly T[]): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const role = (m as { role?: unknown } | null | undefined)?.role;
    if (role === "custom" && !isRenderableCustomMessage(m)) continue;
    out.push(m);
  }
  return out;
}
