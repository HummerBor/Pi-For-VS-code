// R′刀验收（2026-09-23）：sessionScan 同步快扫 vs pi SessionManager.listAll 权威——同形性对照（可证伪）
// 判据：① path 集合完全一致（含 subagent 孪生文件的取舍口径）② name/firstMessage 逐项一致
//      ③ modified 容差 60s（快扫用 stat mtime，pi 用最后消息活动时间）
// 跑法：npm run test:listfast
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { listAllSyncFast } = require(join(root, "out", "sessionScan.js"));
const { loadPiSdk } = require(join(root, "out", "piSdk.js"));

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
};

const tFast = Date.now();
const fast = listAllSyncFast();
const fastMs = Date.now() - tFast;

const tAuth = Date.now();
const sdk = await loadPiSdk();
const auth = await sdk.SessionManager.listAll();
const authMs = Date.now() - tAuth;
console.log(`样本量: fast=${fast.length} 项/${fastMs}ms  authority=${auth.length} 项/${authMs}ms\n`);

const aMap = new Map(auth.map((x) => [x.path, x]));
const fMap = new Map(fast.map((x) => [x.path, x]));
const onlyFast = [...fMap.keys()].filter((p) => !aMap.has(p));
const onlyAuth = [...aMap.keys()].filter((p) => !fMap.has(p));
check("① path 集合一致", onlyFast.length === 0 && onlyAuth.length === 0,
  `仅快扫有=${onlyFast.length} 仅权威有=${onlyAuth.length}` +
  (onlyFast.length ? " 例:" + onlyFast[0] : "") + (onlyAuth.length ? " 例:" + onlyAuth[0] : ""));

let nameDiff = [], fmDiff = [], mtimeBad = [];
for (const [p, f] of fMap) {
  const a = aMap.get(p);
  if (!a) continue;
  const aName = typeof a.name === "string" ? a.name.trim() : undefined;
  if ((f.name ?? undefined) !== (aName ?? undefined)) nameDiff.push(p);
  if (f.firstMessage !== (a.firstMessage || "(no messages)")) fmDiff.push(p);
  const dt = Math.abs(new Date(f.modified).getTime() - new Date(a.modified).getTime());
  if (dt > 60000) mtimeBad.push(p + " Δ" + Math.round(dt / 1000) + "s");
}
check("② name 逐项一致", nameDiff.length === 0, `差异=${nameDiff.length}` + (nameDiff.length ? " 例:" + nameDiff[0] : ""));
check("② firstMessage 逐项一致", fmDiff.length === 0, `差异=${fmDiff.length}` + (fmDiff.length ? " 例:" + fmDiff[0] : ""));
check("③ modified 容差 60s", mtimeBad.length === 0, `超差=${mtimeBad.length}` + (mtimeBad.length ? " 例:" + mtimeBad[0] : ""));

const fail = results.some((r) => !r);
console.log(fail ? "\ntest:listfast FAIL" : "\ntest:listfast PASS");
process.exit(fail ? 1 : 0);
