/**
 * toolDetail 口径用例（DIRECTOR 工单二b 第 3 项入库要求）。
 *
 * 背景：工单三（4842557）统一了宿主/ webview 双实现，当时「7 组口径用例」仅口头汇报，
 * 总监验收扣分「不可复验」——本文件即补交的可复验凭证。
 *
 * 运行：npm run test:detail（Node ≥23.6 原生跑 TS，零依赖，不进 tsc 编译门禁）
 * 口径事实来源：src/toolDetail.ts 的 DETAIL_KEYS 顺序 + || 语义 + 首字符串兜底。
 * 宿主流式行与 webview 历史重绘共用同一实现，以下期望值即两端的共同口径。
 */
import assert from "node:assert";
import { toolDetail } from "../src/toolDetail.ts";

let passed = 0;
function check(name: string, actual: string, expected: string): void {
  assert.strictEqual(actual, expected, `用例失败: ${name}`);
  passed++;
}

/* 第 1 组：已知键逐一命中（并集 11 键的代表性样本） */
check("bash 类取 command", toolDetail({ command: "git status" }), "git status");
check("read 类取 file_path", toolDetail({ file_path: "D:/a/b.ts" }), "D:/a/b.ts");
check("path 键", toolDetail({ path: "src/panel.ts" }), "src/panel.ts");
check("url 键", toolDetail({ url: "https://example.com" }), "https://example.com");
check("query 键", toolDetail({ query: "protocol types" }), "protocol types");
check("pattern 键", toolDetail({ pattern: "sessionList" }), "sessionList");
check("content 键", toolDetail({ content: "hello" }), "hello");
check("skill 键", toolDetail({ skill: "review" }), "review");
check("name 键", toolDetail({ name: "pkg" }), "pkg");
check("file 键", toolDetail({ file: "a.json" }), "a.json");
check("cmd 键", toolDetail({ cmd: "npm test" }), "npm test");

/* 第 2 组：优先级序——按 DETAIL_KEYS 顺序而非对象键序 */
check("command 胜过 file_path", toolDetail({ file_path: "x.ts", command: "ls" }), "ls");
check("file_path 胜过 path", toolDetail({ path: "p", file_path: "fp" }), "fp");
check("url 优先于 query（键序无关）", toolDetail({ query: "q", url: "u" }), "u");

/* 第 3 组：|| 语义——空串不算摘要，跳到下一键 */
check("空 command 跳过", toolDetail({ command: "", file_path: "f.ts" }), "f.ts");
check("已知键全空串 → 首字符串兜底", toolDetail({ command: "", url: "", other: "oo" }), "oo");
check("全空串 → 空摘要", toolDetail({ command: "", path: "" }), "");

/* 第 4 组：首字符串兜底（webview 版遗产，宿主版曾漂移缺失——工单三取并集保留） */
check("未知键首字符串", toolDetail({ foo: "bar" }), "bar");
check("无已知键时按对象首序", toolDetail({ z: "last", a: "first" }), "last");

/* 第 5 组：多行压缩 + 120 字符截断 */
check("多行压缩为单空格", toolDetail({ command: "a\n  b\tc" }), "a b c");
check("超 120 字符截断", toolDetail({ command: "x".repeat(200) }), "x".repeat(120));

/* 第 6 组：非 object 入参 → 空摘要 */
check("null", toolDetail(null), "");
check("undefined", toolDetail(undefined), "");
check("字符串入参", toolDetail("command"), "");
check("数组入参按对象处理，首元素字符串返回", toolDetail(["a"]), "a");

/* 第 7 组：边界——空对象与嵌套非字符串值 */
check("空对象", toolDetail({}), "");
check("值为对象不算摘要", toolDetail({ nested: { a: 1 } }), "");

console.log(`toolDetail 口径用例：${passed}/${passed + 0} 全过 ✅`);
