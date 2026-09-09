/**
 * patchRevert 用例（工单七，裁决 11③ 配套）。
 *
 * 验证 src/patchRevert.ts 的逆向还原：用 pi 同款 jsdiff（createTwoFilesPatch，LF 归一化）
 * 生成真实 patch，对「内容 → patch」做逆向打回，断言回到原文。
 * 逆向失败必须返回 null（不得硬打），篡改内容/垃圾输入各有用例把守。
 *
 * 运行：npm run test:revert（Node ≥23.6 原生跑 TS，零自有依赖，不进 tsc 编译门禁；
 * jsdiff 借用 pi 包树内的依赖——pi 是运行前置，本用例只是复刻其 edit 工具的 patch 生成口径）
 */
import assert from "node:assert";
import { createRequire } from "node:module";
import { reverseApplyPatch } from "../src/patchRevert.ts";

const require = createRequire(import.meta.url);
// pi 包树内的 jsdiff（edit-diff.js 同款），仅测试期借用，不进 vsix
const Diff = require("../node_modules/@earendil-works/pi-coding-agent/node_modules/diff/libcjs/index.js");

/** 复刻 pi edit.js 的 patch 生成：去 BOM + LF 归一化后 createTwoFilesPatch */
function makePatch(oldText: string, newText: string): string {
  const strip = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).replace(/\r\n/g, "\n");
  return Diff.createTwoFilesPatch("f", "f", strip(oldText), strip(newText));
}

let passed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  assert.ok(cond, `用例失败: ${name}${detail ? " — " + detail : ""}`);
  passed++;
}

/* 第 1 组：单 patch 往返（多 hunk / 删行 / 插行 / 末尾追加） */
{
  const orig = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
  // 模拟 pi 编辑：改中部 + 删一行 + 末尾追加
  const edited = "alpha\nBETA\ngamma\nepsilon\nzeta\n";
  const patch = makePatch(orig, edited);
  const r = reverseApplyPatch(edited, patch);
  ok("单patch往返", r.ok && r.content === orig, r.content ? JSON.stringify(r.content) : r.reason);
}
{
  // 中部插入（新文件侧行数 > 旧）
  const orig = "a\nb\nc\n";
  const edited = "a\nx\ny\nb\nc\n";
  const r = reverseApplyPatch(edited, makePatch(orig, edited));
  ok("插行还原", r.ok && r.content === orig, r.content ?? r.reason);
}
{
  // 首行替换（hunk 从第 1 行开始）
  const orig = "one\ntwo\n";
  const edited = "ONE\ntwo\n";
  const r = reverseApplyPatch(edited, makePatch(orig, edited));
  ok("首行还原", r.ok && r.content === orig, r.content ?? r.reason);
}

/* 第 2 组：patch 链逆序（pi 场景：同一文件本次 run 被 edit 两次） */
{
  const v0 = "l1\nl2\nl3\nl4\nl5\n";
  const v1 = "l1\nEDIT1\nl3\nl4\nl5\n";
  const v2 = "l1\nEDIT1\nl3\nl4\nFIVE\n";
  const p1 = makePatch(v0, v1);
  const p2 = makePatch(v1, v2);
  // 逆序：先打 p2（v2→v1），再打 p1（v1→v0）
  const r1 = reverseApplyPatch(v2, p2);
  ok("链路第一步", r1.ok && r1.content === v1, r1.content ?? r1.reason);
  const r2 = reverseApplyPatch(r1.content!, p1);
  ok("链路第二步回到原文", r2.ok && r2.content === v0, r2.content ?? r2.reason);
}

/* 第 3 组：CRLF + BOM（pi edit 的 BOM/EOL 保留口径，逆向必须同样保真） */
{
  const orig = "\uFEFFh1\r\nh2\r\nh3\r\n";
  const edited = "\uFEFFh1\r\nH2\r\nh3\r\n";
  const patch = makePatch(orig, edited);
  const r = reverseApplyPatch(edited, patch);
  ok("CRLF+BOM往返", r.ok && r.content === orig, r.content ? JSON.stringify(r.content) : r.reason);
}

/* 第 4 组：篡改内容 → 拒打（裁决 11③：逆向失败只能报不可还原，不得硬打） */
{
  const orig = "a\nb\nc\n";
  const edited = "a\nB\nc\n";
  const patch = makePatch(orig, edited);
  const r = reverseApplyPatch("a\n被用户改过的行\nc\n", patch);
  ok("篡改拒打", !r.ok && r.content === null, `ok=${r.ok}`);
}
{
  // patch 链乱序（先打 p1 再打 p2 之类）由调用方保证顺序；这里验证单枚乱打必失败：
  const v0 = "1\n2\n3\n";
  const v1 = "1\nTWO\n3\n";
  const p1 = makePatch(v0, v1);
  const r = reverseApplyPatch("1\n完全无关\n3\n", p1);
  ok("无关内容拒打", !r.ok);
}

/* 第 5 组：无尾换行（\ No newline at end of file 标记） */
{
  const orig = "p\nq";
  const edited = "p\nQ";
  const patch = makePatch(orig, edited);
  ok("jsdiff 产出无尾换行标记", patch.includes("\\ No newline at end of file"));
  const r = reverseApplyPatch(edited, patch);
  ok("无尾换行往返", r.ok && r.content === orig, r.content ? JSON.stringify(r.content) : r.reason);
}

/* 第 6 组：垃圾输入 → null（不抛异常） */
ok("垃圾patch拒打", !reverseApplyPatch("hello\n", "not a patch at all").ok);
ok("越界hunk拒打", !reverseApplyPatch("hello\n", "@@ -99,1 +99,1 @@\n-nope\n+yes\n").ok);

console.log(`patchRevert 用例: ${passed} 项全部通过`);
