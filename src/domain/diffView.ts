/**
 * diffView —— 变更页（2026-11-05）的纯逻辑叶：unified hunk 文本 → 并排行。
 *
 * 为什么单独成叶：渲染在 webview（DOM），但「哪些行配对、行号怎么数」是纯逻辑，
 * 放在 makeSessionView 闭包里就只能靠肉眼看。抽出来零 import（webview 共享编译无 node
 * 类型、node 裸跑用例靠相对导入 + 扩展名），webview 只做 DiffRow → DOM 的搬运。
 *
 * 输入约定：**hunk-only** 文本（宿主 changes.ts 已剥掉 `diff --git`/`index`/`---`/`+++`
 * 头部，git 与 patch 逆向两路统一成同一文法）。这里不认文件头，认到就跳过。
 *
 * 配对规则（GitHub 同款）：同一 hunk 内连续的 `-` 段与 `+` 段按出现顺序一一配对，
 * 多出来的一侧留 null 占位——所以并排视图左右行数恒等，不会错行。
 */

/** 单侧一行：行号 + 原文（不含行首标记） */
export interface DiffLine {
  no: number;
  text: string;
}

/** 渲染行：hunk 头（@@ 行）或一对比对行（left/right 可为 null = 该侧留空） */
export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "line"; left: DiffLine | null; right: DiffLine | null; changed: boolean };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 解析 hunk 文本为可渲染行序列。非 hunk 行（文件头等）一律跳过，不猜内容。 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const out: DiffRow[] = [];
  const lines = String(diff ?? "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }
    out.push({ kind: "hunk", text: line });
    const m = HUNK_RE.exec(line);
    let oldNo = m ? parseInt(m[1], 10) : 1;
    let newNo = m ? parseInt(m[3], 10) : 1;
    let dels: DiffLine[] = [];
    let ins: DiffLine[] = [];
    const flush = (): void => {
      const n = Math.max(dels.length, ins.length);
      for (let k = 0; k < n; k++) {
        out.push({ kind: "line", left: dels[k] ?? null, right: ins[k] ?? null, changed: true });
      }
      dels = [];
      ins = [];
    };
    i++;
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const l = lines[i];
      // 尾部空串（文本以 \n 结尾时 split 的产物）不是内容行，别当上下文数进去
      if (l === "" && i === lines.length - 1) {
        i++;
        continue;
      }
      const tag = l.charAt(0);
      const body = l.slice(1);
      if (tag === "-") dels.push({ no: oldNo++, text: body });
      else if (tag === "+") ins.push({ no: newNo++, text: body });
      else if (tag === " ") {
        flush();
        out.push({ kind: "line", left: { no: oldNo++, text: body }, right: { no: newNo++, text: body }, changed: false });
      }
      // 其余（`\ No newline at end of file` 等）不占行：既不数行号也不渲染
      i++;
    }
    flush();
  }
  return out;
}
