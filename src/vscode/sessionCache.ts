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
import * as fs from "fs";
import { join } from "path";

export interface SessionInfo {
  file: string;
  name?: string;
  cwd: string;
  preview: string;
  mtime: number;
  time: string;
}

/** 路径相等判断（忽略大小写和分隔符差异，Windows 友好）。
 *  实现归位 domain/pathKey.ts（2026-11-03 债2）：core 层（台账 parentSession 对账）也要用，
 *  而 core 不许 import 宿主层。类型守卫保留原语义：菜单/命令参数可能误传对象
 *  （2026-10-19 deleteSession 传入 SessionItem → p.replace is not a function），
 *  非字符串一律不等，不炸调用方 */
import { samePath } from "../domain/pathKey";
export { samePath };

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
 *
 *  【为什么不能让 pi 扫】实测：SessionManager.listAll 不认 subagents/ 目录——407 条会话、
 *  subs=0（2026-11-02 实捞）。而 list(cwd) 只扫 cwd 映射目录，更扫不到。所以目录发现
 *  这一层必须自己做；解析仍用 pi 原生 parseSessionEntries（版本迁移/兼容它管）。
 *  这与「能用原生就用」不冲突：原生没有这个能力，壳补的只是「找目录 + 读元数据」。
 *
 *  只读每个文件头部 256KB（header + session_info + 首条消息都在前几行，实测 sa-9 在
 *  第 2 行）——长转录会话动辄几 MB，为拿个标题读全文件不值得。 */
async function scanSubagentSessions(): Promise<PiSessionProjection[]> {
  const sdk = await loadPiSdk();
  const agentDir: string | undefined = sdk.getAgentDir?.();
  if (!agentDir) return [];
  const base = join(agentDir, "sessions", "subagents");
  try {
    fs.readdirSync(base);
  } catch {
    return []; // 还没派过子 agent
  }
  const out: PiSessionProjection[] = [];
  // 两种布局共存（2026-11-02 按项目分桶）：新 `subagents/<项目slug>/<handle>/`，
  // 旧 `subagents/<handle>/` 继续可读——老单不迁移（文件是审计真值，不动）。
  // 递归找（2026-11-03）：分桶名曾经带反斜杠，真的建成多层目录（--d-/work/docs/…/sa-11），
  // 只扫一层就整段看不见。桶层级不限深度，认目录名 sa-N 即可
  const handleDirs: string[] = [];
  const collect = (dir: string, depth: number): void => {
    if (depth > 6) return; // 深度护栏：别被奇怪的深浅目录拖死
    let names2: string[];
    try {
      names2 = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names2) {
      if (n === "runs") continue; // 台账目录：不是会话
      const p = join(dir, n);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      if (/^sa-\d+$/.test(n)) handleDirs.push(p);
      else collect(p, depth + 1);
    }
  };
  collect(base, 0);
  for (const dir of handleDirs) {
    let cands: { f: string; t: number }[];
    try {
      cands = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl") && f !== "frames.jsonl")
        .map((f) => ({ f, t: fs.statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch {
      continue;
    }
    if (!cands.length) continue;
    const file = join(dir, cands[0].f);
    try {
      const buf = fs.readFileSync(file);
      const head = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString("utf8");
      const cut = head.lastIndexOf("\n");
      const text = cut > 0 ? head.slice(0, cut) : head; // 截断的半行丢掉（parse 会报）
      const entries = (sdk.parseSessionEntries?.(text) ?? []) as Record<string, any>[];
      const header = entries.find((e) => e.type === "session");
      // 名字取最后一处 session_info（用户 /name 改过就以最新为准）；头部窗口内找不到就留空
      let name: string | undefined;
      for (const e of entries) if (e.type === "session_info" && e.name?.trim()) name = String(e.name).trim();
      const firstUser = entries.find((e) => e.type === "message" && e.message?.role === "user");
      const fm = firstUser?.message?.content;
      const firstMessage =
        typeof fm === "string"
          ? fm
          : Array.isArray(fm)
            ? fm.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).join(" ")
            : "";
      out.push({
        path: file,
        cwd: typeof header?.cwd === "string" ? header.cwd : "",
        name,
        firstMessage,
        modified: new Date(cands[0].t),
      });
    } catch {
      continue; // 烂文件/正在写：跳过不阻列表
    }
  }
  return out;
}

export async function listSubagentSessions(cwd?: string, limit = 50): Promise<SessionInfo[]> {
  const subs = await scanSubagentSessions().catch(() => []);
  return toSessionInfos(subs, cwd, limit);
}

/** handle → 派单方会话文件（2026-11-02 左侧列表父子分组用）。
 *  数据源 = harness 台账（runs/<handle>.json 的 parentSession）；无台账/老记录缺席。 */
export async function subagentParentMap(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const sdk = await loadPiSdk();
    const agentDir: string | undefined = sdk.getAgentDir?.();
    if (!agentDir) return out;
    const dir = join(agentDir, "sessions", "subagents", "runs");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
        const handle = String(rec.handle ?? "");
        const parent = rec.parentSession;
        if (/^sa-\d+$/.test(handle) && typeof parent === "string" && parent) out.set(handle, parent);
      } catch {
        /* 烂 JSON 跳过 */
      }
    }
  } catch {
    /* 台账不可读：全部归「未归属」 */
  }
  return out;
}

/** 从子会话文件路径反推句柄（.../subagents/[<slug>/]<handle>/xxx.jsonl → sa-N）。
 *  【深度不设上限 2026-11-03】原来只容一层桶。projectSlug 当时没换反斜杠，Windows 上
 *  真实落盘是 subagents/--d-/work/docs/…/sa-11/ 这种多级嵌套——正则匹配不上，句柄取不到，
 *  左侧父子归属直接失效。桶层级爱多深多深，只要路径里有 sa-N 就行 */
export function handleFromSubPath(file: string): string | undefined {
  const m = /[\\/]subagents[\\/](?:[^\\/]+[\\/])*(sa-\d+)[\\/]/.exec(file);
  return m?.[1];
}

/** 子会话秒出：扫描本身很轻（每单只读头部 256KB），不做 memo——子会话数量小且
 *  随时新增（派单即出），缓存反而让人以为「刚派的没出现」 */
export async function peekSubagentSessions(cwd?: string, limit = 50): Promise<SessionInfo[] | null> {
  try {
    return toSessionInfos(await scanSubagentSessions(), cwd, limit);
  } catch {
    return null;
  }
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
