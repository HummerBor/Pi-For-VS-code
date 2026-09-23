/**
 * sessionScan —— 会话列表同步快扫（R′刀，2026-09-23）。
 *
 * 背景（交接-启动慢战役.md §一.1 第二受害面）：pi 的 SessionManager.listAll 全量解析走
 * 异步 fs，撞本机扩展宿主的服务通道闸（实测 listSessions 31~38s/次，占位「正在加载会话…」
 * 半分钟出不来）；而同步读免疫该闸（Z2/Z3 实锤：挨刀时刻 readFileSync/statSync 0~2ms，
 * 慢的只有异步过线程池的活）。本模块用 statSync+readFileSync 只读每个会话文件头 32KB/
 * 尾 8KB，出与 pi listAll 同形的轻量投影，几十个文件 ≈50ms 秒出列。
 *
 * 壳原则记账：这是 pi API 在本机执行环境不可用（38s 级）下的绕行快路径，先例=R 刀历史
 * 直读会话文件渲染（用户拍板）；pi 的 listAll 仍是权威真身（panel 后台刷新替换投影）。
 * 正主（服务通道闸）归案后可退化回纯 listAll，本模块随之清点回收。
 *
 * 语义逐项镜像 pi 的 buildSessionInfo（session-manager.js:493），别「顺手优化」：
 * - 首条有效 entry 非 type:"session" → 整个文件弃（返回 null）
 * - name = 最新的 session_info.name?.trim() || undefined（含显式清空语义；全文件扫描——
 *   自动命名可落在数百 KB 处（实测 offset 610571），头/尾窥探被对照测试打脸过，别退回去）
 * - firstMessage = 首条 role:"user" 且文本非空的消息文本，兜底 "(no messages)"（首条 user
 *   行可含代码上下文附件长达 58KB，必须流式整行拼齐再 parse，固定头块会切行丢文本）
 * - 文本抽取：string 直取；数组取 type:"text" 块的 text 以空格拼接
 * - modified = 消息活动时间（末尾 message 候选行的 timestamp 取最大；append 追加即末条
 *   最大），兜底链 header.timestamp → stat mtime，与 pi 同形（stat mtime 会被文件搬迁/
 *   复制改写，实测差 5 天，弃用）
 *
 * 本模块禁 import vscode（裸进程可测：scripts/test-listfast.mjs 与 pi listAll 逐项对照）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";

/** 与 pi SessionInfo 投影同形的轻量五字段（panel 的 PiSessionProjection 结构兼容） */
export interface SessionProjection {
  path: string;
  cwd: string;
  name: string | undefined;
  firstMessage: string;
  modified: Date;
}

/** 镜像 pi 的 extractTextContent（session-manager.js:469） */
function extractTextFast(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b && b.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join(" ");
}

/** 窥探正则（行首锚定 + 允许空白）：老版本 pi 写的 jsonl 是空格化 JSON（{"type": "session"…，
 *  实测样本 2026-09-07T07-14 那份），紧凑窥探串会整个文件失配（对照测试抓的最后一个偏差）。
 *  行首锚定比全行 indexOf 便宜：含代码上下文的超长消息行（58KB+）不再整行扫。 */
const RE_MSG_LINE = /^\s*\{\s*"type"\s*:\s*"message"/;
const RE_INFO_LINE = /^\s*\{\s*"type"\s*:\s*"session_info"/;
const RE_ROLE_USER = /"role"\s*:\s*"user"/;

/** 扫描结果缓存：path+size+mtimeMs 命中即回（会话文件不常变，重复打开零成本） */
const scanCache = new Map<string, { size: number; mtimeMs: number; proj: SessionProjection | null }>();

/** 镜像 pi 的 getMessageActivityTime（session-manager.js:479） */
function activityTimeFast(entry: any): number | undefined {
  const m = entry?.message;
  const mt = m?.timestamp;
  if (typeof mt === "number") return mt;
  const t = new Date(entry.timestamp).getTime();
  return Number.isNaN(t) ? undefined : t;
}

export function scanOneSessionSync(file: string): SessionProjection | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = st.size + ":" + st.mtimeMs;
  const hit = scanCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.proj;
  const proj = scanOneUncached(file, st);
  scanCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, proj });
  return proj;
}

/** 单文件快扫（v2 整文件廉价扫描）：流式读入逐行**字符串窥探**，只对关键行 JSON.parse
 *  （session_info 行/首条 user 消息行/末尾 3 条 message 候选），代价 ≈ 纯 I/O + 字符串扫描。
 *  v1 头32KB+尾 8KB 版被 scripts/test-listfast.mjs 当场打脸三处（教训在头注释，别退回去）。
 *  消息活动时间只取末尾候选：append 追加即末条 timestamp 最大，免全量 parse（权威路径的
 *  1815ms 就是全量 parse 的代价）；末 3 条容噪声行（会话正文里出现同名字串的假阳性）。 */
function scanOneUncached(file: string, st: fs.Stats): SessionProjection | null {
  let header: any = null; // false = 首条有效 entry 非 session 头，整个文件弃
  let name: string | undefined;
  let firstMessage = "";
  const msgCandidates: string[] = [];
  const handleLine = (ln: string): void => {
    if (!ln.trim() || header === false) return;
    if (!header) {
      let e0: any;
      try {
        e0 = JSON.parse(ln);
      } catch {
        return; // 坏行跳过，与 pi 的 parseSessionEntryLine 同宽
      }
      header = e0 && e0.type === "session" ? e0 : false;
      return;
    }
    if (RE_MSG_LINE.test(ln)) {
      msgCandidates.push(ln);
      if (msgCandidates.length > 3) msgCandidates.shift();
      if (!firstMessage && RE_ROLE_USER.test(ln)) {
        try {
          const e = JSON.parse(ln);
          if (e && e.type === "message" && e.message?.role === "user") {
            const t = extractTextFast(e.message);
            if (t) firstMessage = t;
          }
        } catch { /* 超长坏行不致命 */ }
      }
    }
    if (RE_INFO_LINE.test(ln)) {
      try {
        const e = JSON.parse(ln);
        if (e && e.type === "session_info") {
          name = (typeof e.name === "string" ? e.name.trim() : "") || undefined;
        }
      } catch { /* ignore */ }
    }
  };
  try {
    const fd = fs.openSync(file, "r");
    try {
      const dec = new StringDecoder("utf8"); // chunk 边界切多字节 UTF-8 防乱码
      const chunk = Buffer.alloc(262144);
      let carry = "";
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (n <= 0) break;
        const text = carry + dec.write(chunk.subarray(0, n));
        let start = 0;
        let idx: number;
        while ((idx = text.indexOf("\n", start)) >= 0) {
          handleLine(text.slice(start, idx));
          start = idx + 1;
        }
        carry = text.slice(start);
      }
      handleLine(carry + dec.end()); // 末行无换行符时改由这里送出
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null; // 读失败与 pi 的 buildSessionInfo 同宽：弃
  }
  if (header === false || !header) return null;
  // 消息活动时间：末尾候选行取最大（镜像 pi 的 Math.max 语义，append 追加即末条最大）
  let maxAct = 0;
  for (let i = msgCandidates.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(msgCandidates[i]);
      if (!e || e.type !== "message" || !e.message) continue;
      if (e.message.role !== "user" && e.message.role !== "assistant") continue;
      const t = activityTimeFast(e);
      if (typeof t === "number" && t > maxAct) maxAct = t;
    } catch { /* 噪声候选行跳过 */ }
  }
  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
  const modified = maxAct > 0 ? new Date(maxAct) : !Number.isNaN(headerTime) ? new Date(headerTime) : st.mtime;
  return {
    path: file,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    firstMessage: firstMessage || "(no messages)",
    modified,
  };
}

/** 全量快扫：目录枚举镜像 pi listAll（sessions/项目别名/xxx.jsonl 两层，.jsonl 全收） */
export function listAllSyncFast(): SessionProjection[] {
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const out: SessionProjection[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dirs) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(root, d.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const info = scanOneSessionSync(path.join(root, d.name, f));
      if (info) out.push(info);
    }
  }
  return out;
}

/** 会话目录文件集指纹（哈希口径逐字符沿用工单十三二刀-5 原版：递归收集 .jsonl 的
 *  路径+mtime 进 FNV-1a + 文件数）。R′刀改同步实现：原异步 walk/stat 同样过 libuv
 *  线程池，撞服务闸时几十个 stat 各等 2~8s，光指纹就能把列表卡死——statSync 免疫。 */
export function fingerprintSessionsSync(): string {
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const files: string[] = [];
  const walk = (dir: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限 → 空指纹，安全
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root);
  let h1 = 2166136261; // FNV-1a 32 位 offset basis
  for (const file of files) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      // stat 失败（文件刚被删/无权限）→ mtime 记 0，指纹必变 → 强制重算，安全
    }
    const tag = file + ":" + mtime + ";";
    for (let i = 0; i < tag.length; i++) {
      h1 ^= tag.charCodeAt(i);
      h1 = (h1 * 16777619) & 0xffffffff; // FNV 素数，& 保持 32 位
    }
  }
  return files.length + ":" + h1; // 文件数也进指纹，防碰撞
}
