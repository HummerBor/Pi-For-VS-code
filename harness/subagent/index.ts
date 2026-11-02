/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	classifyDeath,
	markRun,
	maxHandleSeq,
	readAllRuns,
	reconcileRuns,
	runDirFor,
	writeRecord,
	type RunRecord,
} from "./runsLedger.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "built-in" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** 显式生命周期真值（2026-10-23 实测事故「跑着的子 agent 浮窗显示 ✓」）：异步 run 的
	 *  真实状态随载荷走，快照/回放不再靠 stopReason 启发式猜——每回合结束 stopReason 都会
	 *  更新成正常值，回合收尾 ≠ 任务收尾。同步最终结果无此字段，走旧判定 */
	running?: boolean;
	status?: "running" | "completed" | "failed" | "killed";
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[], startDir: string): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// 【spawn 修复 2026-09-18】argv[1] 必须长得像 pi 入口才可信：进程内直连宿主（VS Code
	// 扩展宿主）里 argv[1] 是宿主引导脚本，文件存在但不是 pi——原逻辑误 spawn 宿主自身，
	// 子进程静默退出 0 零输出（"(no output)" 事故根因，会话 details 死据：exitCode 0 /
	// messages 0 / usage 全零 / stderr 空）。TUI 里 argv[1] 是 pi 包内 cli.js，含
	// pi-coding-agent 路径段，此守卫不伤 TUI
	const looksLikePiEntry = !!currentScript && /[\\/]pi-coding-agent[\\/]/.test(currentScript);
	if (currentScript && !isBunVirtualScript && looksLikePiEntry && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	// bun 单文件编译产物：execPath 本身就是 pi 二进制（argv[1] 指向虚拟 FS 时才成立）
	if (isBunVirtualScript) {
		const execName = path.basename(process.execPath).toLowerCase();
		const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
		if (!isGenericRuntime) {
			return { command: process.execPath, args };
		}
	}

	// 宿主既没给 pi 入口、execPath 也不是 pi 二进制（插件/桌面宿主）：从工作目录向上找
	// 项目内安装的 pi 包入口（di-duck devDependencies 里有 pi-coding-agent）
	for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
		const cli = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		if (fs.existsSync(cli)) {
			// Electron 宿主的 execPath 不是 node，不能拿去跑 cli.js；PATH 上的 node.exe 是真
			// 可执行文件，spawn 无需 shell（task 文本含空格/换行，绝不能 shell:true）
			const execName = path.basename(process.execPath).toLowerCase();
			const command = /^(node|bun)(\.exe)?$/.test(execName) ? process.execPath : "node";
			return { command, args: [cli, ...args] };
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
	}

	// 兜底：PATH 上的 pi（Windows spawn 无 shell 下 .cmd shim 会 ENOENT，尽力而为）
	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// 🚫 永不传 --no-session（审计红线，2026-10-30 用户拍板「子 agent 一定不能用 --no-session
	// 一定要落盘」）：会话文件是审计/恢复/展示的唯一真值；与 piClient 同款禁令。历史教训：
	// 硬编码 --no-session 导致子 agent 转录只活在内存注册表，重启全蒸发、断线不可续跑。
	const args: string[] = ["--mode", "json", "-p"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args, cwd ?? defaultCwd);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (e) => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// A2+B 改造（2026-09-18，用户裁决「按 A2+B 来」）：异步派发 + 中途递话
// 调研结论（dsv4 调研报告，源码级证据）在本文件历史版本 git 有全档，要点：
// - 同步工具阻塞主回合是 pi 工具调用同步的设计，非硬限制；502 连坐 = 子进程挂主回合
//   AbortSignal（runSingleAgent 的 killProc）。异步 = 解绑 signal + 立即返回句柄
// - json 模式无输入通道（stdin 被 stdio:["ignore"] 显式断开），中途递话必须 --mode rpc；
//   rpc 的 steer 同样只能回合间注入（打不断正在跑的工具），这是语义天花板不是 bug
// - Windows 可靠杀子通道 = stdin EOF（rpc 优雅 shutdown）；SIGTERM/SIGKILL 是尽力而为
// - 后台进度通道 = pi.appendEntry（不进 LLM 上下文）→ 会话发 entry_appended 事件 →
//   VS Code 面板 piCore 同进程订阅即得，零轮询零上下文污染
// - 同步路径（json 模式）一行不动：已验证的工作流零风险；async 分支才走 rpc
// ─────────────────────────────────────────────────────────────────────────────

interface AsyncRun {
	handle: string;
	agent: string;
	agentSource: "user" | "project" | "built-in" | "unknown";
	agentScope: AgentScope;
	task: string;
	model?: string;
	startedAt: number;
	endedAt?: number;
	status: "running" | "completed" | "failed" | "killed";
	error?: string;
	/** 主会话心跳节流（heartbeatIfDue）：上次推「进行中」摘要的时刻 */
	lastHeartbeatAt?: number;
	result: SingleResult;
	proc: ChildProcess;
	/** rpc 请求通道（startAsyncRun 装配）：递话/查询走它；进程关闭后调用返回 success:false */
	request?: (cmd: Record<string, unknown>) => Promise<any>;
}

const asyncRuns = new Map<string, AsyncRun>();
let asyncSeq = 0;
// 启动对账（P0-3 台账，2026-10-30）：孤儿收尸 + 句柄序号续接（重启后 sa-N 不回退
// 重号，防台账串档）。教训：内存注册表重启蒸发后「列表状态全没」，台账是跨重启真值。
reconcileRuns();
asyncSeq = maxHandleSeq();
let reqSeq = 0;
const ASYNC_MESSAGE_TAIL = 20; // entry 落 session 文件，messages 只带尾窗防 O(n²) 膨胀（注册表保全量）

/**
 * 异步派发主引擎：rpc 子进程 + 注册表 + 进度推送。
 * 关键差异 vs runSingleAgent（同步 json 路径）：
 * - 不绑主回合 AbortSignal（502/中止不再连坐杀子进程）；kill 只走 subagent_kill
 * - stdin 保持打开：递话/优雅停止的通道；json 路径是 stdio:["ignore"] 没有这个能力
 * - prompt 经 rpc 协议发（非命令行拼接），长任务文本不进 argv
 */
function startAsyncRun(
	pi: ExtensionAPI,
	run: AsyncRun,
	opts: { cwd: string; cliArgs: string[]; task: string; onClosed?: () => void },
): void {
	const invocation = getPiInvocation(opts.cliArgs, opts.cwd);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: opts.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	run.proc = proc;
	// 台账首写（P0-3）：dispatch 即留痕（子 pid/父 pid 落账），状态迁移逐次改写
	try {
		writeRecord({
			handle: run.handle,
			agent: run.agent,
			model: run.model,
			task: run.task,
			cwd: opts.cwd,
			sessionDir: runDirFor(run.handle),
			pid: proc.pid,
			ownerPid: process.pid,
			startedAt: run.startedAt,
			status: "running",
			reported: false,
		});
	} catch {
		/* 台账失败不阻派单 */
	}
	let buffer = "";
	const pending = new Map<string, (resp: any) => void>();

	// rpc 扩展 UI 子协议：对话型请求（select/confirm/input/editor）必须应答否则子进程永久阻塞；
	// 保守策略一律 cancelled——子 agent 不许代替人批准任何东西
	const answerDialog = (req: any) => {
		try {
			proc.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: req.id, cancelled: true })}\n`);
		} catch {
			/* ignore */
		}
	};

	// rpc 严格 LF 分帧（docs/rpc.md Framing：readline 会吞 U+2028/2029，不能用）
	proc.stdout?.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let evt: any;
			try {
				evt = JSON.parse(line);
			} catch {
				continue;
			}
			if (evt.type === "response") {
				const resolve = pending.get(evt.id);
				if (resolve) {
					pending.delete(evt.id);
					resolve(evt);
				}
				continue;
			}
			if (evt.type === "extension_ui_request") {
				answerDialog(evt);
				continue;
			}
			if (evt.type === "agent_settled" && run.status === "running") {
				// 完成信号：rpc 模式任务跑完子进程不退出（常驻等命令），等 close 会永远等不到——
				// settled = 回合结束且无排队消息，即任务终点。结算 + 推回 + 主动关停（实测事故：
				// 子 agent 早已答完 ok，宿主干等 160s 无终态，就是这里没接）
				run.endedAt = Date.now();
				run.status = isFailedResult(run.result) ? "failed" : "completed";
				markRun(run.handle, {
					status: run.status,
					endedAt: run.endedAt,
					exitCode: run.result.exitCode,
					error: run.error,
					deathReason:
						run.status === "failed"
							? classifyDeath({ killRequested: false, error: run.error, exitCode: run.result.exitCode } as RunRecord)
							: undefined,
				});
				if (run.status === "failed" && !run.error) {
					run.error = run.result.errorMessage || run.result.stderr || "(abnormal stop)";
				}
				emitAsyncProgress(pi, run);
				opts.onClosed?.();
				// 结果回传主会话（送达分档见 reportBackToMain：失败 steer 插队、完成 followUp
				// 排队）；killed 不回传（用户主动终止，已知）
				reportBackToMain(pi, run);
				stopAsyncProc(run); // proc close 另行触发，那里只做 quiet 收尾防双重回传
				continue;
			}
			if (evt.type === "message_end" && evt.message) {
				// 与同步 json 路径同一套累积口径（runSingleAgent processLine），面板快照形状一致
				const msg = evt.message as Message;
				run.result.messages.push(msg);
				if (msg.role === "assistant") {
					run.result.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						run.result.usage.input += usage.input || 0;
						run.result.usage.output += usage.output || 0;
						run.result.usage.cacheRead += usage.cacheRead || 0;
						run.result.usage.cacheWrite += usage.cacheWrite || 0;
						run.result.usage.cost += usage.cost?.total || 0;
						run.result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!run.result.model && msg.model) run.result.model = msg.model;
					if (msg.stopReason) run.result.stopReason = msg.stopReason;
					if (msg.errorMessage) run.result.errorMessage = msg.errorMessage;
				}
				// 主会话监听心跳（2026-10-23）：进度摘要攒批不吵主会话，见 heartbeatIfDue
				heartbeatIfDue(pi, run);
				emitAsyncProgress(pi, run);
			}
		}
	});
	proc.stderr?.on("data", (d: Buffer) => {
		run.result.stderr += d.toString();
	});
	proc.on("error", (e) => {
		run.error = e.message;
	});
	proc.on("close", (code) => {
		run.endedAt ??= Date.now();
		run.result.exitCode = code ?? 0;
		// 状态归 agent_settled 分支或 kill 管；这里是进程退出的 quiet 收尾（防双重结算/回传）
		if (run.status === "running") {
			run.status = code === 0 && !isFailedResult(run.result) ? "completed" : "failed";
			markRun(run.handle, {
				status: run.status,
				endedAt: run.endedAt,
				exitCode: run.result.exitCode,
				error: run.error,
				deathReason:
					run.status === "failed"
						? classifyDeath({ killRequested: false, error: run.error, exitCode: code ?? 0 } as RunRecord)
						: undefined,
				});
			if (run.status === "failed" && !run.error) {
				run.error = run.result.errorMessage || run.result.stderr || `(exit ${code})`;
			}
			emitAsyncProgress(pi, run);
			opts.onClosed?.();
			// 崩溃止损回灌（2026-10-23）：进程异常退出没人发 agent_settled，此前这路只置状态
			// 不回灌——402「27 轮就断」实测事故：主会话永远不知道 sa 挂了，用户问「好了吗」
			// 才发现。防双重回传由 run.status 守卫（settled 先到则这里已非 running）
			reportBackToMain(pi, run);
		}
	});

	// 请求通道：递话/查询用；3s 无响应视为失败（不吊死调用方）
	run.request = (cmd: Record<string, unknown>) => {
		return new Promise((resolve) => {
			const id = `req-${++reqSeq}`;
			pending.set(id, resolve);
			try {
				proc.stdin?.write(`${JSON.stringify({ id, ...cmd })}\n`);
			} catch (e) {
				pending.delete(id);
				resolve({ success: false, error: String(e) });
				return;
			}
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					resolve({ success: false, error: "timeout" });
				}
			}, 3000);
		});
	};

	emitAsyncProgress(pi, run); // 启动即推一帧（面板立刻出浮窗）
	const promptId = `prompt-${run.handle}`;
	pending.set(promptId, (resp: any) => {
		if (resp.success === false) {
			run.status = "failed";
			run.error = typeof resp.error === "string" ? resp.error : "prompt rejected";
			markRun(run.handle, { status: "failed", endedAt: Date.now(), error: run.error, deathReason: "error" });
			killAsyncRun(run);
			// 派单即拒也要回灌（2026-10-23）：工具已返回「已派出 sa-N」，不回灌主会话永远
			// 不知道这单根本没起来。status 已非 running，close 收尾不会重复回灌
			reportBackToMain(pi, run);
		}
	});
	proc.stdin?.write(`${JSON.stringify({ id: promptId, type: "prompt", message: opts.task })}\n`);
}

/** 异步运行的 entry/details 载荷：形状兼容 SubagentDetails，面板 subagentSnapshot() 直接可吃 */
function asyncDetails(run: AsyncRun): SubagentDetails {
	const trimmed: SingleResult = {
		...run.result,
		// 生命周期真值随载荷走（2026-10-23）：run.status 是唯一事实源，落进 details 后
		// 快照、浮窗、会话回放吃同一真值（stopReason 启发式分不清回合收尾/任务收尾）
		running: run.status === "running",
		status: run.status,
		messages: run.result.messages.slice(-ASYNC_MESSAGE_TAIL),
	};
	return { mode: "single", agentScope: run.agentScope, projectAgentsDir: null, results: [trimmed] };
}

/** 结果回传主会话（2026-10-23 送达分档，用户拍板「失败插队、完成排队」）：
 *  失败/异常 → deliverAs:"steer"（回合边界插队，主会话忙也下一轮必见，不被排队压住）；
 *  完成 → deliverAs:"followUp"（排队不打断，完成是常态不抢跑）。
 *  失败文本带原因（error/errorMessage/stderr 截断）——主会话不用再 collect 就知道为什么挂。
 *  killed 不回传（用户主动终止，已知）；双重回传由 run.status 守卫（close/拒单分支
 *  只在结算时进这里一次）。 */
function reportBackToMain(pi: ExtensionAPI, run: AsyncRun): void {
	if (run.status !== "completed" && run.status !== "failed") return;
	const output = truncateParallelOutput(getResultOutput(run.result));
	const head = run.status === "completed" ? "完成" : "失败";
	const reason =
		run.status === "failed"
			? String(run.error || run.result.errorMessage || run.result.stderr || "").trim()
			: "";
	const text = `[子 agent ${run.handle} ${head}] ${run.agent}: ${reason ? reason.slice(0, 300) + " —— " : ""}${output.slice(0, 2000)}`;
	try {
		void pi.sendUserMessage(text, {
			deliverAs: run.status === "failed" ? "steer" : "followUp",
		});
		markRun(run.handle, { reported: true });
	} catch {
		/* 主会话不可达（关闭中）时静默 */
	}
}

/** 主会话监听心跳（2026-10-23 用户拍板「主会话不能纯手工问」）：运行中的子 agent 每 5 分钟
 *  最多推一条「进行中」摘要，deliverAs:"nextTurn" 攒批——不唤醒空闲主会话（steer/followUp
 *  在空闲态会触发整轮，心跳不值这个价），下次任何唤醒（用户提问/终态回灌）随批带上，
 *  主会话开口即见新鲜进度，不必 subagent_list 手工查。终态实时性由 reportBackToMain 保障
 * （失败 steer 插队/完成 followUp）；完整活动流仍归浮窗下钻，上下文增量控制在一行摘要。 */
function heartbeatIfDue(pi: ExtensionAPI, run: AsyncRun): void {
	if (run.status !== "running") return;
	const now = Date.now();
	if (run.lastHeartbeatAt && now - run.lastHeartbeatAt < 5 * 60_000) return;
	run.lastHeartbeatAt = now;
	const msgs = run.result.messages;
	const last = msgs[msgs.length - 1];
	const tail = last ? getResultOutput({ ...run.result, messages: [last] }).slice(0, 120) : "";
	const mins = Math.max(1, Math.round((now - run.startedAt) / 60_000));
	try {
		void pi.sendUserMessage(
			`[子 agent ${run.handle} 进行中] ${mins}分钟/${run.result.usage.turns}轮${tail ? "，最新：" + tail : ""}`,
			{ deliverAs: "nextTurn" }
		);
	} catch {
		/* 主会话不可达（关闭中）时静默 */
	}
}

function emitAsyncProgress(pi: ExtensionAPI, run: AsyncRun) {
	// appendEntry 发 entry_appended 事件给会话订阅者（面板 piCore 消费），不进 LLM 上下文；
	// 同时落 session 文件，会话恢复后可回看（renderEntryRenderer 未注册，TUI 不展示，无噪音）
	try {
		pi.appendEntry("subagent-async", {
			handle: run.handle,
			status: run.status,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			detail: asyncDetails(run),
		});
	} catch {
		/* 面板不在场也要能跑：appendEntry 失败静默 */
	}
}

/** 停 rpc 子进程：stdin EOF（rpc 优雅 shutdown），5s 不退 SIGKILL 兕底；不改 status（调用方负责） */
function stopAsyncProc(run: AsyncRun) {
	try {
		run.proc.stdin?.end();
	} catch {
		/* ignore */
	}
	setTimeout(() => {
		try {
			if (!run.proc.killed) run.proc.kill("SIGKILL");
		} catch {
			/* ignore */
		}
	}, 5000);
}

/** 用户主动终止：置 killed 态（结算/回传分支不进），再停进程 */
function killAsyncRun(run: AsyncRun) {
	if (run.status !== "running") return;
	run.status = "killed";
	markRun(run.handle, { status: "killed", endedAt: Date.now(), killRequested: true, deathReason: "killed" });
	stopAsyncProc(run);
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	async: Type.Optional(
		Type.Boolean({
			description:
				"Fire-and-forget dispatch (single mode only): returns a handle immediately, the agent runs in the background and reports back when done. Use subagent_list/subagent_collect/subagent_steer/subagent_kill to manage it.",
				default: false,
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"MODE SELECTION (default false = sync, waits and returns the result): use async:true when the user asks for background/parallel-with-conversation/non-blocking dispatch (e.g. 后台跑/同时去/别堵着会话/边聊边干); keep sync when they just want a task done and expect the result in this conversation.",
			"async (single mode only) returns a handle immediately — the main session stays free; progress auto-reports and results are pushed back when done. Manage with subagent_list / subagent_collect / subagent_steer / subagent_kill.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// ── A2：异步派发（single 模式专用）——立即返回句柄，子进程后台跑，不绑主回合 signal ──
			if (params.async) {
				if (hasChain || hasTasks || !hasSingle) {
					return {
						content: [{ type: "text", text: "async: true 仅支持 single 模式（agent + task）。" }],
						details: makeDetails("single")([]),
					};
				}
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => a.name).join(", ") || "none";
					return {
						content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
						details: makeDetails("single")([]),
					};
				}
				const handle = `sa-${++asyncSeq}`;
				const run: AsyncRun = {
					handle,
					agent: agent.name,
					agentSource: agent.source,
					agentScope,
					task: params.task!,
					model: agent.model,
					startedAt: Date.now(),
					status: "running",
					result: {
						agent: agent.name,
						agentSource: agent.source,
						task: params.task!,
						exitCode: 0,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						model: agent.model,
					},
					proc: undefined as unknown as ChildProcess,
				};
				asyncRuns.set(handle, run);

				// rpc 子进程：递话/优雅停止都靠 stdin 通道（json 模式没有）
				// 🚫 永不传 --no-session（审计红线，同 runSingleAgent 处注释）：子 agent 会话必须落盘，
				// 落盘即审计、即恢复、即展示（需求文档 P0-1）。
				const cliArgs: string[] = ["--mode", "rpc"];
				const inheritsDispatchConfig = !agent.model;
				if (agent.model) cliArgs.push("--model", agent.model);
				else {
					if (dispatchDefaults.model) cliArgs.push("--model", dispatchDefaults.model);
					if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel)
						cliArgs.push("--thinking", dispatchDefaults.thinkingLevel);
				}
				if (agent.tools && agent.tools.length > 0) cliArgs.push("--tools", agent.tools.join(","));
				// 会话落盘（P0-1，2026-10-30）：每单独立 --session-dir，handle ↔ 子会话目录
				// 一一对应（台账记指针）——子 agent 记录不再绑父会话，「新开项目找不到
				// 子 agent」的治本。禁 --no-session 红线见 runSingleAgent 处注释。
				const runDir = runDirFor(handle);
				fs.mkdirSync(runDir, { recursive: true });
				cliArgs.push("--session-dir", runDir);
				let tmpPromptDir: string | null = null;
				let tmpPromptPath: string | null = null;
				if (agent.systemPrompt?.trim()) {
					const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
					tmpPromptDir = tmp.dir;
					tmpPromptPath = tmp.filePath;
					cliArgs.push("--append-system-prompt", tmpPromptPath);
				}
				startAsyncRun(pi, run, {
					cwd: params.cwd ?? ctx.cwd,
					cliArgs,
					task: params.task!,
					onClosed: () => {
						// 子进程读完 system prompt 临时文件才安全；挂 close 兜底清理（同步路径在 finally 删，异步没那个时机）
						if (tmpPromptPath)
							try {
								fs.unlinkSync(tmpPromptPath);
							} catch {
								/* ignore */
							}
						if (tmpPromptDir)
							try {
								fs.rmdirSync(tmpPromptDir);
							} catch {
								/* ignore */
							}
					},
				});
				return {
					content: [
						{
							type: "text",
							text: `已派出 ${handle}（${agent.name}）后台执行，主会话不阻塞。\nsubagent_list 查进度 / subagent_collect ${handle} 取结果 / subagent_steer ${handle} 递话 / subagent_kill ${handle} 终止。完成或失败时会自动回传一条消息。`,
						},
					],
					details: asyncDetails(run),
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── A2+B 配套工具：异步子 agent 生命周期管理（调研报告 §3 句柄四件套）──

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description:
			"List async subagent runs (handles, status, elapsed time, usage). Check on background agents dispatched with subagent async:true.",
		parameters: Type.Object({}),
		async execute() {
			const runs = [...asyncRuns.values()];
			// 台账历史段（P0-3）：内存注册表外的单子也看得见——「列表状态全没」的治本
			const past = readAllRuns()
				.filter((r) => !asyncRuns.has(r.handle))
				.slice(0, 8);
			if (runs.length === 0 && past.length === 0) {
				return { content: [{ type: "text", text: "当前无后台子 agent。" }] };
			}
			const lines = runs.map((r) => {
				const elapsed = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000);
				return `${r.handle} [${r.status}] ${r.agent} ${elapsed}s ${formatUsageStats(r.result.usage, r.result.model)} — ${r.task.slice(0, 60)}`;
			});
			for (const p of past) {
				const elapsed = Math.round(((p.endedAt ?? Date.now()) - p.startedAt) / 1000);
				lines.push(
					`${p.handle} [${p.status}${p.deathReason ? "/" + p.deathReason : ""}] ${p.agent} ${elapsed}s — ${p.task.slice(0, 60)}${p.reported === false ? "（回传未达）" : ""}（台账）`,
				);
			}
			// details 带 parallel 形状：面板浮窗可整屏展示后台任务列表
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					mode: "parallel",
					agentScope: runs[0]?.agentScope ?? "user",
					projectAgentsDir: null,
					results: runs.slice(-8).map((r) => ({
						...r.result,
						messages: r.result.messages.slice(-ASYNC_MESSAGE_TAIL),
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_collect",
		label: "Subagent Collect",
		description: "Fetch the full result of an async subagent run by handle.",
		parameters: Type.Object({
			handle: Type.String({ description: 'Run handle from dispatch result or subagent_list, e.g. "sa-1"' }),
		}),
		async execute(_toolCallId, params) {
			const run = asyncRuns.get(params.handle);
			if (!run) {
				return {
					content: [
						{ type: "text", text: `无此 handle：${params.handle}（进程重启后后台任务丢失，用 subagent_list 查现存任务）` },
					],
				};
			}
			if (run.status === "running") {
				const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
				return {
					content: [{ type: "text", text: `${run.handle}（${run.agent}）仍在运行中（${elapsed}s），稍后再取结果。` }],
				};
			}
			const output = truncateParallelOutput(getResultOutput(run.result));
			return {
				content: [{ type: "text", text: `[${run.handle} ${run.status}] ${run.agent}\n\n${output}` }],
				details: { mode: "single", agentScope: run.agentScope, projectAgentsDir: null, results: [run.result] },
			};
		},
	});

	pi.registerTool({
		name: "subagent_steer",
		label: "Subagent Steer",
		description:
			"Send a message to a RUNNING async subagent (mid-run steering). Delivered at the agent's turn boundary — it does NOT interrupt a tool currently executing. If you need it dead instead, use subagent_kill.",
		parameters: Type.Object({
			handle: Type.String({ description: 'Run handle, e.g. "sa-1"' }),
			message: Type.String({ description: "Message to deliver to the subagent" }),
		}),
		async execute(_toolCallId, params) {
			const run = asyncRuns.get(params.handle);
			if (!run || run.status !== "running") {
				return { content: [{ type: "text", text: `${params.handle} 不在运行中，无法递话。` }] };
			}
			const resp = await run.request!({ type: "steer", message: params.message });
			const ok = resp.success !== false;
			return {
				content: [
					{
						type: "text",
						text: ok
							? `已向 ${run.handle}（${run.agent}）递话，将在其回合边界送达。`
							: `递话失败：${resp.error}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "subagent_kill",
		label: "Subagent Kill",
		description:
			"Stop a RUNNING async subagent: stdin EOF for graceful shutdown (Windows-reliable), SIGKILL fallback after 5s.",
		parameters: Type.Object({
			handle: Type.String({ description: 'Run handle, e.g. "sa-1"' }),
		}),
		async execute(_toolCallId, params) {
			const run = asyncRuns.get(params.handle);
			if (!run) {
				return { content: [{ type: "text", text: `无此 handle：${params.handle}` }] };
			}
			if (run.status !== "running") {
				return { content: [{ type: "text", text: `${run.handle} 已结束（${run.status}），无需终止。` }] };
			}
			killAsyncRun(run);
			return {
				content: [{ type: "text", text: `已向 ${run.handle} 发送停止（stdin EOF 优雅关闭，5s 后强杀兕底）。已产生的文件改动不会自动撤销。` }],
			};
		},
	});

	// 会话关闭不杀后台子进程（2026-10-30 需求文档 P0-3「父会话关闭不杀子进程」拍板）：
	// 子进程独立跑完落盘走人，父回来后从台账重建列表（reconcileRuns 自动标 orphaned/
	// 收尸定死因）——这是断线续跑的前提。旧全杀行为 = 断线/换会话子 agent 全灭 +
	// 内存注册表蒸发，双倍重跑成本（工单 12 断线实测）。显式终止只属于 subagent_kill。
	pi.on("session_shutdown", async () => {
		/* 故意不杀：见上。killAsyncRun 只由 subagent_kill / 拒单路径调用。 */
	});
}
