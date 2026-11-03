/**
 * 路径同一性判定（零 import 叶模块，core / vscode 两层共用）。
 *
 * 为什么要单独一个文件：会话路径在各方写下来时盘符大小写、目录大小写、分隔符、结尾斜杠
 * 都可能不一致——实测台账里 `parentSession` 是 `--d--work-docs-…`（小写），磁盘实际目录是
 * `--D--…`：严格 `===` 命中 **0/10**，忽略大小写命中 10/10。这种比较一旦用错，表现是
 * 「静默一条都不匹配」（和幽灵会话文件同一类事故），所以全仓只留一个实现，别再各写各的。
 *
 * 不做 realpath/fs 解析：本模块要能在 webview 共享编译与 node 裸跑用例里用，只做字符串归一。
 */
export function pathKey(p?: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.trim();
  if (!s) return null;
  return s.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 两条路径是否指向同一文件（大小写/分隔符/结尾斜杠不敏感） */
export function samePath(a?: unknown, b?: unknown): boolean {
  const x = pathKey(a);
  return x !== null && x === pathKey(b);
}
