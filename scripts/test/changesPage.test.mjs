/**
 * changesPage 用例（变更页 2026-11-05）：宿主侧逐文件 diff 数据面。
 *
 * 打的是 src/vscode/changes.ts 的 openPage/buildPage：它不是纯函数（要 git、要磁盘），
 * 所以这里用**桩 vscode 模块** + 临时 git 仓库真跑一遍，断言三路数据：
 *   ① tracked 文件（走 `git diff HEAD -- rel`）：计数正确、diff 已剥成 hunk-only；
 *   ② 未跟踪/仅工具命中（走 patch 逆向 + pi generateUnifiedPatch）：能还原出改动前内容再对比；
 *   ③ 边界：二进制给 note、无法取得基线给 note、已删除给 note（不硬猜）。
 *
 * 运行：npm run test:changespage（先 npm run compile，用例读 out/ 产物；Node ≥23.6）
 */
import assert from "node:assert";
import Module from "node:module";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

// ── vscode 桩：changes.ts 只用 workspace.workspaceFolders（其余分支本用例不触达）──
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chgpage-"));
const fakeVscode = {
  workspace: { workspaceFolders: [{ uri: { fsPath: root } }], textDocuments: [] },
  Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ path: s, query: "" }) },
  commands: { executeCommand: async () => undefined },
  // 还原是破坏性动作：用例里直接「点确认」（传 third 参数当返回值），并记录被问了什么
  window: {
    asked: [],
    showWarningMessage: async (msg, opts, btn) => {
      fakeVscode.window.asked.push({ msg, opts, btn });
      return btn;
    },
  },
  ThemeIcon: class {},
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return origLoad.call(this, request, parent, isMain);
};

const outFile = new URL("../../out/vscode/changes.js", import.meta.url);
if (!fs.existsSync(outFile)) {
  console.error("缺少 out/vscode/changes.js —— 先跑 npm run compile");
  process.exit(1);
}
const { ChangesController } = require("../../out/vscode/changes.js");
const { STRINGS } = require("../../out/core/i18n.js");
const L = STRINGS.zh;

// ── 临时 git 仓库 ──
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
git(["init"]);
git(["-c", "user.email=test@local", "-c", "user.name=test", "add", "-A"]);
write("tracked.txt", "one\ntwo\nthree\n");
git(["-c", "user.email=test@local", "-c", "user.name=test", "add", "-A"]);
git(["-c", "user.email=test@local", "-c", "user.name=test", "commit", "-m", "init"]);

const posts = [];
const ctrl = new ChangesController({
  post: (m, tabId) => posts.push(tabId ? Object.assign({}, m, { tabId }) : m),
  getL: () => L,
  getActiveTabId: () => "t1",
});
const lastPage = () => posts.filter((m) => m.type === "changesPage").pop();

// 用例素材：tracked 改两行；未跟踪 c.txt 由「工具」写入（带 patch）
write("tracked.txt", "one\nTWO\nthree\nfour\n");
const patch = await import(
  new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js", import.meta.url).href
);
const untrackedOld = "alpha\nbeta\n";
const untrackedNew = "alpha\nBETA\ngamma\n";
const cAbs = write("c.txt", untrackedNew);
// 未跟踪文件没有 git 基线：patch = old → new（pi edit 工具的 details.patch 同口径）
const cPatch = patch.generateUnifiedPatch("c.txt", untrackedOld, untrackedNew);

let n = 0;
const ok = async (name, fn) => {
  await fn();
  n++;
  console.log("  ✓ " + name);
};

console.log("changesPage:");

await ctrl.handleRunSettled("t1", [
  { path: path.join(root, "tracked.txt"), tool: "edit", patches: [] },
  // 裁决 11③：无基线的还原只对 edit 的 patch 链开放（write 不算），故这里用 edit
  { path: cAbs, tool: "edit", patches: [cPatch] },
]);
await ctrl.openPage();

await ok("清单与页面都到了 webview（per-tab 消息）", () => {
  const list = posts.filter((m) => m.type === "changesList").pop();
  assert.ok(list && list.files.length >= 2, "changesList 应含两个文件");
  assert.strictEqual(list.tabId, "t1");
  const page = lastPage();
  assert.ok(page, "应回发 changesPage");
  assert.strictEqual(page.tabId, "t1");
});

await ok("tracked：走 git diff HEAD，计数正确、diff 剥成 hunk-only", () => {
  const f = lastPage().files.find((x) => x.rel === "tracked.txt");
  assert.ok(f, "应含 tracked.txt");
  assert.strictEqual(f.adds, 2); // TWO 改 + four 新增
  assert.strictEqual(f.dels, 1); // two 被删
  assert.ok(f.diff.startsWith("@@"), "diff 必须从 @@ 起（头部已剥）");
  assert.ok(!/^--- /m.test(f.diff), "不得残留 --- 文件头");
  assert.ok(!/^diff --git/m.test(f.diff), "不得残留 diff --git 行");
  assert.ok(f.diff.includes("-two") && f.diff.includes("+TWO"));
});

await ok("未跟踪 + patch：逆向取基线后再对比（内容不符即不硬猜）", () => {
  const f = lastPage().files.find((x) => x.rel === "c.txt");
  assert.ok(f, "应含 c.txt");
  assert.strictEqual(f.adds, 2); // BETA + gamma
  assert.strictEqual(f.dels, 1); // beta
  assert.ok(f.diff.includes("-beta") && f.diff.includes("+BETA"));
});

await ok("汇总 = 各文件相加", () => {
  const page = lastPage();
  const sumA = page.files.reduce((s, f) => s + f.adds, 0);
  const sumD = page.files.reduce((s, f) => s + f.dels, 0);
  assert.strictEqual(page.totalAdds, sumA);
  assert.strictEqual(page.totalDels, sumD);
});

await ok("页内动作的资格：可 diff / 可还原由宿主判（裁决 11）", () => {
  const files = lastPage().files;
  const tracked = files.find((x) => x.rel === "tracked.txt");
  const untracked = files.find((x) => x.rel === "c.txt");
  assert.strictEqual(tracked.canDiff, true);
  assert.strictEqual(tracked.canRevert, true); // tracked 且 inHead → git checkout 可回
  assert.strictEqual(untracked.canDiff, true);
  assert.strictEqual(untracked.canRevert, true); // 工具命中 + 有 patch → 逆向可回
});

await ok("页内还原：模态确认 + patch 逆向落盘 + 清单重生", async () => {
  posts.length = 0;
  fakeVscode.window.asked.length = 0;
  await ctrl.revertByPath(cAbs);
  assert.strictEqual(fakeVscode.window.asked.length, 1, "必须先模态问一次");
  assert.ok(fakeVscode.window.asked[0].opts && fakeVscode.window.asked[0].opts.modal, "必须是模态确认");
  assert.strictEqual(fs.readFileSync(cAbs, "utf8"), untrackedOld, "patch 逆向应回到改动前内容");
  const list = posts.filter((m) => m.type === "changesList").pop();
  assert.ok(list, "还原后应重发清单");
  assert.ok(!list.files.some((x) => x.path === cAbs), "还原过的文件应从清单移除");
});

await ok("页内还原：资格不足只报不做（不动磁盘）", async () => {
  posts.length = 0;
  fakeVscode.window.asked.length = 0;
  const before = fs.readFileSync(path.join(root, "tracked.txt"), "utf8");
  await ctrl.revertByPath(path.join(root, "not-in-list.txt"));
  assert.strictEqual(fakeVscode.window.asked.length, 0, "无资格不得弹确认框");
  const notice = posts.filter((m) => m.type === "notice").pop();
  assert.ok(notice && notice.text === L.chgNoAction, "应回 chgNoAction 提示");
  assert.strictEqual(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), before);
});

await ok("二进制给 note、不回脏 diff", async () => {
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  posts.length = 0;
  await ctrl.handleRunSettled("t1", [{ path: path.join(root, "bin.dat"), tool: "write", patches: [] }]);
  await ctrl.openPage();
  const f = lastPage().files.find((x) => x.rel === "bin.dat");
  assert.ok(f, "应含 bin.dat");
  assert.strictEqual(f.diff, "");
  assert.strictEqual(f.note, L.chgPageBinary, "二进制应走二进制文案");
});

await ok("已删除的无基线文件给 note（不造空 diff）", async () => {
  const gone = path.join(root, "gone.txt");
  posts.length = 0;
  await ctrl.handleRunSettled("t1", [{ path: gone, tool: "write", patches: [] }]);
  await ctrl.openPage();
  const f = lastPage().files.find((x) => x.rel === "gone.txt");
  assert.ok(f, "应含 gone.txt");
  assert.strictEqual(f.diff, "");
  assert.ok(f.note, "必须带 note");
});

await ok("缓存生效：清单未变时重复开页不再重算（同一份数据对象）", async () => {
  const first = lastPage();
  posts.length = 0;
  await ctrl.openPage();
  const second = lastPage();
  assert.deepStrictEqual(second.files, first.files);
});

Module._load = origLoad;
fs.rmSync(root, { recursive: true, force: true });
console.log("changesPage: " + n + " passed");
