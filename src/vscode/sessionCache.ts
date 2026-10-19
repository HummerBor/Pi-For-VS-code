/**
 * sessionCache —— 会话列表展示缓存层（刀 C 第二簇自 panel.ts 搬出）。
 *
 * 搬运纪律（同工单四 piCore / 刀 C 第一簇 changes.ts）：函数体自 panel.ts 逐字符搬运、
 * 行为零变化。职责：会话目录「指纹单槽缓存 + mtime 展示缓存 + 投影→展示条目变换」。
 * pickSession 秒开快路径与后台权威刷新共用**同一 result 引用**判断列表是否变（见
 * peekListAllSlot 头注释），这是本簇的核心语义，拆分时必须保持引用相等不变。
 */
import { fingerprintSessionsSync, listAllFastYielded } from "../domain/sessionScan";
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

/** 模块级会话展示缓存（工单十三-4，UI 层职责放 panel 模块级，不进 PiCore）：
 *  mtime 未变视为内容未改动，直接复用缓存的 SessionInfo，免重建展示对象。
 *  删除会话后残留条无害：缓存按 key=file 惰性覆盖，文件不在列表即不被引用。 */
const sessionMetaCache = new Map<string, { mtimeMs: number; meta: SessionInfo }>();

/** 指纹缓存（工单十三二刀-5 补修）：**单槽** {fp, result}——指纹变即作废，永远只留最新
 *  一份（原 Map 每换指纹新增条目，而 pi 每发消息必改 mtime → 指纹连变 → 聊 50 轮滞留
 *  50 份 → ext host OOM）。只存轻量投影（path/cwd/name/firstMessage/modified 五字段），
 *  弃 allMessagesText——listAll 每会话携带全会话文本拼接的重串（session-manager.js 实证
 *  单次几十上百 MB），整枚缓存直接内存爆炸。投影后降 KB 级；面板重开不失效（模块级），
 *  扩展重载失效（可接受）。PiSessionEntry 类型内联 import 保留（零运行时依赖，类型参考
 *  正确做法）。 */
type PiSessionEntry = import("@earendil-works/pi-coding-agent").SessionInfo;
/** 展示链唯一需要的投影字段（轻量缓存用，allMessagesText 等重串不进来） */
export type PiSessionProjection = Pick<PiSessionEntry, "path" | "cwd" | "name" | "firstMessage" | "modified">;
let listAllSlot: { fp: string; result: PiSessionProjection[] } | null = null;

/** 会话目录文件集指纹：实现已迁 sessionScan.ts（fingerprintSessionsSync，R′刀改同步——
 *  原异步 walk/stat 同样过 libuv 线程池，撞服务闸时几十个 stat 各等 2~8s，光指纹就能把
 *  列表卡死）；哈希口径逐字符保持不变。自研扫描备胎随 R′刀回归：listAllSyncFast 同模块。 */

/** listAll 指纹单槽缓存入口（R′刀重排）：指纹命中返回缓存投影（真毫秒级）；未命中先
 *  同步快扫立回（sessionScan.listAllSyncFast，服务闸免疫，几十文件 ≈50ms），后台补 pi
 *  全量权威解析入槽——快/慢两路共用 toSessionInfos，展示零漂移。权威解析去重并发
 *  （撞闸时 38s 的活不许叠跑），失败静默（快照继续服务）。调用方无需关心缓存细节。 */
let listAllRefreshInFlight = false;
/** 快扫在途去重（2026-10-19「点多次会话列表才有数据」事故）：连点 N 次 = N 路快扫并发
 *  互相排队（实测 4 路把 13s 拖成 29s，用户以为「要多点几次才出数据」）。在途快扫共享
 *  同一 promise：N 次点击只扫一遍，后到的立即挂同一结果 */
let fastScanInFlight: Promise<PiSessionProjection[]> | null = null;
export async function listAllCached(): Promise<PiSessionProjection[]> {
  const fp = fingerprintSessionsSync();
  if (listAllSlot && listAllSlot.fp === fp) return listAllSlot.result;
  if (!fastScanInFlight) {
    fastScanInFlight = (async () => {
      try {
        const fast = await listAllFastYielded();
        listAllSlot = { fp, result: fast };
        return fast;
      } finally {
        fastScanInFlight = null;
      }
    })();
  }
  const fast = await fastScanInFlight;
  if (!listAllRefreshInFlight) {
    listAllRefreshInFlight = true;
    void (async () => {
      try {
        const sdk = await loadPiSdk();
        const fresh = (await sdk.SessionManager.listAll()) as PiSessionEntry[];
        // 解析期间可能又有活动 → 重取指纹与新投影配对入槽，下次打开自然校验
        listAllSlot = {
          fp: fingerprintSessionsSync(),
          result: fresh.map((x) => ({
            path: x.path,
            cwd: x.cwd,
            name: x.name,
            firstMessage: x.firstMessage,
            modified: x.modified,
          })),
        };
      } catch { /* 权威刷新失败不打扰用户：快照继续服务 */ }
      listAllRefreshInFlight = false;
    })();
  }
  return fast;
}

/** 投影→展示条目变换（cwd 过滤 + mtime 缓存复用 + 按最近使用排序 + 截断）。
 *  工单十九从 listSessions 抽出：pickSession 秒开快路径要对缓存槽里的投影做**同一套**
 *  变换，抽成纯函数保证快/慢两条路径的 scope 过滤与排序行为永远一致，不各写一份漂移。 */
export function toSessionInfos(
  entries: PiSessionProjection[],
  cwd?: string,
  limit = 50
): SessionInfo[] {
  const result: SessionInfo[] = [];
  for (const e of entries) {
    if (cwd && !samePath(e.cwd, cwd)) continue; // 只保留属于该项目的会话（pi 的 list 不做项目过滤）
    const file = e.path;
    const mtime = e.modified.getTime();
    const hit = sessionMetaCache.get(file);
    let info: SessionInfo;
    if (hit && hit.mtimeMs === mtime) {
      info = hit.meta; // mtime 未变 → 复用缓存（免重建展示对象；解析已由 listAll 扛）
    } else {
      info = {
        file,
        mtime,
        time: new Date(mtime).toLocaleString(),
        cwd: e.cwd ?? "",
        preview: (e.firstMessage || "").slice(0, 60),
        name: e.name,
      };
      sessionMetaCache.set(file, { mtimeMs: mtime, meta: info });
    }
    result.push(info);
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, limit);
}

/** 列出历史会话，按最近使用排序；传入 cwd 则只保留属于该项目的会话（异步，工单十三）。
 *  工单十三二刀-4/5：主路径改用 pi 公开 API SessionManager.listAll()（pi -r 同款，10 路
 *  并发全量解析，字段白拿，格式变更 pi 自己扛），按 cwd 的 samePath 过滤（pi 的 list 不做
 *  项目过滤）；刀 5 指纹缓存包在外——指纹命中直接复用上次 listAll 结果（免 700ms 全量解析），
 *  未命中才 listAll 并填缓存。展示层 mtime 缓存（key=file）照旧免重建。 */
export async function listSessions(cwd?: string, limit = 50): Promise<SessionInfo[]> {
  return toSessionInfos(await listAllCached(), cwd, limit);
}


/** 读缓存槽当前 result（刀 C 第二簇胶水）：pickSession 秒开快路径拿它立即出列表，并与
 *  listAllCached 后台返回值做**引用相等**比较（同一 result = 指纹命中 = 列表未变，免重绘）。
 *  必须返回同一数组引用，勿拷贝——拷贝会破坏 `fresh === cachedResult` 的「列表未变」判断。 */
export function peekListAllSlot(): PiSessionProjection[] | null {
  return listAllSlot ? listAllSlot.result : null;
}
