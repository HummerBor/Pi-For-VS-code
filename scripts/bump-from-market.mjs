// bump 版本（ship 专用）：以市场已发布版本为基准 patch+1，让发版号顺着市场走。
// 背景（2026-09-22 用户拍板）：bump-version.mjs 按本地号自增，而本地 package/package
// 循环把号刷到 0.1.71、市场停在 0.1.34——ship 再自增会发布出比市场高几十号的断崖版本。
// 基准来源：vsce show <publisher>.<name> 的 Version 字段（公开接口，无需 PAT，实测可用）。
// PI_VER 仍可显式指定（跳号/补发用）；目标 ≤ 市场版本会被市场拒收（降版禁令），只警告不拦截。
// 失败语义：市场查询失败即退出非零——宁可不发，不许静默回落本地自增（那会重现断崖）。
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ID = "HummerBor.pi-for-vscode";
const v = process.env.PI_VER;

let target = v;
if (!target) {
  let out = "";
  try {
    out = execSync(`npx @vscode/vsce show ${ID}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    console.error("[bump-market] ✗ 市场版本查询失败——不回落本地自增（宁可不发）");
    console.error("[bump-market]   稍后重试，或 PI_VER=x.y.z 显式指定版本号");
    process.exit(1);
  }
  const m = out.match(/Version:\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    console.error("[bump-market] ✗ 未能从 vsce show 输出解析出版本号——不回落本地自增");
    process.exit(1);
  }
  target = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

const local = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
if (target <= local) {
  console.warn(`[bump-market] ⚠ 目标 ${target} ≤ 本地 package.json 版本 ${local}`);
  console.warn("[bump-market]   本地测试号高于市场属正常（本地包从未发布）；但若目标 < 市场版本，publish 会被拒收");
}
if (v) console.log(`[bump-market] PI_VER 显式指定：${target}`);
else console.log(`[bump-market] 市场基准 bump：${local} → ${target}`);

execSync(`npm version ${target} --no-git-tag-version --allow-same-version`, { stdio: "inherit" });
