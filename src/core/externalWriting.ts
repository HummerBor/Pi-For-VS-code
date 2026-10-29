/**
 * externalWriting —— 外部写者持有登记表（工单32 刀1）。
 *
 * 通用外部接入面的控制面之一：有管家的写者（管着 pi 子进程、准知道什么时候写完）
 * 经 `piChat.externalWriting` 命令发信号登记/注销；刀2 的只读判定（externalActive）
 * 查本表 + 文件 mtime 启发式，决定输入锁/徽标/交棒时机。
 *
 * 纯逻辑叶（同 subagentNames 口径）：零 import，注册表是模块级 Set——命令入口（宿主侧，
 * extension.ts 解析 name→file 后写入）与 piCore（核心，禁 import vscode）两侧共用，
 * 依赖倒置方向：宿主写、核心读，核心不碰 vscode。
 * key 规范化与 sessionCache.samePath 同口径（去分隔符重复/尾斜杠 + 小写，Windows 友好）。
 */
const holders = new Set<string>();

function normPath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 外部写者登记/注销（writing:false = 交棒信号）。路径按规范化 key 存取 */
export function setExternalWriting(file: string, writing: boolean): void {
  const k = normPath(file);
  if (writing) holders.add(k);
  else holders.delete(k);
}

/** 该会话文件是否被外部写者持有（刀2 只读判定的登记命中分支） */
export function isExternalWriting(file: string | null | undefined): boolean {
  return !!file && holders.has(normPath(file));
}

/** 测试钩子：清空登记表（生产路径不调用） */
export function _resetExternalWritingForTest(): void {
  holders.clear();
}
