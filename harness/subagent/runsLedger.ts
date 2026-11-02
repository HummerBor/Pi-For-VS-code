/**
 * Subagent 运行台账（P0-3 自研段，2026-10-30 用户拍板「该处理就处理」）
 *
 * 为什么存在：asyncRuns 注册表是内存 Map，宿主重启即蒸发——「插件看不到子 agent、
 * 列表状态全没」「无此 handle，进程重启后后台任务丢失」的根因。台账 = 每个 handle
 * 一条 JSON 落盘记录：dispatch 首写、状态迁移改写、kill 留 killRequested 终态；
 * 启动对账（reconcileRuns）扫一遍做孤儿收尸——pid 已死的 running 记录落终态定死因，
 * 子活父死的标 orphaned 挂回。
 *
 * 布局（抄 CC 的 subagents/ 隔离思路，见需求文档 P0-1/P0-3）：
 *   <agentDir>/sessions/subagents/<handle>/            子会话文件（--session-dir 指这里）
 *   <agentDir>/sessions/subagents/runs/<handle>.json   本台账记录
 *
 * 纪律：本模块是观测面，任何异常静默吞掉，绝不许把派单主链路弄崩；
 * 只依赖 getAgentDir（pi 公开 API），不碰 pi 内部实现。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RunRecord {
	handle: string;
	agent: string;
	model?: string;
	task: string;
	cwd: string;
	/** 子会话落盘目录（--session-dir 指向它，handle ↔ 目录一一对应） */
	sessionDir: string;
	/** 子进程 pid（死亡判定依据） */
	pid?: number;
	/** 派单方 pi 进程 pid（孤儿判定：父死子活 → orphaned） */
	ownerPid?: number;
	/** 派单方会话文件（2026-11-02）：左侧列表把子会话挂在对应主会话下面用它，
	 *  无此值的老记录落到「未归属」组 */
	parentSession?: string;
	startedAt: number;
	endedAt?: number;
	status: "running" | "completed" | "failed" | "killed" | "orphaned";
	exitCode?: number;
	error?: string;
	deathReason?: "killed" | "content_filter" | "quota" | "disconnected" | "error";
	killRequested?: boolean;
	/** 回传主会话是否已发（对账补送的依据，见需求文档 P0-3「回传不丢」） */
	reported?: boolean;
}

export function subagentsBase(): string {
	return path.join(getAgentDir(), "sessions", "subagents");
}

export function runDirFor(handle: string): string {
	return path.join(subagentsBase(), handle);
}

function runsDir(): string {
	return path.join(subagentsBase(), "runs");
}

function recordPath(handle: string): string {
	return path.join(runsDir(), `${handle}.json`);
}

/** 原子写（tmp+rename）：半截 json 比没有台账更害人（对账读到烂文件会误判终态） */
export function writeRecord(rec: RunRecord): void {
	try {
		fs.mkdirSync(runsDir(), { recursive: true });
		const p = recordPath(rec.handle);
		const tmp = `${p}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
		fs.renameSync(tmp, p);
	} catch {
		/* 台账失败不阻派单 */
	}
}

export function markRun(handle: string, patch: Partial<RunRecord>): void {
	try {
		const cur = readRecord(handle);
		if (!cur) return;
		writeRecord({ ...cur, ...patch });
	} catch {
		/* ignore */
	}
}

export function readRecord(handle: string): RunRecord | undefined {
	try {
		const raw = fs.readFileSync(recordPath(handle), "utf8");
		return JSON.parse(raw) as RunRecord;
	} catch {
		return undefined;
	}
}

/** 全量台账，按 startedAt 倒序（subagent_list 的历史段用） */
export function readAllRuns(): RunRecord[] {
	try {
		const files = fs.readdirSync(runsDir()).filter((f) => f.endsWith(".json"));
		const out: RunRecord[] = [];
		for (const f of files) {
			try {
				out.push(JSON.parse(fs.readFileSync(path.join(runsDir(), f), "utf8")));
			} catch {
				/* 单条烂文件跳过 */
			}
		}
		out.sort((a, b) => b.startedAt - a.startedAt);
		return out;
	} catch {
		return [];
	}
}

function pidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		// EPERM = 活着但没权限打信号；ESRCH = 死了
		return e?.code === "EPERM";
	}
}

export function classifyDeath(rec: RunRecord): RunRecord["deathReason"] {
	if (rec.killRequested) return "killed";
	const err = String(rec.error ?? "");
	if (/content[_ -]?filter|harmful|有害/i.test(err)) return "content_filter";
	if (/402|quota|insufficient|balance|余额|欠费/i.test(err)) return "quota";
	if (rec.exitCode === 0) return "error";
	return "disconnected";
}

/** 句柄序号续接：重启后 sa-N 不许回退重号（台账按 handle 归档，重号会串档） */
export function maxHandleSeq(): number {
	let max = 0;
	for (const r of readAllRuns()) {
		const m = /^sa-(\d+)$/.exec(r.handle);
		if (m) max = Math.max(max, parseInt(m[1], 10));
	}
	return max;
}

/**
 * 启动对账（孤儿收尸）：扫台账收敛悬挂状态。
 * - running 且子 pid 死 → 落终态（按 killRequested/stderr/exitCode 定死因）
 * - running 且子活父死（ownerPid 不在）→ 标 orphaned 挂回（可 collect/kill）
 * - 子活父活 → 不碰（人家正在跑）
 */
export function reconcileRuns(): void {
	for (const rec of readAllRuns()) {
		if (rec.status !== "running") continue;
		const childAlive = pidAlive(rec.pid);
		const ownerAlive = pidAlive(rec.ownerPid);
		if (childAlive) {
			if (!ownerAlive && rec.status === "running") {
				writeRecord({ ...rec, status: "orphaned" });
			}
			continue;
		}
		const finalStatus: RunRecord["status"] = rec.killRequested ? "killed" : "failed";
		writeRecord({
			...rec,
			status: finalStatus,
			endedAt: rec.endedAt ?? Date.now(),
			deathReason: rec.deathReason ?? classifyDeath(rec),
		});
	}
}
