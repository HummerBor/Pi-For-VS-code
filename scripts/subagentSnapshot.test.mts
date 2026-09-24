/**
 * subagentSnapshot 用例（子 agent 监控可视化的快照构建口径）。
 *
 * 运行：npm run test:subagent（Node ≥23.6 原生跑 TS，零依赖，不进 tsc 编译门禁）
 * 口径事实来源：
 * - details 形状 = .pi/extensions/subagent/index.ts 的 SubagentDetails/SingleResult
 *   （mode/agentScope/projectAgentsDir/results[]；每任务 agent/task/exitCode/messages/
 *   stderr/usage{input,output,cacheRead,cacheWrite,cost,contextTokens,turns}/model/stopReason）
 * - 展示格式对齐官方扩展折叠视图（formatUsageStats / 工具调用摘要）
 * 防御口径：形状不符返回 null（旧版扩展/其他工具的 details 不许弄崩面板）。
 */
import assert from "node:assert";
import { setDisplayNameLookup, subagentSnapshot } from "../src/subagentSnapshot.ts";

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, `用例失败: ${name}`);
  passed++;
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert.deepStrictEqual(actual, expected, `用例失败: ${name}`);
  passed++;
}

/* 第 1 组：形状防御——非 subagent 的 details 一律 null */
eq("null details", subagentSnapshot(null), null);
eq("非对象 details", subagentSnapshot("text"), null);
eq("无 mode", subagentSnapshot({ results: [] }), null);
eq("mode 不认识", subagentSnapshot({ mode: "swarm", results: [] }), null);
eq("无 results", subagentSnapshot({ mode: "single" }), null);
eq("results 非数组", subagentSnapshot({ mode: "single", results: "x" }), null);
// 坏任务跳过（results 混入脏数据不许弄崩面板），details 本身仍有效 → tasks:[] 的空快照
eq("任务缺 agent 被跳过", subagentSnapshot({ mode: "single", results: [{ task: "t" }] }), { mode: "single", tasks: [] });

/* 第 2 组：single 模式运行中——messages 里提取文本/工具调用，status=running */
const running = subagentSnapshot({
  mode: "single",
  results: [{
    agent: "builder",
    task: "按工单施工",
    exitCode: 0,
    usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, cost: 0.0021, contextTokens: 45000, turns: 3 },
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "内部思考不上屏" }] },
      { role: "assistant", content: [{ type: "text", text: "开始读 DIRECTOR.md" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm run compile" } }] },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/panel.ts" } }] },
    ],
  }],
});
ok("single 识别", running !== null);
if (running) {
  eq("mode", running.mode, "single");
  eq("任务数", running.tasks.length, 1);
  const t = running.tasks[0];
  eq("status=running", t.status, "running");
  eq("usage 串", t.usage, "3 turns ↑1.2k ↓340 $0.0021 ctx:45.0k");
  eq("活动条数", t.activityCount, 3);
  eq("活动内容", t.items, ["开始读 DIRECTOR.md", "$ npm run compile", "read src/panel.ts"]);
  eq("运行中无最终输出", t.output, "");
}

/* 第 3 组：结束态——stopReason 判定 + 最终输出提取 */
const done = subagentSnapshot({
  mode: "single",
  results: [{
    agent: "scout", task: "侦察", exitCode: 0, stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    messages: [
      { role: "user", content: [{ type: "text", text: "去侦察" }] },
      { role: "assistant", content: [{ type: "text", text: "结论：\n认证代码在 src/auth/" }] },
    ],
  }],
});
ok("done 识别", done !== null);
if (done) {
  eq("status=done", done.tasks[0].status, "done");
  eq("最终输出（换行压平）", done.tasks[0].output, "结论： 认证代码在 src/auth/");
  eq("零用量不留串", done.tasks[0].usage, "1 turn");
}

/* 第 4 组：失败态——exitCode!==0 取 errorMessage/stderr */
const failed = subagentSnapshot({
  mode: "single",
  results: [{
    agent: "worker", task: "干活", exitCode: 1, stopReason: "error",
    errorMessage: "LLM 超时", stderr: "stderr 内容",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    messages: [{ role: "assistant", content: [{ type: "text", text: "做了一半" }] }],
  }],
});
ok("failed 识别", failed !== null);
if (failed) {
  eq("status=failed", failed.tasks[0].status, "failed");
  eq("失败输出取 errorMessage", failed.tasks[0].output, "LLM 超时");
}

/* 第 5 组：chain/parallel——step 序号 + 各任务独立状态 */
const chain = subagentSnapshot({
  mode: "chain",
  results: [
    { agent: "scout", task: "s", exitCode: 0, stopReason: "stop", step: 1, usage: {}, messages: [] },
    { agent: "planner", task: "p", step: 2, usage: {}, messages: [] },
    { agent: "worker", task: "w", exitCode: 1, step: 3, usage: {}, messages: [] },
  ],
});
ok("chain 识别", chain !== null);
if (chain) {
  eq("chain 三任务", chain.tasks.length, 3);
  eq("step 透传", chain.tasks.map((t) => t.step), [1, 2, 3]);
  eq("混合状态", chain.tasks.map((t) => t.status), ["done", "running", "failed"]);
}

/* 第 6 组：活动尾窗——超过 12 条只留最近 12 条，activityCount 保总量 */
const manyMsgs: unknown[] = [];
for (let i = 1; i <= 20; i++) {
  manyMsgs.push({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "cmd" + i } }] });
}
const windowed = subagentSnapshot({ mode: "single", results: [{ agent: "a", task: "t", usage: {}, messages: manyMsgs }] });
ok("尾窗识别", windowed !== null);
if (windowed) {
  eq("尾窗 12 条", windowed.tasks[0].items.length, 12);
  eq("尾窗是最近的", windowed.tasks[0].items[11], "$ cmd20");
  eq("总量 20", windowed.tasks[0].activityCount, 20);
}

/* 第 7 组：流式中间态 stopReason（0.111 事故回归）——中间回合 toolCall 不是完成 */
const midTurn = subagentSnapshot({
  mode: "single",
  results: [{ agent: "a", task: "t", exitCode: 0, stopReason: "toolCall", usage: {}, messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] }] }],
});
ok("toolCall 中间态识别", midTurn !== null);
if (midTurn) eq("toolCall → running", midTurn.tasks[0].status, "running");

const endTurn = subagentSnapshot({
  mode: "single",
  results: [{ agent: "a", task: "t", exitCode: 0, stopReason: "end", usage: {}, messages: [{ role: "assistant", content: [{ type: "text", text: "完事" }] }] }],
});
ok("end 收尾识别", endTurn !== null);
if (endTurn) eq("end → done", endTurn.tasks[0].status, "done");

/* 第 8 组：两层分离（2026-09-24 拍板）——展示显示调用名（随便取），派发归 pi 分类
   （不然老报名字错误）；台账按任务文本对号，缺则回退分类名 */
import {
  classifyDispatchName,
  displayNameFor,
  noteDispatchNames,
  resetDisplayNames,
  rewriteSubagentInput,
} from "../src/subagentNames.ts";
resetDisplayNames();
setDisplayNameLookup(displayNameFor);

ok("已注册分类原样", classifyDispatchName("scout", ["scout", "worker"], "worker") === "scout");
ok("未注册名归默认分类", classifyDispatchName("test-agent", ["scout", "worker"], "worker") === "worker");
ok("无默认取第一个", classifyDispatchName("test-agent", ["planner", "scout"], "planner") === "planner");
ok("注册表为空原样（报错权留给 pi）", classifyDispatchName("test-agent", [], null) === "test-agent");

const input: Record<string, unknown> = {
  agent: "test-agent",
  task: "T-single",
  tasks: [{ agent: "general-purpose", task: "T-par" }],
  chain: [{ agent: "helper", task: "T-chain" }],
};
// 台账记原名（必须在归位【前】记，见 subagentNames 头注释）——顺序与真实钩子一致
noteDispatchNames(input);
rewriteSubagentInput(input, (n) => classifyDispatchName(n, ["scout", "worker"], "worker"));
eq("single 槽归位", input.agent, "worker");
eq("tasks 槽归位", (input.tasks as any[])[0].agent, "worker");
eq("chain 槽归位", (input.chain as any[])[0].agent, "worker");
eq("task 文本不动", (input.tasks as any[])[0].task, "T-par");

// 快照显示原名（台账）而非分类名（details）
const renamed = subagentSnapshot({
  mode: "single",
  results: [{ agent: "worker", task: "T-single", exitCode: 0, stopReason: "end", usage: {}, messages: [] }],
});
ok("改名快照识别", renamed !== null);
if (renamed) eq("显示调用名而非分类名", renamed.tasks[0].agent, "test-agent");
if (renamed) eq("台账里是原名", displayNameFor("T-single"), "test-agent");
eq("台账缺回退分类名", displayNameFor("没见过的任务"), undefined);

console.log(`subagentSnapshot: ${passed} 项全过`);
