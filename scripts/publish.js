#!/usr/bin/env node
/**
 * 工单五-4：ship 尾段加固。
 * 旧链 `git push && vsce publish` 任一失败都会静默跳过后续步骤——09-09 实际翻车：
 * 代理未开 push 失败，publish 未执行，终端只有一行报错不显眼，差点以为发版成功。
 * 这里逐步执行、逐步检查，失败红字提示并非零退出；成功绿字确认。
 * （package.json "ship" 尾段调用；git push 与 vsce publish 由本脚本托管）
 */
"use strict";
const { spawnSync } = require("child_process");

function run(step, cmd, args) {
  console.log("\x1b[36m[ship] " + step + ": " + cmd + " " + args.join(" ") + "\x1b[0m");
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("\x1b[1;31m[ship] ✗ " + step + " 失败（退出码 " + r.status + "）——后续步骤已跳过！\x1b[0m");
    console.error("\x1b[1;31m[ship]   提交仍保留在本地；修复后手动补跑: git push && npx @vscode/vsce publish\x1b[0m");
    process.exit(r.status || 1);
  }
  console.log("\x1b[32m[ship] ✓ " + step + " 完成\x1b[0m");
}

run("推送到远程", "git", ["push"]);
run("发布到市场", "npx", ["@vscode/vsce", "publish"]);
console.log("\x1b[1;32m[ship] 发版完成：远程已更新 + 市场已发布\x1b[0m");
