/**
 * 把 pi 的运行时 bundle 拷进 vendor/pi/（随 vsix 分发，用户免装 pi/node）。
 *
 * 拷贝内容只有 dist/bundle/（单文件 bundle，自包含，仅依赖 node 内置模块）+ package.json
 * （提供 "type":"module" 和版本号，piSdk 加载/报错要用）。不拷 dist 库入口（884 文件
 * 模块图）——piSdk 加载顺序里 bundle 优先，旧版包回退才用库入口，内置包永远有 bundle。
 *
 * 由 npm run compile 调用（2026-10-26 拍板：pi 内置随插件分发，「零运行时依赖」废止），
 * 保证 vsix 里的 pi 版本 = 构建时 node_modules 里的版本，发新版 pi 时重新 compile 即跟上。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 手动定位而非 require.resolve：pi 包 package.json 限定了 exports 子路径，
// "./package.json" 不在导出表里，resolve 会被 exports 挡掉（2026-10-26 踩过）
const pkgRoot = join(
  repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"
);
if (!existsSync(join(pkgRoot, "package.json"))) {
  console.error("[vendor-pi] 找不到 pi 包（node_modules 里没有？先 npm install）");
  process.exit(1);
}

const srcBundle = join(pkgRoot, "dist", "bundle");
if (!existsSync(join(srcBundle, "index.js"))) {
  console.error("[vendor-pi] pi 包缺少 dist/bundle/index.js（版本过旧？）: " + pkgRoot);
  process.exit(1);
}

const dst = join(repoRoot, "vendor", "pi");
mkdirSync(join(dst, "dist"), { recursive: true });
cpSync(srcBundle, join(dst, "dist", "bundle"), { recursive: true });

// bundle 的硬外部依赖（2026-10-26 实锤：0.85 需要 @earendil-works/chord，1.4 不再引用）
// 随 pi 版本变，不写死清单：扫 bundle 里的 @earendil-works/* 静态引用，有引用才拷，
// 拷不到就报错拦截。其余 require（supports-color/bufferutil 等）都是 try/catch
// 懒加载可选依赖，不拷。冒烟（下方）是最终兑底，缺依赖 import 当场崩
const bundleFiles = readdirSync(join(dst, "dist", "bundle"), { recursive: true });
const externals = new Set();
for (const f of bundleFiles) {
  if (!f.endsWith(".js")) continue;
  const code = readFileSync(join(dst, "dist", "bundle", String(f)), "utf8");
  // 只认真实 import/require 语句的模块名——Symbol.for("pkg:...") 这类字符串字面量
  // 不是依赖（首版正则误吞过，报 "找不到 @earendil-works/pi-coding-agent:theme"）
  for (const m of code.matchAll(
    /(?:from\s*|import\s*|require\s*\(\s*)["'](@earendil-works\/[a-z0-9-]+)["']/g
  )) {
    externals.add(m[1]);
  }
}
for (const dep of externals) {
  const depSrc = join(pkgRoot, "node_modules", dep);
  const depTop = join(repoRoot, "node_modules", dep); // npm 可能提升到顶层
  const src = existsSync(join(depSrc, "package.json"))
    ? depSrc
    : existsSync(join(depTop, "package.json"))
      ? depTop
      : null;
  if (!src) {
    console.error("[vendor-pi] 找不到 bundle 硬依赖 " + dep + "（两处 node_modules 都没有）");
    process.exit(1);
  }
  cpSync(src, join(dst, "node_modules", dep), {
    recursive: true,
    filter: (s) => !/[\\/]src([\\/]|$)/.test(s), // 只拷产物，src/ 源码不需要
  });
  console.log("[vendor-pi] 拷入硬依赖 " + dep);
}

// package.json 只保留加载/版本所需字段（别拷整个文件：pi 包的 scripts/exports 无关且误导）
const srcPkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
writeFileSync(
  join(dst, "package.json"),
  JSON.stringify({ name: srcPkg.name, version: srcPkg.version, type: srcPkg.type }, null, 2) + "\n"
);

console.log("[vendor-pi] 已拷贝 pi " + srcPkg.version + " → vendor/pi/dist/bundle");

// 冒烟硬校验：从 vendor 目录（不碰仓库 node_modules）真实 import 一次 bundle，
// 缺硬依赖/缺 SDK 入口当场报错退出——不带病进 vsix（chord 事故就靠这道拦下来的）
const smoke = new Function(
  "u",
  "return import(u)"
);
try {
  const sdk = await smoke(pathToFileURL(join(dst, "dist", "bundle", "index.js")).href);
  const required = [
    "createAgentSessionRuntime",
    "createAgentSessionServices",
    "createAgentSessionFromServices",
    "SessionManager",
    "DefaultResourceLoader",
    "getAgentDir",
  ]; // 与 src/pi/piSdk.ts 的加载校验同清单，改一处要改两处
  const missing = required.filter((k) => sdk[k] === undefined);
  if (missing.length) {
    console.error("[vendor-pi] 冒烟失败：bundle 缺 SDK 入口 " + missing.join("/"));
    process.exit(1);
  }
  console.log("[vendor-pi] 冒烟通过：SDK 入口齐全");
} catch (err) {
  console.error("[vendor-pi] 冒烟失败：" + String(err?.message ?? err));
  process.exit(1);
}
