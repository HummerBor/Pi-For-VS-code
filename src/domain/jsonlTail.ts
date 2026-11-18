/**
 * 子会话 jsonl 增量读取（v23，2026-11-19）。
 *
 * 背景：进度帧曾经把消息正文塞进父会话（每帧 233KB，一个会话 266MB）。v23 之后帧只带
 * 「面板画一行」的最小集，正文真值永远是子进程自己写的那个 jsonl——转录页打开时读一次，
 * 之后按字节偏移增量读新增部分（帧只负责喊一声「有新内容」）。
 *
 * 边界（都是实测踩过的坑）：
 * - **只消费到最后一个换行**：子进程可能正写到一半，半行留在偏移上等下次——不丢、不重、
 *   不会因为 JSON.parse 失败把一条消息永久跳过。
 * - 读不到文件返回 null（页面已关/文件被移走）：调用方静默跳过，下一条帧再试。
 * - 纯 IO + 解析，零 vscode 依赖：能被 node 裸跑用例直接测（scripts/test/jsonlTail.test.mjs）。
 */
import * as fs from "fs";

export interface JsonlTailResult {
  /** 新增的 message 条目（已剔除 system：与转录页历史读取同口径） */
  messages: unknown[];
  /** 消费后的新偏移（下次从这里继续） */
  offset: number;
}

/** 文件字节大小；读不到返回 0（下次从 0 读全量，不会因为一次失败永久丢内容） */
export function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 从 `offset` 读到文件末尾，返回其中完整的 message 条目与新的偏移。
 * 没有新内容 / 没有完整行 / 文件不可读 → null。
 */
export function readNewMessages(file: string, offset: number): JsonlTailResult | null {
  const size = fileBytes(file);
  if (size <= offset) return null;
  let chunk = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      chunk = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const cut = chunk.lastIndexOf("\n");
  if (cut < 0) return null; // 只写了半行：等下次
  const consumed = Buffer.byteLength(chunk.slice(0, cut + 1), "utf8");
  const messages: unknown[] = [];
  for (const line of chunk.slice(0, cut).split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（不阻塞后续行）
    }
    const e = entry as { type?: string; message?: { role?: string } };
    if (e?.type !== "message" || !e.message) continue;
    if (e.message.role === "system") continue;
    messages.push(e.message);
  }
  return { messages, offset: offset + consumed };
}
