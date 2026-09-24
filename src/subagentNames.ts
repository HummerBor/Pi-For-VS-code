/**
 * 子 agent「显示名 / 调用分类」两层分离（2026-09-24 用户拍板，原话）：
 * - 「名字应该可以随便取」——展示层显示调用方给的名字（test-agent、general-purpose…）；
 * - 「实际调用的应该还是按 pi 去分类」——派发必须落 pi 注册分类（planner/scout/worker…），
 *   否则 subagent 工具报 Unknown agent「老报名字错误」。
 *
 * 分工（pi 内容零改动，映射全在插件侧）：
 * - 本文件 = 纯逻辑半边：台账 + 归位算法。零依赖（连相对 import 都没有）——
 *   webview 共享编译（无 node 类型）与 node 裸跑用例（相对导入要扩展名）两头都要过，
 *   别往这里 import 任何东西，也别加 fs/path（宿主半边在 subagentNameGuard.ts）。
 * - subagentNameGuard.ts = 派发层钩子（宿主专用）：tool_call 时把未注册名归位默认分类
 *   （worker 优先，否则第一个注册名），挂在 piClient 的内联扩展口。
 * - subagentSnapshot.ts = 展示层（依赖倒置）：snapTask 经注入的查表显示调用名，
 *   台账缺（重启后/旧记录）回退分类名。
 *
 * 台账口径：key=完整任务文本（details.results[].task 与调用参数同源，不截断；同步/并行/
 * 链式/异步结算同一张表，不用 toolCallId 对表）。同文不同名后写覆盖（名字「随便取」）。
 * 台账是进程级内存——重启后历史条目回退显示分类名（展示层回退口径，不追现场）。
 */

/** 任务文本 → 调用名（见头注释台账口径） */
const displayNames = new Map<string, string>();

/** 记台账：必须在归位改写【之前】调用（记的是调用方给的原名） */
export function noteDispatchNames(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const rec = input as Record<string, unknown>;
  const slot = (s: unknown): void => {
    if (!s || typeof s !== "object") return;
    const o = s as Record<string, unknown>;
    if (typeof o.agent === "string" && typeof o.task === "string") displayNames.set(o.task, o.agent);
  };
  slot(rec);
  if (Array.isArray(rec.tasks)) rec.tasks.forEach(slot);
  if (Array.isArray(rec.chain)) rec.chain.forEach(slot);
}

/** 展示名查表：台账缺（重启后/旧记录）返回 undefined，调用方回退分类名 */
export function displayNameFor(task: string | undefined): string | undefined {
  return task === undefined ? undefined : displayNames.get(task);
}

/** 测试用：清台账 */
export function resetDisplayNames(): void {
  displayNames.clear();
}

/**
 * 归位一条调用名：已是 pi 注册分类原样；否则归默认分类。
 * 注册表为空时原样返回（归无可归，把报错权留给 pi）。
 */
export function classifyDispatchName(name: string, valid: string[], fallback: string | null): string {
  if (valid.includes(name)) return name;
  return fallback ?? name;
}

/** 归位整份 subagent 入参：single 的 agent + tasks[]/chain[] 每个槽位（task 文本不动） */
export function rewriteSubagentInput(input: Record<string, unknown>, resolve: (name: string) => string): void {
  const fixSlot = (slot: unknown): void => {
    if (!slot || typeof slot !== "object") return;
    const s = slot as Record<string, unknown>;
    if (typeof s.agent === "string") s.agent = resolve(s.agent);
  };
  fixSlot(input);
  if (Array.isArray(input.tasks)) input.tasks.forEach(fixSlot);
  if (Array.isArray(input.chain)) input.chain.forEach(fixSlot);
}
