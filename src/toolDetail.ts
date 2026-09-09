/**
 * 从工具调用参数里提取一行摘要（命令 / 文件路径 / URL / 搜索词等）。
 * 宿主（流式工具行）与 webview（历史重绘）共用，避免同一工具调用两处摘要漂移。
 *
 * 历史：原为两套独立实现（panel.ts toolDetail 用 ?? 链、webview historyDetail 用 || 链），
 * 字段集与空串处理互有出入——DIRECTOR 工单三合并为字段并集 + 首字符串兜底。
 */

/** 按优先级排列的摘要字段（并集：宿主版 9 键 ∪ webview 版 9 键） */
const DETAIL_KEYS = [
  "command",
  "file_path",
  "path",
  "url",
  "query",
  "pattern",
  "content",
  "skill",
  "name",
  "file",
  "cmd",
] as const;

function oneLine(v: string): string {
  return v.replace(/\s+/g, " ").slice(0, 120);
}

export function toolDetail(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  // 已知键按优先级取；|| 语义（跳过空串——空命令不算摘要）
  for (const k of DETAIL_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v) return oneLine(v);
  }
  // 兜底：首个非空字符串值（webview 版原有行为，host 版漂移缺失）
  for (const k in a) {
    const v = a[k];
    if (typeof v === "string" && v) return oneLine(v);
  }
  return "";
}
