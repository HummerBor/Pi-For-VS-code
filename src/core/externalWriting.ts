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
/** name 键登记：pi -p 刚 spawn 时会话文件可能还没建/没进 memo（3s TTL），按 name 解析
 *  不到 file——信号不能丢，直接按 --name 值登记（piClient 判活跃时拿 sessionName 对一下）。
 *  带时间戳：僵尸锁逃生阀——ops-panel 被 -9 杀掉时 finally 跑不了，30 分钟 TTL 过期自动解锁 */
const holderNames = new Map<string, number>();
export const HOLDER_TTL_MS = 30 * 60 * 1000;

function normPath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 跟随请求登记（2026-10-29 结构修正：武装制）：piChat.openSession 打开的会话才
 *  进入跟随机制。普通列表点开 = 100% 老路径，不碰任何外部写者判定——原功能隔离。 */
const followRequests = new Set<string>();

export function requestFollow(file: string): void {
  followRequests.add(normPath(file));
}

export function isFollowRequested(file: string | null | undefined): boolean {
  return !!file && followRequests.has(normPath(file));
}

/** 外部写者登记/注销（writing:false = 交棒信号）。路径按规范化 key 存取 */
export function setExternalWriting(file: string, writing: boolean): void {
  const k = normPath(file);
  if (writing) holders.add(k);
  else holders.delete(k);
}

/** 按会话名登记/注销（file 未解析到时的兑底，与 setExternalWriting 双写双清） */
export function setExternalWritingName(name: string, writing: boolean): void {
  const k = name.trim();
  if (!k) return;
  if (writing) holderNames.set(k, Date.now());
  else holderNames.delete(k);
}

/** 该会话文件是否被外部写者持有（刀2 只读判定的登记命中分支）。
 *  path/name 任一命中即真；name 命中时受 TTL 约束（过期视为漏发信号，交 mtime 启发式） */
export function isExternalWriting(file: string | null | undefined, name?: string | null): boolean {
  if (file && holders.has(normPath(file))) return true;
  if (name) {
    const at = holderNames.get(String(name).trim());
    if (at !== undefined && Date.now() - at < HOLDER_TTL_MS) return true;
    if (at !== undefined) holderNames.delete(String(name).trim()); // 过期即清，下次不再命中
  }
  return false;
}

/** 测试钩子：清空登记表（生产路径不调用）。path/name 两键都清——只清一半会跨用例残留
 *  污染（返修P3：探针⑤实证 reset 后 name 键仍命中） */
export function _resetExternalWritingForTest(): void {
  holders.clear();
  holderNames.clear();
  followRequests.clear();
}
