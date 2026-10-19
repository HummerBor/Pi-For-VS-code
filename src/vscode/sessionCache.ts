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

export interface SessionInfo {
  file: string;
  name?: string;
  cwd: string;
  preview: string;
  mtime: number;
  time: string;
}

/** 路径相等判断（忽略大小写和分隔符差异，Windows 友好） */
export function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) =>
    p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** pi 的 SessionInfo 类型（内联 import：零运行时依赖，类型参考的正确做法） */
type PiSessionEntry = import("@earendil-works/pi-coding-agent").SessionInfo;
/** 展示链需要的轻量字段（allMessagesText 之类重串不进展示层） */
export type PiSessionProjection = Pick<PiSessionEntry, "path" | "cwd" | "name" | "firstMessage" | "modified">;

/** 查询应答复用（2026-10-19 用户「每次点击都重扫？」拍板）：同一查询在 TTL 内直接复用，
 *  不再每次付 pi listAll 的 1~2s 全量解析。【这不是记录副本】不落盘、不留派生真相——
 *  会话 jsonl 仍是唯一记录（审计红线），这里只是「别重复问同一个问题」的应答缓存：
 *  TTL 一到照常问 pi，已知变更（删会话）处显式失效。早前的错误是把同类数据**落盘**
 *  + 自研第二套扫描器，不是缓存本身 */
const LIST_MEMO_TTL_MS = 10_000;
const memo = new Map<string, { at: number; result: PiSessionProjection[] }>();
/** 已知变更处立即失效（删除会话后列表不能再拖 10s 旧账） */
export function invalidateListMemo(): void {
  memo.clear();
}

/** pi 原生列表调用 + 在途合并 + 应答复用。scope 两级：cwd=项目内（pi list）、
 *  不传=全量（listAll）。进度回调透传 pi 的 onProgress（loaded/total），
 *  展示层拿去做活的加载进度（pi -r 同款体验） */
const inFlight = new Map<string, Promise<PiSessionProjection[]>>();
export function listNative(
  cwd?: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<PiSessionProjection[]> {
  const key = cwd ? "cwd:" + cwd : "all";
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < LIST_MEMO_TTL_MS) return Promise.resolve(hit.result);
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const sdk = await loadPiSdk();
      const entries = (cwd
        ? await sdk.SessionManager.list(cwd, undefined, onProgress)
        : await sdk.SessionManager.listAll(onProgress)) as PiSessionEntry[];
      const result: PiSessionProjection[] = entries.map((x) => ({
        path: x.path,
        cwd: x.cwd,
        name: x.name,
        firstMessage: x.firstMessage,
        modified: x.modified,
      }));
      memo.set(key, { at: Date.now(), result });
      return result;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
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
      time: new Date(mtime).toLocaleString(),
      cwd: e.cwd ?? "",
      preview: (e.firstMessage || "").slice(0, 60),
      name: e.name,
    });
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, limit);
}

/** 列出历史会话，按最近使用排序；传 cwd 只列该项目的会话。数据源 = pi 原生（见头注释） */
export async function listSessions(
  cwd?: string,
  limit = 50,
  onProgress?: (loaded: number, total: number) => void
): Promise<SessionInfo[]> {
  return toSessionInfos(await listNative(cwd, onProgress), cwd, limit);
}
