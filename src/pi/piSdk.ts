/**
 * pi SDK 运行时加载器——进程内直连的地基。
 *
 * 架构决定（用户拍板 2026-09-09）：插件从「spawn pi --mode rpc 子进程 + JSON 管道遥控」
 * 改为「进程内 import 用户已装的 pi 包，直接持有 AgentSession 对象」。
 * 动机：RPC 跨进程拿不到同步状态，busy/队列全靠镜像+启发式去猜（4s 兜底、三层对账、
 * 队列变短启发式全是这一层的病）；进程内 isStreaming/队列内容直读，这类 bug 整类消灭。
 *
 * 三条边界（改这里的代码前先读）：
 * 1. vsix 不携带 pi——前置条件与 RPC 时代一致：用户机器必须装有 pi（pi 命令在 PATH）。
 *    pi 包进 devDependencies 仅为类型参考，零运行时依赖铁律不破。
 * 2. pi 是 ESM-only（"type":"module"），本扩展 tsc 编译为 CommonJS，直接写 import()
 *    会被 tsc 转译成 require() 拉不动——必须走 new Function 保留原生 import()（CJS→ESM
 *    标准桥）。别"优化"掉这个 Function。
 * 3. SDK 内部 API 无跨版本兼容承诺（RPC 的 JSON 协议才有文档承诺）。加载后校验关键
 *    入口存在，缺失时给结构化报错，不让 TypeError 裸冒到 UI。
 */

import { existsSync, readFileSync } from "fs";
import { delimiter, dirname, join } from "path";
import { pathToFileURL } from "url";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** 用户没装 pi 或定位失败时的报错（panel 会接住并展示「安装 pi」按钮） */
export class PiNotFoundError extends Error {
  constructor(detail: string) {
    super("未找到 pi 包（" + detail + "）。请先安装 pi：npm install -g " + PI_PACKAGE);
    this.name = "PiNotFoundError";
  }
}

/**
 * CJS→ESM 桥。tsc 在 module:commonjs 下会把源码里的 import() 编译成 require()，
 * 而 pi 包只有 import 导出条件——new Function 里的 import() 是源码字符串，
 * tsc 碰不到它，运行时保留原生动态 import 语义。
 */
const dynamicImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

let cached: Promise<any> | null = null;

/** 加载 pi SDK（进程内缓存，多次调用共享同一次定位+import） */
export function loadPiSdk(): Promise<any> {
  if (!cached) {
    cached = doLoad().catch((err) => {
      cached = null; // 失败不缓存，下次调用重试（用户可能刚装好 pi）
      throw err;
    });
  }
  return cached;
}

async function doLoad(): Promise<any> {
  const root = findPiPackageRoot();
  if (!root) throw new PiNotFoundError("PATH 上没有 pi 命令，本地 node_modules 里也没有");
  // M 刀（2026-09-23 启动慢实锤）：优先加载单文件 bundle（dist/bundle/index.js）——
  // 库入口 dist/index.js 是 884 个文件的模块图，冷缓存/高负载下 import 实测 2~16s
  // （scripts/probe-boot-timing.mjs：冷 15.7s / 热 1.2s；bundle 恒 ~0.4s）。终端 pi
  // 秒开正因它跑的就是同目录的 bundle（dist/bundle/cli.js）——一文件 vs 八百文件的
  // 读盘/杀软扫描差，不是代码变慢（用户问「版本倒退？」答案：这跳从第一天就有）。
  // API 面两路等价（下方 required 校验兜兼容）；旧版包无 bundle 时回退库入口，不劣于现状。
  const bundleEntry = join(root, "dist", "bundle", "index.js");
  const entry = existsSync(bundleEntry) ? bundleEntry : join(root, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new PiNotFoundError("包目录存在但缺少入口: " + entry);
  }
  // 【宿主指路契约】给子 agent 扩展（~/.pi/agent/extensions/subagent 的 getPiInvocation）
  // 指明子进程入口。宿主里 argv[1] 不是 pi，子任务 cwd 也未必装了 pi（换项目就死，
  // 2026-09-18 六连挂事故）；插件既然已经定位到包根，入口就该由宿主递下去，
  // 而不是让扩展自己摸 PATH。env 会被子进程继承，嵌套派发同样命中
  const cliEntry = join(root, "dist", "bundle", "cli.js");
  if (existsSync(cliEntry)) process.env.PI_CLI_ENTRY = cliEntry;
  let sdk: any;
  try {
    sdk = await dynamicImport(pathToFileURL(entry).href);
  } catch (err) {
    throw new Error("pi 包加载失败（" + root + "）: " + String((err as Error)?.message ?? err));
  }
  // 关键入口校验：适配器（piClient.ts）按这套 API 面实现，缺一项就明确报版本问题
  const required = [
    "createAgentSessionRuntime",
    "createAgentSessionServices",
    "createAgentSessionFromServices",
    "SessionManager",
    "DefaultResourceLoader",
    "getAgentDir",
  ];
  const missing = required.filter((k) => sdk[k] === undefined);
  if (missing.length) {
    throw new Error(
      "pi 包缺少 SDK 入口 " + missing.join("/") + "（版本过旧或过新？）: " + root
    );
  }
  return sdk;
}

/**
 * 定位用户已安装的 pi 包根目录。
 * 顺序：本地 node_modules（开发场景）→ PATH 上的 pi 命令反推（发布场景）。
 */
export function findPiPackageRoot(): string | null {
  // 1) 本地 node_modules（仓库内开发/测试时 pi 在 devDependencies）
  try {
    const pkgJson = require.resolve(join(PI_PACKAGE, "package.json"));
    return dirname(pkgJson);
  } catch {
    // 继续走 PATH
  }

  // 2) PATH 上的 pi 命令（nvm-windows: <nodeDir>/pi.cmd；npm 全局: <prefix>/pi.cmd 或 <prefix>/bin/pi）
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  let shim: string | null = null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, "pi" + ext);
      if (existsSync(candidate)) {
        shim = candidate;
        break;
      }
    }
    if (shim) break;
  }
  if (!shim) return null;

  // Windows：npm 全局布局下 shim 与 node_modules 同级（nvm-windows 和 npm prefix 都如此）
  if (process.platform === "win32") {
    const pkg = join(
      dirname(shim),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent"
    );
    return existsSync(join(pkg, "package.json")) ? pkg : null;
  }

  // POSIX：pi 通常是 npm 建的 symlink（指向 <prefix>/lib/node_modules/<pkg>/dist/cli.js），
  // realpath 解析后沿父目录向上找 package.json 且 name 匹配
  let real: string;
  try {
    real = require("fs").realpathSync(shim) as string;
  } catch {
    real = shim;
  }
  let dir = dirname(real);
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(pkg, "package.json"))) return pkg;
    const pkgJsonPath = join(dir, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const name = (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string }).name;
        if (name === PI_PACKAGE) return dir;
      } catch {
        // 读不动就继续向上
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
