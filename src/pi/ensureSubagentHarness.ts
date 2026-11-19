/**
 * 内置 harness 扩展同步（2026-10-30 用户拍板「内置到 pi-vscode，别新开一个项目就找不到子 agent」）。
 *
 * 为什么：subagent 扩展（派单/台账/列表，harness/subagent/）此前只装在开发机
 * ~/.pi/agent/extensions，换机器/换环境开箱就没有子 agent 能力。照 vendor-pi 先例
 * 「内置随插件分发」：harness 源码随 vsix 走（harness/<bundle>/，.vscodeignore 黑名单
 * 制自动进包），激活建 services 前同步到 <agentDir>/extensions/<bundle>，pi 原生扩展
 * 机制照常加载——插件是壳，能力用 pi 的。
 *
 * 多 bundle（工单34 泛化，2026-11-19）：记忆接力（harness/memory/）是第二个内置 bundle，
 * 与 subagent 同一条同步路，**各自独立版本门**——一个 bundle 版本落后不该拖累另一个，
 * 一个拷失败也不许拦另一个。
 *
 * 版本门（各 bundle 自己的 harness.json version，只增不减）：bundled > target 才覆盖——
 * 尊重本地修改，不无脑覆写；目标缺失直接装。同步失败绝不抛：观测面不许阻会话创建。
 *
 * 导出名与语义保持不变（ensureSubagentHarness / syncSubagentHarness）：动的是内部循环，
 * piClient 的调用点与既有探针 scripts/test/subagentSync.test.mjs 一行不用改。
 */

import * as fs from "fs";
import { dirname, join } from "path";

/** 每个 bundle 的文件清单：index.ts 是存在性判据（没有它就不是一个可加载的扩展目录） */
const BUNDLES: Array<{ name: string; files: string[] }> = [
	{ name: "subagent", files: ["index.ts", "agents.ts", "runsLedger.ts", "harness.json"] },
	{ name: "memory", files: ["index.ts", "digest.ts", "harness.json"] },
];
let synced = false;

function readVersion(dir: string): number {
	try {
		const raw = fs.readFileSync(join(dir, "harness.json"), "utf8");
		const v = JSON.parse(raw)?.version;
		return typeof v === "number" ? v : 0;
	} catch {
		// 无 harness.json = 上古安装（或非本插件所装），按 0 算——首装即接管
		return 0;
	}
}

/** 扩展根目录定位：out/pi/xxx.js 上两级（findPiPackageRoot 同款口径） */
function bundledDir(name: string): string {
	return join(dirname(dirname(__dirname)), "harness", name);
}

export function ensureSubagentHarness(agentDir: string): void {
	if (synced) return;
	synced = true;
	syncSubagentHarness(agentDir);
}

/** 同步核心（无幂等门，探针直接测装/版本门/不覆写三分支；现在一次跑全部 bundle） */
export function syncSubagentHarness(agentDir: string): void {
	for (const bundle of BUNDLES) {
		try {
			syncBundle(agentDir, bundle.name, bundle.files);
		} catch {
			/* 单个 bundle 同步失败不阻会话创建，也不拦后面的 bundle */
		}
	}
}

function syncBundle(agentDir: string, name: string, files: string[]): void {
	const src = bundledDir(name);
	if (!fs.existsSync(join(src, "index.ts"))) return; // 源缺失（异常包），不折腾
	const dst = join(agentDir, "extensions", name);
	const targetHas = fs.existsSync(join(dst, "index.ts"));
	if (targetHas && readVersion(dst) >= readVersion(src)) return;
	fs.mkdirSync(dst, { recursive: true });
	for (const f of files) {
		const from = join(src, f);
		if (fs.existsSync(from)) fs.copyFileSync(from, join(dst, f));
	}
}
