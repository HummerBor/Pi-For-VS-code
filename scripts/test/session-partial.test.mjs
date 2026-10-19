// sessionCache partial 渐进透传用例（2026-10-19 22s 定案修法的两把锁）
// 背景：pi 1.3.0 的 onProgress(loaded, total, partialSessions) 首批 ~19ms 就到，
// pi -r 靠它秒出列表；壳这边曾把第三参丢掉（签名 (loaded,total)=>void），死等全量
// （拥堵下 22~30s）。本用例锁死两个行为，别再回退：
//   ① listSessions 的 onProgress 第三参 = 投影后的展示条目（partial 到达即有值）；
//   ② 在途合并时后到订阅者也收得到进度广播（预热扫描在跑时打开 picker 不能干等）。
// 跑：node scripts/test/session-partial.test.mjs
import assert from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const piSdk = require("../../out/pi/piSdk.js");
const T0 = new Date("2026-10-19T00:00:00Z").getTime();
const mkEntry = (i) => ({
  path: `~/.pi/agent/sessions/s/${i}.jsonl`,
  cwd: "/proj",
  name: i === 1 ? "会话一" : undefined,
  firstMessage: `消息${i}`,
  modified: new Date(T0 + i * 1000),
});

// 假 pi SDK：3 条会话，分 3 批进度发布（第 2 批无 partial，模拟 loaded%10!=0 的跳批）
let listCalls = 0;
const fakeSdk = {
  SessionManager: {
    listAll: (onProgress) => {
      listCalls++;
      onProgress(1, 3, [mkEntry(1)]);
      onProgress(2, 3, undefined);
      onProgress(3, 3, [mkEntry(1), mkEntry(2), mkEntry(3)]);
      return Promise.resolve([mkEntry(1), mkEntry(2), mkEntry(3)]);
    },
    list: (cwd, _sessionDir, onProgress) => fakeSdk.SessionManager.listAll(onProgress),
  },
};
piSdk.loadPiSdk = () => Promise.resolve(fakeSdk);

const cache = require("../../out/vscode/sessionCache.js");

// —— 锁①：partial 第三参透传成投影展示条目 ——
const frames1 = [];
const frames2 = [];
const p1 = cache.listSessions(undefined, 50, (loaded, total, partial) =>
  frames1.push({ loaded, total, partial })
);
// 在途订阅（锁②）：同一扫描还在跑时，第二个订阅者也要收到广播
const p2 = cache.listSessions(undefined, 50, (loaded, total, partial) =>
  frames2.push({ loaded, total, partial })
);
const [r1, r2] = await Promise.all([p1, p2]);

assert.strictEqual(listCalls, 1, "在途合并：两路订阅只应触发一次 pi 调用");
for (const [tag, frames] of [["订阅者1", frames1], ["订阅者2", frames2]]) {
  assert.strictEqual(frames.length, 3, `${tag} 应收到 3 次进度回调，实际 ${frames.length}`);
  const f0 = frames[0];
  assert.strictEqual(f0.loaded, 1);
  assert.strictEqual(f0.total, 3);
  assert.ok(Array.isArray(f0.partial) && f0.partial.length === 1, `${tag} 首批应有 1 条 partial`);
  // 投影成展示条目：listSessions 的消费者（picker）只认 SessionInfo 形状
  const s = f0.partial[0];
  assert.strictEqual(s.file, mkEntry(1).path, `${tag} partial.file 应为投影路径`);
  assert.strictEqual(s.name, "会话一");
  assert.strictEqual(s.preview, "消息1");
  assert.strictEqual(typeof s.mtime, "number", `${tag} partial.mtime 应是数字时间戳`);
  assert.strictEqual(frames[1].partial, undefined, `${tag} 跳批时第三参应为 undefined`);
  assert.strictEqual(frames[2].partial.length, 3, `${tag} 末批应含全部 3 条`);
}
assert.strictEqual(r1.length, 3);
assert.strictEqual(r2.length, 3);

// —— 应答复用：TTL 内不再问 pi（回调也不应再触发）——
const frames3 = [];
const r3 = await cache.listSessions(undefined, 50, (l, t, p) => frames3.push({ l, t, p }));
assert.strictEqual(listCalls, 1, "TTL 内不应重复扫描");
assert.strictEqual(r3.length, 3);
assert.strictEqual(frames3.length, 0, "memo 命中是同步应答，不应有进度回调");

console.log("✅ sessionCache partial 透传 + 在途广播 + TTL 复用 全部通过");
