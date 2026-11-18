/**
 * jsonl 增量读取用例（v23，2026-11-19）。
 *
 * 为什么要有：帧不再带消息正文后，转录页的实时内容全靠「按字节偏移增量读子会话 jsonl」。
 * 这条路径一旦错（半行被当完整行、偏移算错一字节、坏行把后续全吞掉），表现是转录页
 * 少一句/重复一句，而且是概率性的——必须用测试钉住。
 *
 * 判据：①只消费完整行 ②半行不丢不重 ③system 跳过 ④坏行不阻塞后行 ⑤无新内容返回 null
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileBytes, readNewMessages } from "../../src/domain/jsonlTail.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jsonltail-"));
const file = path.join(dir, "s.jsonl");
const line = (o) => JSON.stringify(o) + "\n";
const msg = (role, text) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });

// ① 首读：header + system + user + assistant，system 必须被跳过
fs.writeFileSync(file, line({ type: "session" }) + line(msg("system", "sys")) + line(msg("user", "u1")) + line(msg("assistant", "a1")));
let offset = 0;
let got = readNewMessages(file, offset);
assert.ok(got, "① 首读应有内容");
assert.equal(got.messages.length, 2, "① system 应被跳过");
assert.equal(got.messages[0].content[0].text, "u1");
offset = got.offset;
assert.equal(got.offset, fileBytes(file), "① 偏移应吃到文件末尾");

// ② 无新内容 → null
assert.equal(readNewMessages(file, offset), null, "② 无新内容应返回 null");

// ③ 追加一条完整消息
fs.appendFileSync(file, line(msg("assistant", "a2")));
got = readNewMessages(file, offset);
assert.equal(got.messages.length, 1, "③ 应读到 1 条");
assert.equal(got.messages[0].content[0].text, "a2");
offset = got.offset;

// ④ 半行：只写到一半，必须返回 null（半行留在偏移上）
const half = JSON.stringify(msg("assistant", "a3")).slice(0, 20);
fs.appendFileSync(file, half);
assert.equal(readNewMessages(file, offset), null, "④ 半行不许当完整行吃");

// ⑤ 半行补齐后续读：a3 恰好读一次（不丢不重）
fs.appendFileSync(file, JSON.stringify(msg("assistant", "a3")).slice(20) + "\n");
got = readNewMessages(file, offset);
assert.equal(got.messages.length, 1, "⑤ 补齐后应读到 1 条");
assert.equal(got.messages[0].content[0].text, "a3", "⑤ 内容应完整（半行没被吃坏）");
offset = got.offset;

// ⑥ 坏行不阻塞后行
fs.appendFileSync(file, "{ 这不是 json\n" + line(msg("assistant", "a4")));
got = readNewMessages(file, offset);
assert.equal(got.messages.length, 1, "⑥ 坏行跳过但后面的行要读到");
assert.equal(got.messages[0].content[0].text, "a4");

// ⑦ 文件不存在 → null（不抛）
assert.equal(readNewMessages(path.join(dir, "nope.jsonl"), 0), null, "⑦ 缺文件应返回 null");

fs.rmSync(dir, { recursive: true, force: true });
console.log("test-jsonltail: 7/7 通过");
