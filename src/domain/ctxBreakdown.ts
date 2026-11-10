/**
 * 上下文用量分类估算（2026-11-05 用户工单：面板内「上下文用量」明细条）。
 *
 * 为什么自己算：pi 只给总量（getSessionStats().contextUsage = {tokens, contextWindow, percent}），
 * 没有分类。但 pi 的系统提示词本身是**分节结构**（pi-ai 的 SystemMessage.sections，由
 * @earendil-works/pi-coding-agent 的 buildSystemPromptSections 产出），工具声明在
 * SystemMessage.toolsAdded —— 两者都是精确的，不是猜的：
 *
 *   preamble / tools / rules / docs / cwd / addendum  → 系统提示词
 *   project_context                                   → 项目上下文（AGENTS.md 等）
 *   skills                                            → 技能（formatSkillsForPrompt 原文）
 *   其余 section 名字                                  → 扩展注入（MCP 扩展在这一层）
 *   toolsAdded（按 pi 的 isMcpToolName 口径分流）        → 工具定义 / 连接器及 MCP
 *   其余 message                                      → 对话消息
 *
 * token 估算复刻 pi 自己的 estimateMessageTokens：chars / 3.5，图片按 4800 字符。口径一致
 * 才谈得上与原生总量对账；差额（tokenizer/缓存）由调用方归入「其他」，不在这里硬凑。
 *
 * 零 import（webview 共享编译 / node 裸跑用例都直接相对导入），纯函数无副作用。
 */

/** 与 pi compaction 内部同一个常量（compaction.js 的 CHARS_PER_TOKEN） */
export const CHARS_PER_TOKEN = 3.5;
/** 与 pi 同一个常量（compaction.js 的 ESTIMATED_IMAGE_CHARS） */
export const ESTIMATED_IMAGE_CHARS = 4800;
/** 系统提示词自带名的节；不在表里的 section 名字一律视为扩展注入（MCP/自研扩展） */
const SYS_PROMPT_SECTIONS = new Set(["preamble", "tools", "rules", "docs", "cwd", "addendum"]);
/** MCP 资源工具（pi core/mcp-servers.js 的 MCP_RESOURCE_TOOLS） */
const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

export interface ContextBreakdown {
  /** 系统提示词（preamble/tools/rules/docs/cwd/addendum + content 正文） */
  prompt: number;
  /** 项目上下文（AGENTS.md 等 context files） */
  project: number;
  /** 非 MCP 工具的定义（JSON schema 是这项的大头） */
  tools: number;
  /** 对话消息（user/assistant/toolResult） */
  messages: number;
  /** MCP 工具定义 */
  mcp: number;
  /** 技能（skills 节） */
  skills: number;
  /** 扩展注入的自定义 section（MCP 扩展等），由调用方并进「连接器及 MCP」 */
  extSections: number;
  /** 以上合计（调用方与原生 tokens 的差额归「其他」） */
  estimated: number;
}

function tokFromText(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** 与 pi 的 isMcpToolName 逐字符同口径（core/mcp-servers.js）：mcp__ 前缀 + 三个资源工具 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

function tokFromContent(content: unknown): number {
  if (typeof content === "string") return tokFromText(content);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const b of content as any[]) {
    if (b?.type === "text") chars += String(b.text ?? "").length;
    else if (b?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** 与 pi estimateMessageTokens 同构：user/toolResult 看 content；assistant 看
 *  text/thinking/toolCall（工具名 + 参数 JSON） */
function tokFromMessage(m: any): number {
  if (m?.role === "user" || m?.role === "toolResult") return tokFromContent(m?.content);
  let chars = 0;
  for (const b of Array.isArray(m?.content) ? m.content : []) {
    if (b?.type === "text") chars += String(b?.text ?? "").length;
    else if (b?.type === "thinking") chars += String(b?.thinking ?? "").length;
    else if (b?.type === "toolCall") chars += String(b?.name ?? "").length + safeJson(b?.arguments).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 按 pi 的会话消息结构分类估算。
 *
 * sections 是**补丁语义**：leading system 消息声明全部节，后续 system 消息按名字覆盖，
 * null 表示删除（见 pi-ai types.d.ts 的 SystemMessage.sections 注释）——所以必须先累积到
 * 最终态再量，逐条累加会重复计数且把删掉的节也算进去。toolsAdded/toolsRemoved 同理。
 */
export function estimateContextBreakdown(messages: readonly unknown[]): ContextBreakdown {
  let prompt = 0;
  let project = 0;
  let skills = 0;
  let extSections = 0;
  let messagesTok = 0;
  const sections = new Map<string, string>();
  const tools = new Map<string, unknown>();

  for (const raw of messages ?? []) {
    const m: any = raw;
    if (m?.role === "system") {
      if (typeof m.content === "string" && m.content) prompt += tokFromText(m.content);
      else if (Array.isArray(m.content)) prompt += tokFromContent(m.content);
      const sec = m.sections;
      if (sec && typeof sec === "object") {
        for (const k of Object.keys(sec)) {
          const v = (sec as any)[k];
          if (v === null) sections.delete(k);
          else sections.set(k, String(v));
        }
      }
      for (const t of Array.isArray(m.toolsAdded) ? m.toolsAdded : []) {
        const name = (t as any)?.name;
        if (name) tools.set(String(name), t);
      }
      for (const r of Array.isArray(m.toolsRemoved) ? m.toolsRemoved : []) {
        const name = typeof r === "string" ? r : (r as any)?.name;
        if (name) tools.delete(String(name));
      }
    } else {
      messagesTok += tokFromMessage(m);
    }
  }

  for (const [k, v] of sections) {
    if (k === "project_context") project += tokFromText(v);
    else if (k === "skills") skills += tokFromText(v);
    else if (SYS_PROMPT_SECTIONS.has(k)) prompt += tokFromText(v);
    else extSections += tokFromText(v);
  }

  let toolsTok = 0;
  let mcpTok = 0;
  for (const [name, t] of tools) {
    const n = tokFromText(safeJson(t));
    if (isMcpToolName(name)) mcpTok += n;
    else toolsTok += n;
  }

  return {
    prompt,
    project,
    tools: toolsTok,
    messages: messagesTok,
    mcp: mcpTok,
    skills,
    extSections,
    estimated: prompt + project + toolsTok + messagesTok + mcpTok + skills + extSections,
  };
}

/**
 * 自动压缩阈值的三段档位（2026-11-05 用户拍板）：把模型窗口三等分，对齐到好读的整数，
 * 末档恒等于窗口本身（「拉满」= 到窗口才压缩）。
 *
 * 为什么按比例而不是写死 300K/600K/1M：窗口是模型属性（1M / 200K / 128K 都有），
 * 写死数字在 128K 的模型上会出现「三档都在窗口外」的荒谬结果。
 *
 * 返回升序数组（长度 3）；窗口未知返回空数组（调用方据此禁用滑块）。
 */
export function compactionStops(window: number | null | undefined): number[] {
  const win = Number(window ?? 0);
  if (!win || win <= 0) return [];
  // 步进按窗口量级选：小窗口（<30K）用 1K 步，中窗口用 5K，大窗口用 50K——标签才好读
  const unit = win >= 300000 ? 50000 : win >= 30000 ? 5000 : 1000;
  const a = Math.round(win / 3 / unit) * unit;
  const b = Math.round(((win * 2) / 3) / unit) * unit;
  // 对齐后可能等于上一档（极小窗口）→ 去重，末档恒为窗口本身
  const out = [a, b, win].filter((v, i, arr) => i === 0 || v > arr[i - 1]);
  return out.length === 3 ? out : [win];
}
