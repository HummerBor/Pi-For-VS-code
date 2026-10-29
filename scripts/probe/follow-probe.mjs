// 工单32 刀2 探针：readFollowGrowth 的 JSONL \n 分帧 + 外部登记表 path/name/TTL。
// 跑法：node scripts/probe/follow-probe.mjs（先 npm run compile）。真实输出贴 REPORT-t32。
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { PiClient } from "../../out/pi/piClient.js";
import {
  setExternalWriting,
  setExternalWritingName,
  isExternalWriting,
  _resetExternalWritingForTest,
} from "../../out/core/externalWriting.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-probe-"));
const file = path.join(dir, "t.jsonl");
let pass = 0,
  fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg); }
};

const msg = (id, text) =>
  JSON.stringify({ type: "message", id, parentId: null, message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

console.log("① 分帧：整行读入 → 解析、offset 推进到末 \\n");
const fake = { followOffset: 0 };
fs.writeFileSync(file, msg("a", "hello") + JSON.stringify({ type: "session", id: "x" }) + "\n");
let out = PiClient.prototype.readFollowGrowth.call(fake, file, fs.statSync(file).size);
ok(out && out.length === 1, `两条 entry 解析出 1 条 message（非 message 类型被滤），实际 ${out && out.length}`);
ok(fake.followOffset === fs.statSync(file).size, "offset 推进到文件尾（末 \\n 之后）");

console.log("② 半行攒帧：无 \\n 的增长不消费、不推进 offset");
const before = fake.followOffset;
fs.appendFileSync(file, '{"type":"message","id":"b"');
out = PiClient.prototype.readFollowGrowth.call(fake, file, fs.statSync(file).size);
ok(out === null, "半行返回 null（不上屏半截 JSON）");
ok(fake.followOffset === before, "offset 不动（攒到下帧）");

console.log("③ 补完 → 帧消费，且 UTF-8 多字节（中文）不碎");
fs.appendFileSync(file, `,"parentId":null,"message":{"role":"assistant","content":[{"type":"text","text":"中文🎉行"}]}}\n`);
out = PiClient.prototype.readFollowGrowth.call(fake, file, fs.statSync(file).size);
ok(out && out.length === 1 && out[0].content[0].text === "中文🎉行", "补帧解析出完整中文消息（多字节完整）");
ok(fake.followOffset === fs.statSync(file).size, "offset 追平文件尾");

console.log("④ 坏行跳过：单行损坏不卡死后续");
fs.appendFileSync(file, "not-json-at-all\n" + msg("c", "after-bad"));
out = PiClient.prototype.readFollowGrowth.call(fake, file, fs.statSync(file).size);
ok(out && out.length === 1 && out[0].content[0].text === "after-bad", "坏行跳过、好行照常解析");

console.log("⑤ 登记表：path/name 双键 + 清除");
_resetExternalWritingForTest();
setExternalWriting(file, true);
ok(isExternalWriting(file, null) === true, "path 登记命中");
setExternalWritingName("ops-x-1", true);
ok(isExternalWriting(file, "ops-x-1") === true, "name 登记命中（文件未解析也能锁）");
ok(isExternalWriting("C:/other/a.jsonl", "ops-x-1") === true, "name 命中与 path 无关（按会话名锁）");
setExternalWritingName("ops-x-1", false);
ok(isExternalWriting("C:/other/b.jsonl", "ops-x-1") === false, "name 清除（交棒信号；换无 path 挂载的文件纯验 name 键）");
setExternalWriting(file, false);
ok(isExternalWriting(file, null) === false, "path 清除");

console.log("⑥ name TTL：过期自动解锁（僵尸锁逃生阀）");
const realNow = Date.now;
setExternalWritingName("ops-ttl", true);
Date.now = () => realNow() + 31 * 60 * 1000; // 快进 31 分钟 > HOLDER_TTL_MS(30min)
ok(isExternalWriting(null, "ops-ttl") === false, "31 分钟后 TTL 过期，不再命中");
Date.now = realNow;

console.log(`\n结果：${pass} 过 / ${fail} 败`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
