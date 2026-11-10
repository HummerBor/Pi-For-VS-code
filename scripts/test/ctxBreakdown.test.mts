/**
 * 上下文用量分类估算用例（src/domain/ctxBreakdown.ts）
 *
 * 怎么跑（仓库根目录）：
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test/ctxBreakdown.test.mts
 * 或：npm run test:ctx
 *
 * 覆盖的是「拆分规则」，不是算术：pi 的会话消息结构里哪些字段归哪一类、section 的补丁
 * 语义（覆盖/删除）、MCP 工具单列、图片按 4800 字符。最后一段在存在真实会话文件时跑一次
 * 回归（没有就跳过，不假装通过）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CHARS_PER_TOKEN,
  ESTIMATED_IMAGE_CHARS,
  compactionStops,
  estimateContextBreakdown,
  isMcpToolName,
} from "../../src/domain/ctxBreakdown.ts";

const ceilTok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const filler = (n: number) => "x".repeat(n);

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log("  ✔ " + name);
}

// ── 1. 分节归属：preamble/tools/rules/docs/cwd → 提示词；project_context → 项目；skills → 技能
ok("系统提示词分节按名字归位（含 addendum），project_context/skills 不混进 prompt", () => {
  const bd = estimateContextBreakdown([
    {
      role: "system",
      content: "",
      sections: {
        preamble: filler(35), // 10
        tools: filler(7), // 2
        rules: filler(0), // 0（pi 可能给空串）
        docs: filler(70), // 20
        cwd: filler(3), // 1
        addendum: filler(14), // 4
        project_context: filler(350), // 100
        skills: filler(140), // 40
      },
      timestamp: 1,
    },
  ]);
  assert.equal(bd.prompt, 10 + 2 + 0 + 20 + 1 + 4);
  assert.equal(bd.project, 100);
  assert.equal(bd.skills, 40);
  assert.equal(bd.extSections, 0);
  assert.equal(bd.messages, 0);
  assert.equal(bd.tools, 0);
  assert.equal(bd.mcp, 0);
  assert.equal(bd.estimated, bd.prompt + bd.project + bd.skills);
});

// ── 2. 非 pi 自带名的 section = 扩展注入（MCP 扩展在这一层）
ok("未知 section 名归 extSections（扩展注入），不进系统提示词", () => {
  const bd = estimateContextBreakdown([
    { role: "system", content: "", sections: { preamble: filler(35), mcp_servers: filler(70) }, timestamp: 1 },
  ]);
  assert.equal(bd.prompt, 10);
  assert.equal(bd.extSections, 20);
});

// ── 3. section 是补丁语义：覆盖按名字替换、null 删除
ok("后续 system 消息按名字覆盖/删除 section（不重复计数）", () => {
  const bd = estimateContextBreakdown([
    { role: "system", content: "", sections: { preamble: filler(350), skills: filler(350) }, timestamp: 1 },
    { role: "system", sections: { skills: null, preamble: filler(35) }, timestamp: 2 },
  ]);
  assert.equal(bd.prompt, 10, "preamble 被覆盖成 35 字符（不是累加 385）");
  assert.equal(bd.skills, 0, "skills 被 null 删除");
});

// ── 4. 工具声明：普通工具进 tools，MCP 工具（mcp__ / 资源工具）进 mcp
ok("工具声明分流：mcp__ 前缀与三个资源工具归 MCP，其余归工具定义", () => {
  const read = { name: "read", description: filler(70), parameters: { type: "object" } };
  const bash = { name: "bash", description: filler(35), parameters: { type: "object" } };
  const mcpTool = { name: "mcp__github__create_issue", description: filler(70), parameters: {} };
  const resTool = { name: "read_mcp_resource", description: filler(14), parameters: {} };
  const bd = estimateContextBreakdown([
    {
      role: "system",
      content: "",
      sections: {},
      toolsAdded: [read, bash, mcpTool, resTool],
      timestamp: 1,
    },
  ]);
  const tok = (t: unknown) => ceilTok(JSON.stringify(t).length);
  assert.equal(bd.tools, tok(read) + tok(bash));
  assert.equal(bd.mcp, tok(mcpTool) + tok(resTool));
  assert.ok(isMcpToolName("mcp__x__y") && isMcpToolName("list_mcp_resources") && !isMcpToolName("read"));
});

// ── 5. toolsRemoved 把工具从声明里摘掉（pi 的 SystemMessage 就是这套累加/摘除语义）
ok("toolsRemoved 摘掉对应工具", () => {
  const a = { name: "read", parameters: {} };
  const b = { name: "bash", parameters: {} };
  const only = estimateContextBreakdown([{ role: "system", content: "", toolsAdded: [a, b], timestamp: 1 }]);
  const after = estimateContextBreakdown([
    { role: "system", content: "", toolsAdded: [a, b], timestamp: 1 },
    { role: "system", toolsRemoved: [{ name: "bash" }], timestamp: 2 },
  ]);
  assert.equal(after.tools, ceilTok(JSON.stringify(a).length));
  assert.ok(after.tools < only.tools);
});

// ── 6. 消息估算复刻 pi 的 estimateMessageTokens：user/toolResult 看 content、图片 4800 字符、
//      assistant 看 text/thinking/toolCall
ok("消息估算：图片按 4800 字符、thinking 与 toolCall 计入、user 与 toolResult 走 content", () => {
  const bd = estimateContextBreakdown([
    { role: "user", content: [{ type: "text", text: filler(35) }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: filler(70) }, { type: "thinking", thinking: filler(35) }], timestamp: 2 },
    { role: "toolResult", content: [{ type: "text", text: filler(7) }], timestamp: 3 },
  ]);
  const userTok = ceilTok(35 + ESTIMATED_IMAGE_CHARS);
  const asstTok = ceilTok(70 + 35);
  const toolTok = ceilTok(7);
  assert.equal(bd.messages, userTok + asstTok + toolTok);
});

// ── 7. 恒等式：estimated 永远是分项之和（调用方靠它算「其他」差额）
ok("estimated = 各分项之和", () => {
  const bd = estimateContextBreakdown([
    { role: "system", content: "", sections: { preamble: filler(35), project_context: filler(70) }, toolsAdded: [{ name: "read", parameters: {} }], timestamp: 1 },
    { role: "user", content: filler(21), timestamp: 2 },
  ]);
  assert.equal(bd.estimated, bd.prompt + bd.project + bd.tools + bd.messages + bd.mcp + bd.skills + bd.extSections);
});

// ── 8. 空/异常输入不能炸（webview 重建期 messages 可能是空数组）
ok("空数组与脏数据不抛异常", () => {
  assert.equal(estimateContextBreakdown([]).estimated, 0);
  const bd = estimateContextBreakdown([null, undefined, 42, { role: "system", sections: { preamble: 123 } }] as unknown[]);
  assert.ok(bd.estimated >= 0);
});

// ── 8b. 三段档位（2026-11-05 用户拍板：按窗口三等分，末档 = 窗口本身 = 拉满）
ok("三段档位：1M 窗口 → 350K / 700K / 1M（末档恒等于窗口）", () => {
  assert.deepEqual(compactionStops(1048576), [350000, 700000, 1048576]);
});

ok("三段档位：128K 窗口按量级选步进，末档 = 窗口", () => {
  assert.deepEqual(compactionStops(131072), [45000, 85000, 131072]);
});

ok("三段档位：窗口未知/为零 → 空数组（调用方据此禁用滑块）", () => {
  assert.deepEqual(compactionStops(0), []);
  assert.deepEqual(compactionStops(null), []);
  assert.deepEqual(compactionStops(undefined), []);
});

ok("三段档位：极小窗口不出现重复/倒序档位", () => {
  const s = compactionStops(3000);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], "升序");
  assert.equal(s[s.length - 1], 3000, "末档 = 窗口");
});

// ── 9. 真实会话回归（有会话文件才跑）：分类都不为负、总量为正
const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
if (existsSync(sessionsRoot)) {
  const dirs = readdirSync(sessionsRoot).filter((d) => {
    try {
      return statSync(join(sessionsRoot, d)).isDirectory();
    } catch {
      return false;
    }
  });
  let file: string | null = null;
  for (const d of dirs) {
    const dir = join(sessionsRoot, d);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      if (!file) file = join(dir, f);
    }
  }
  if (file) {
    ok("真实会话文件：system 分节 + toolsAdded 能拆出非负分类", () => {
      let sys: any = null;
      for (const line of readFileSync(file as string, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const m = o.message || o;
        if (m?.role === "system") {
          sys = m;
          break;
        }
      }
      if (!sys) return; // 老会话没有 system 消息：跳过
      const bd = estimateContextBreakdown([sys]);
      for (const k of ["prompt", "project", "tools", "messages", "mcp", "skills", "extSections"] as const) {
        assert.ok(bd[k] >= 0, k + " 不为负");
      }
      assert.ok(bd.prompt > 0, "真实会话的系统提示词不应为 0");
    });
  } else {
    console.log("  - 跳过真实会话回归（没有会话文件）");
  }
} else {
  console.log("  - 跳过真实会话回归（没有 sessions 目录）");
}

console.log(`\nctxBreakdown: ${passed} passed`);
