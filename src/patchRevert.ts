/**
 * 统一 patch 逆向还原（工单七，裁决 11③）。
 *
 * pi edit 工具的 result.details.patch 由 jsdiff createTwoFilesPatch 生成（LF 归一化、
 * 标准 unified 格式，与 pi 同款 BOM/EOL 处理见 edit.js：去 BOM → LF diff → 还原 EOL）。
 * 本模块把「同一文件本次 run 内按时间顺序累积的 patch 链」逆序逆向打回，
 * 无需 git 基线即可还原未跟踪文件——这是 write 工具（无 result 详情）做不到的，
 * 也是裁决 11③「write 碰过的一律不可还原」的原因。
 *
 * 铁律：逆向失败一律返回 null（调用方只能报「不可还原」），绝不硬打——
 * 打错比不还原严重得多（破坏性操作红线，同 deleteSession 守卫规格）。
 */

/** 一行一类 */
type LineKind = " " | "-" | "+";

interface Hunk {
  /** patch 里声明的新文件起始行（1 基；0 表示原文件为空） */
  newStart: number;
  /** 按出现顺序的行：kind + 文本 */
  lines: { kind: LineKind; text: string }[];
  /** \ No newline at end of file 标记跟随的 + 行索引（新文件侧末行无换行符） */
  noNewlineAt: number[];
}

/** 去掉文件内容 BOM（与 pi edit.js 同款处理：BOM 不参与 diff） */
function splitBom(text: string): { bom: string; text: string } {
  return text.charCodeAt(0) === 0xfeff ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

/** 解析 patch 文本为 hunk 列表；格式不认识返回 null（保守失败） */
function parsePatch(patch: string): Hunk[] | null {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let lastPlusIdx = -1;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@")) {
      // @@ -a,b +c,d @@ ...（jsdiff 单行时省略 ",1"；新文件起始为 0）
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) return null;
      cur = { newStart: parseInt(m[1], 10), lines: [], noNewlineAt: [] };
      hunks.push(cur);
      lastPlusIdx = -1;
      continue;
    }
    if (!cur) continue; // 头部（===/---/+++）与 FILE 头之前的内容全部忽略
    if (line.startsWith("\\ No newline at end of file")) {
      // jsdiff 在缺少行尾换行的行之后输出此标记；逆向时它修饰最近的 + 行
      if (lastPlusIdx >= 0) cur.noNewlineAt.push(lastPlusIdx);
      continue;
    }
    const kind = line.charAt(0);
    if (kind === " " || kind === "-" || kind === "+") {
      const idx = cur.lines.length;
      cur.lines.push({ kind, text: line.slice(1) });
      if (kind === "+") lastPlusIdx = idx;
    }
    // 其余行（空行等）忽略——unified patch 行不会以其他字符开头，防御性跳过
  }
  return hunks.length ? hunks : null;
}

export interface ReverseApplyResult {
  ok: boolean;
  /** 还原后的完整内容（含 BOM/原 EOL）；ok=false 时为 null */
  content: string | null;
  /** 失败原因（面向 dbg/通知的短描述） */
  reason?: string;
}

/**
 * 把一枚 patch 逆向打回：content（patch 应用后的新状态）→ patch 应用前的旧状态。
 * 同一文件多枚 patch 时必须从最后一枚开始按时间倒序逐枚调用。
 */
export function reverseApplyPatch(content: string, patch: string): ReverseApplyResult {
  const { bom, text } = splitBom(content);
  // patch 由 LF 归一化内容生成：内容先归一到 LF，打完再还原原 EOL（与 pi edit 同款）
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hadTrailingNewline) lines.pop(); // split 产生的尾部空串不是真行

  const hunks = parsePatch(patch);
  if (!hunks) return { ok: false, content: null, reason: "patch parse failed" };

  // 从最后一个 hunk 往前打：只改靠后的行，靠前 hunk 的行号不受影响
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h];
    // 逆向定位：当前内容（新状态）= context 与 + 行；要还原成 context 与 - 行。
    // hunk.newStart 是新文件侧 1 基行号（0 表示旧文件为空，逆向时从内容首行开始）
    const expect: string[] = [];
    const restored: string[] = [];
    for (const l of hunk.lines) {
      if (l.kind !== "-") expect.push(l.text); // context 与 + 行都应出现在当前内容
      if (l.kind !== "+") restored.push(l.text); // 打回后的旧内容区间
    }
    // 定位：hunk.newStart 是 1 基行号；仅 context 行时 hunk 可能整体是「纯上下文」（无变化）——跳过
    const hasChange = hunk.lines.some((l) => l.kind !== " ");
    if (!hasChange) continue;
    const at = hunk.newStart > 0 ? hunk.newStart - 1 : 0; // 0 基
    // 定位替换：expect 区间 → restored 区间（行数不必相等）
    if (at < 0 || at + expect.length > lines.length) {
      return { ok: false, content: null, reason: `hunk out of range (line ${hunk.newStart})` };
    }
    for (let i = 0; i < expect.length; i++) {
      if (lines[at + i] !== expect[i]) {
        return {
          ok: false,
          content: null,
          reason: `mismatch at line ${hunk.newStart + i}: expected ${JSON.stringify(expect[i])}`,
        };
      }
    }
    lines.splice(at, expect.length, ...restored);
  }

  // 末行换行符：任一 hunk 声明其 + 行无行尾换行 → 打回后（+ 行被剔除）以 -/context 行为准，
  // jsdiff 只对缺失换行的最终行打标记；保守起见：patch 带标记且打回结果由非 + 行收尾时不强加换行。
  const anyNoNewline = hunks.some((hk) => hk.noNewlineAt.length > 0);
  let result = lines.join("\n");
  if (!anyNoNewline && hadTrailingNewline) result += "\n";
  return { ok: true, content: bom + result.replace(/\n/g, eol === "\r\n" ? "\r\n" : "\n") };
}
