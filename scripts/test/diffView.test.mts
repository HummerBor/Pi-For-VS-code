/**
 * diffView 用例（变更页 2026-11-05）：unified hunk → 并排行。
 *
 * 把守三件事：① 行号按 @@ 头起算、上下文两侧同步递增；② 连续 -/+ 段一一配对、
 * 多出侧留空（左右行数恒等 = 并排不错行）；③ 尾部空串/`\ No newline` 标记不占行。
 *
 * 运行：npm run test:diffview（Node ≥23.6 原生跑 TS，零依赖，不进 tsc 门禁）
 */
import assert from "node:assert";
import { parseUnifiedDiff, type DiffRow } from "../../src/domain/diffView.ts";

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n++;
  console.log("  ✓ " + name);
}

/** 行序列压缩成可断言的字面量：[类型, 左行号|'-', 右行号|'-'] */
function shape(rows: DiffRow[]): string[] {
  return rows.map((r) =>
    r.kind === "hunk" ? "H" : (r.left ? r.left.no : "-") + "|" + (r.right ? r.right.no : "-")
  );
}

console.log("diffView:");

ok("上下文两侧行号同步递增", () => {
  const rows = parseUnifiedDiff("@@ -3,3 +3,3 @@\n a\n b\n c\n");
  assert.deepStrictEqual(shape(rows), ["H", "3|3", "4|4", "5|5"]);
});

ok("连续 -/+ 按序配对，多出的删行留空右侧", () => {
  const rows = parseUnifiedDiff("@@ -1,3 +1,2 @@\n-a\n-b\n+A\n c\n");
  // -a/-b 配 +A → 第一行 a↔A，第二行 b↔空；c 是上下文
  assert.deepStrictEqual(shape(rows), ["H", "1|1", "2|-", "3|2"]);
  const pair = rows[1] as Extract<DiffRow, { kind: "line" }>;
  assert.strictEqual(pair.changed, true);
  assert.strictEqual(pair.left?.text, "a");
  assert.strictEqual(pair.right?.text, "A");
  const orphan = rows[2] as Extract<DiffRow, { kind: "line" }>;
  assert.strictEqual(orphan.right, null);
});

ok("多出的增行留空左侧", () => {
  const rows = parseUnifiedDiff("@@ -1,1 +1,3 @@\n-a\n+A\n+B\n+C\n");
  assert.deepStrictEqual(shape(rows), ["H", "1|1", "-|2", "-|3"]);
});

ok("尾部空串与 no-newline 标记不占行", () => {
  const rows = parseUnifiedDiff("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a\n\\ No newline at end of file\n");
  assert.deepStrictEqual(shape(rows), ["H", "1|1"]);
});

ok("多 hunk 各自重新起算行号", () => {
  const rows = parseUnifiedDiff(
    "@@ -10,1 +10,1 @@\n-x\n+y\n@@ -40,1 +41,1 @@\n-m\n+n\n"
  );
  assert.deepStrictEqual(shape(rows), ["H", "10|10", "H", "40|41"]);
});

ok("空文本 / 纯文件头 = 零行（不猜内容）", () => {
  assert.deepStrictEqual(parseUnifiedDiff(""), []);
  assert.deepStrictEqual(parseUnifiedDiff("--- a/x\n+++ b/x\n"), []);
});

ok("零上下文 hunk（新增文件 @@ -0,0 +1,N @@）", () => {
  const rows = parseUnifiedDiff("@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.deepStrictEqual(shape(rows), ["H", "-|1", "-|2"]);
});

console.log("diffView: " + n + " passed");
