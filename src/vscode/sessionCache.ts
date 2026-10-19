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
 * 保留的只有一条：**在途合并**（同 scope 并发共享同一 promise）。那不是缓存
 * （跑完不留任何状态），是并发卫生：用户连点 N 次不该起 N 个 pi listAll 各自解析
 * 几百 MB（实测把 2s 拖成 22s，见 panel-load.test 第⑥把锁）。
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

/** pi 原生列表调用 + 在途合并。scope 两级：cwd=项目内（pi list）、不传=全量（listAll）。
 *  进度回调透传 pi 的 onProgress（loaded/total），展示层拿去做活的加载进度（pi -r 同款体验） */
const inFlight = new Map<string, Promise<PiSessionProjection[]>>();
export function listNative(
  cwd?: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<PiSessionProjection[]> {
  const key = cwd ? "cwd:" + cwd : "all";
  const hit = inFlight.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const sdk = await loadPiSdk();
      const entries = (cwd
        ? await sdk.SessionManager.list(cwd, undefined, onProgress)
        : await sdk.SessionManager.listAll(onProgress)) as PiSessionEntry[];
      return entries.map((x) => ({
        path: x.path,
        cwd: x.cwd,
        name: x.name,
        firstMessage: x.firstMessage,
        modified: x.modified,
      }));
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
