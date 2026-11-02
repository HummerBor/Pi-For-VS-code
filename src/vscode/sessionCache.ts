/**
 * sessionCache —— 会话列表的壳（2026-10-19 用户拍板「我要的是壳，复用不是再造轮子」）。
 *
 * 只做一件事：调 pi 原生 SessionManager.list / listAll，把结果投影成展示条目。
 *
 * 【清点回收记录，别再捡回来】自研快扫 sessionScan.ts（R′刀）连同它的落盘缓存已随本刀
 * 整体回收，理由三条，任何一条单独成立：
 * 1. 会话 jsonl 本身就是唯一记录（审计红线）——把派生副本再存一份 = 双份真相，
 *    用户点名「本来就有记录你再记录一次？」；
 * 2. pi 已有 list/listAll 原生能力（含 onProgress/AbortSignal），壳自研与它重复 =
 *    浪费 + 双份维护 + 行为分裂（AGENTS.md 铁律；先例：工单十三会话列表换
 *    SessionManager.listAll，后来 R′刀又造回来就是前车之鉴）；
 * 3. 用户明示「不需要比 pi -r 快」——性能不是保留轮子的理由。
 * R′刀当年「pi listAll 撞服务闸 31~38s」的前提 2026-10-19 复测不成立：
 * pi listAll 2.1s / list(cwd) 1.2s（本机实测），快扫自己冷扫反而 2.1s、拥堵下 22s。
 *
 * 保留的只有两条，都不是轮子也不是记录：
 * 1. **在途合并**（同 scope 并发共享同一 promise）——并发卫生：连点 N 次不该起 N 个
 *    pi listAll 各自解析几百 MB（实测 2s 拖成 22s，见 panel-load.test 第⑥把锁）；
 * 2. **应答复用**（内存 TTL 10s）——「每次点击都重扫」的直接治理，见 listNative 头注释。
 */
import { loadPiSdk } from "../pi/piSdk";
import * as vscode from "vscode";

export interface SessionInfo {
  file: string;
  name?: string;
  cwd: string;
  preview: string;
  mtime: number;
  time: string;
}

/** 路径相等判断（忽略大小写和分隔符差异，Windows 友好）。
 *  类型守卫：菜单/命令参数可能误传对象（2026-10-19 deleteSession 传入 SessionItem →
 *  p.replace is not a function），非字符串一律不等，不炸调用方 */
export function samePath(a?: unknown, b?: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const norm = (p: string) =>
    p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** pi 的 SessionInfo 类型（内联 import：零运行时依赖，类型参考的正确做法） */
type PiSessionEntry = import("@earendil-works/pi-coding-agent").SessionInfo;
/** 展示链需要的轻量字段（allMessagesText 之类重串不进展示层） */
export type PiSessionProjection = Pick<PiSessionEntry, "path" | "cwd" | "name" | "firstMessage" | "modified">;

/** 查询应答复用（2026-10-19 用户「每次点击都重扫」拍板）：**展示层秒出 + 后台静默刷新**。
 *  peekListSessions 立即回上一次结果（哪怕略旧，先把列表画出来，点击永不等扫描），
 *  listSessions 真值仍每次向 pi 要（壳口径：会话 jsonl 是唯一记录），到达后展示层原地替换。
 *  【这不是记录副本】不落盘、不留派生真相——只是查询应答；TTL 窗口内不重复问 pi，
 *  已知变更（删会话）显式失效。早前的错误是把派生数据落盘 + 自研第二套扫描器 */
const LIST_MEMO_TTL_MS = 3000;
const memo = new Map<string, { at: number; result: PiSessionProjection[]; subs: PiSessionProjection[] }>();
/** 已知变更处立即失效（删除会话后列表不能再拖 10s 旧账） */
export function invalidateListMemo(): void {
  memo.clear();
}

/** 工单32 刀1：会话库目录透传——piChat.sessionDir 配了就扫该目录（pi --session-dir 同源），
 *  空/未配回落默认库（undefined）。**memo key 必须带它**（原 key 只有 cwd，切配置后会
 *  吃到旧库缓存）；panel 的 onDidChangeConfiguration 另有 invalidate 兑底 */
export function configuredSessionDir(): string | undefined {
  const d = vscode.workspace.getConfiguration("piChat").get<string>("sessionDir", "").trim();
  return d || undefined;
}

/** pi 原生列表调用 + 在途合并 + 应答复用。scope 两级：cwd=项目内（pi list）、
 *  不传=全量（listAll）。进度回调透传 pi 的 onProgress，**第三参 partialSessions 必须
 *  接住**（2026-10-19 22s 定案）：pi 1.3.0 起 onProgress(loaded, total, partial) 在第一个
 *  文件解析完就吐第一批（实测 ~19ms，scripts/probe-list-timing.mjs），之后每 10 条一批，
 *  且最新文件先解析——pi -r 的「快」全靠拿到首批就画屏。壳这边丢掉第三参 = 死等全量
 *  （全量 1.2~2s，扩展宿主拥堵下实测 22~30s，pi-chat-debug.log 08:56 事故），用户看到的
 *  就是「正在加载会话… 17/193」干等。
 *  【注意】交接里「pi 实测 0 次 partialSessions」是拿 devDep 旧版 pi 0.85.1 量的误判
 *  （该版无 partial 发布）；运行时 PATH 上的 pi 1.3.0 有。版本错位见 BUILDER.md 挂账。 */
/** 子会话（harness 每单落 sessions/subagents/<handle>/）不进主列表（2026-11-02 用户
 *  实测「调用子 agent 后一堆会话历史被刷」）：回看走子 agent 浮窗台账行，列表保干净；
 *  后续如需分组展示再做「子智能体」折叠组（需求文档 P0-2），先过滤止血 */
const isMainSession = (e: PiSessionEntry): boolean => !/[\\/]subagents[\\/]/.test(e.path);const project = (x: PiSessionEntry): PiSessionProjection => ({
  path: x.path,
  cwd: x.cwd,
  name: x.name,
  firstMessage: x.firstMessage,
  modified: x.modified,
});
export type NativeProgress = (
  loaded: number,
  total: number,
  partial?: PiSessionProjection[]
) => void;
const inFlight = new Map<
  string,
  { p: Promise<PiSessionProjection[]>; subs: Set<NativeProgress> }
>();
export function listNative(
  cwd?: string,
  onProgress?: NativeProgress
): Promise<PiSessionProjection[]> {
  const sessionDir = configuredSessionDir(); // 工单32：memo key 带 sessionDir，切配置不吐旧库
  const key = (cwd ? "cwd:" + cwd : "all") + "|dir:" + (sessionDir ?? "");
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < LIST_MEMO_TTL_MS) return Promise.resolve(hit.result);
  const running = inFlight.get(key);
  if (running) {
    // 在途合并共享 promise，但**进度回调不能丢**：后到的调用（典型：预热扫描还在跑时
    // 用户点开 picker）必须订阅同一波进度，否则它拿不到 partial，又退回死等全量的老路
    if (onProgress) running.subs.add(onProgress);
    return running.p;
  }
  const subs = new Set<NativeProgress>();
  if (onProgress) subs.add(onProgress);
  const p = (async () => {
    try {
      const sdk = await loadPiSdk();
      // pi 原始条目进、投影出——两个方向的回调类型不能混（混了就是 TS2345）
      const progress = (loaded: number, total: number, partial?: PiSessionEntry[]) => {
        const proj = partial ? partial.filter(isMainSession).map(project) : undefined;
        for (const fn of subs) fn(loaded, total, proj);
      };
      const entries = (cwd
        ? await sdk.SessionManager.list(cwd, sessionDir, progress)
        : await sdk.SessionManager.listAll(sessionDir, progress)) as PiSessionEntry[];
      const result: PiSessionProjection[] = entries.filter(isMainSession).map(project);
      // 子会话单独一份（2026-11-02 用户拍板「左侧列表也列子会话」）：同一趟扫描顺手分组，
      // 不额外扫盘；展示层分折叠组，不让它们混进主列表（混排 = 调用子 agent 后列表被刷）
      const subsProj: PiSessionProjection[] = entries.filter((e) => !isMainSession(e)).map(project);
      memo.set(key, { at: Date.now(), result, subs: subsProj });
      return result;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, { p, subs });
  return p;
}

/** 列表时间的统一显示口径（样式集中：面板 ⏱ picker / 删除 picker / 左侧列表三处同源）：
 *  当年 `MM-DD HH:mm`、跨年 `YYYY-MM-DD HH:mm`——原来 toLocaleString()（2026/10/19
 *  19:39:07）在窄侧边栏里占宽且与面板页签标题（MM-DD HH:mm）两个口径。
 *  要改时间样式只改这里（将来适配主题/换格式也只动这一处） */
export function fmtListTime(mtime: number): string {
  const d = new Date(mtime);
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  const ymd = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? ymd : `${d.getFullYear()}-${ymd}`;
}

/** 投影→展示条目（cwd 过滤 + 按最近使用排序 + 截断）。纯变换，不持状态 */
export function toSessionInfos(
  entries: PiSessionProjection[],
  cwd?: string,
  limit = 50
): SessionInfo[] {
  const result: SessionInfo[] = [];
  for (const e of entries) {
    if (cwd && !samePath(e.cwd, cwd)) continue; // 双保险：pi list 已按项目筛过，listAll 路径靠这里筛
    const mtime = e.modified.getTime();
    result.push({
      file: e.path,
      mtime,
      time: fmtListTime(mtime),
      cwd: e.cwd ?? "",
      preview: (e.firstMessage || "").slice(0, 60),
      name: e.name,
    });
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, limit);
}

/** 立即回上一次查询结果（不等 pi）：展示层秒出用。没有就是没有，调用方自己出占位 */
export function peekListSessions(cwd?: string, limit = 50): SessionInfo[] | null {
  const hit = memo.get((cwd ? "cwd:" + cwd : "all") + "|dir:" + (configuredSessionDir() ?? ""));
  if (!hit) return null;
  return toSessionInfos(hit.result, cwd, limit);
}

/** 子会话列表（2026-11-02 用户拍板：左侧列表也列，但走折叠组不混主列表）。
 *  数据源 = 同一次 listNative 扫描的子会话半边（memo 命中则不重扫）；没有就回空数组。
 *  子会话的 cwd 记在 jsonl 头里，toSessionInfos 的 cwd 过滤能筛出本项目的。 */
export async function listSubagentSessions(cwd?: string, limit = 50): Promise<SessionInfo[]> {
  const proj = await listNative(cwd);
  const key = (cwd ? "cwd:" + cwd : "all") + "|dir:" + (configuredSessionDir() ?? "");
  const subs = memo.get(key)?.subs ?? [];
  void proj; // listNative 的返回是主会话半边，这里只要它跑完（memo 已写含 subs）
  return toSessionInfos(subs, cwd, limit);
}

/** 子会话秒出（同 peekListSessions 口径） */
export function peekSubagentSessions(cwd?: string, limit = 50): SessionInfo[] | null {
  const hit = memo.get((cwd ? "cwd:" + cwd : "all") + "|dir:" + (configuredSessionDir() ?? ""));
  if (!hit) return null;
  return toSessionInfos(hit.subs, cwd, limit);
}

/** 列出历史会话，按最近使用排序；传 cwd 只列该项目的会话。数据源 = pi 原生（见头注释）。
 *  onProgress 第三参 = 已就绪的展示条目（pi partialSessions 投影而来），到达即可上屏 */
export async function listSessions(
  cwd?: string,
  limit = 50,
  onProgress?: (loaded: number, total: number, partial?: SessionInfo[]) => void
): Promise<SessionInfo[]> {
  return toSessionInfos(
    await listNative(
      cwd,
      onProgress
        ? (loaded, total, partial) =>
            onProgress(loaded, total, partial ? toSessionInfos(partial, cwd, limit) : undefined)
        : undefined
    ),
    cwd,
    limit
  );
}
