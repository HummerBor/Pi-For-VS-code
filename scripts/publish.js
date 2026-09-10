#!/usr/bin/env node
/**
 * 工单十二：ship/publish 机械闸门。
 *
 * 事故：小模型读 DIRECTOR.md 后擅自跑发版一条龙（0.0.82），"读而不守"比"不读"更危险。
 * 闸门靠交互确认而非模型纪律——读而不守的防不住，闸门比人品可靠。
 *
 * 闸门规则：
 *  ① 交互式：打印目标版本号 + 将提交的文件清单，需键入 `yes` 才继续
 *  ② 非 TTY 环境：要求 PI_CONFIRM_SHIP=1 环境变量，二者缺一即红字退出非零
 *  ③ git add 后逐 hunk 打印归属确认（AGENTS.md「同一工作区 git 单写方」机械化）
 *
 * （package.json "ship" 尾段调用；git add/commit/push/publish 全流程托管）
 */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const cwd = __dirname + "/..";

// ── 输入读取：Windows 主场景用 PowerShell Read-Host ────────────
// 选型理由：process.stdin.read(1) 紧循环阻塞事件循环 → I/O 永不处理
// → read() 恒 null → 100% CPU 空转挂死（构造性死锁）。spawnSync
// 调用 PowerShell Read-Host 为真正阻塞调用，能拿回键入值，无空转风险。
// POSIX 分支可加 fs.readFileSync(0, "utf8") 但本项目仅 Windows 使用，
// 不加跨平台分支。禁止引入 readline-sync 等新依赖。
function readInput(prompt) {
  var r = spawnSync("powershell", ["-NoProfile", "-Command", "Read-Host '" + prompt + "'"], {
    encoding: "utf-8",
    cwd: cwd,
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (r.status !== 0) {
    console.error("\x1b[1;31m[ship] ✗ 读取输入失败（exit " + r.status + "）\x1b[0m");
    process.exit(1);
  }
  // 管道回显双行（"yes\nyes"），取最后一行非空行，避免 trim 把真 yes 判成假
  var lines = (r.stdout || "").split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

// ── 0. 闸门：确认拦截 ──────────────────────────────────────────
function confirmShip() {
  // 非交互环境检查 PI_CONFIRM_SHIP
  if (!process.stdout.isTTY) {
    if (process.env.PI_CONFIRM_SHIP !== "1") {
      console.error("\x1b[1;31m[ship] ✗ 非交互环境，需设 PI_CONFIRM_SHIP=1 环境变量\x1b[0m");
      console.error("\x1b[1;31m[ship]   export PI_CONFIRM_SHIP=1  或   直接在终端运行\x1b[0m");
      process.exit(1);
    }
    return true; // 非 TTY + 变量已设，跳过交互式确认
  }

  // 读取当前版本号
  var pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
  console.log("\x1b[36m[ship] ========== 发版确认 ==========\x1b[0m");
  console.log("\x1b[33m目标版本：" + pkg.version + "\x1b[0m");

  var input = readInput("即将执行：git add -A → 逐hunk确认 → git commit → push → publish。键入 yes 继续：");
  if (input !== "yes") {
    console.error("\x1b[1;31m[ship] ✗ 确认失败，已取消发版\x1b[0m");
    process.exit(1);
  }
  console.log("\x1b[32m[ship] ✓ 已确认\x1b[0m");
}

// 闸门：先确认，再 git add，再逐 hunk 确认
function runShip() {
  confirmShip();

  console.log("\x1b[36m[ship] git add -A\x1b[0m");
  var r1 = spawnSync("git", ["add", "-A"], { stdio: "inherit", cwd: cwd });
  if (r1.status !== 0) {
    console.error("\x1b[1;31m[ship] ✗ git add -A 失败\x1b[0m");
    process.exit(r1.status || 1);
  }

  // 逐 hunk 打印归属确认
  console.log("\x1b[36m[ship] 逐 hunk 确认文件归属...\x1b[0m");
  var r2 = spawnSync("git", ["diff", "--cached"], { cwd: cwd, encoding: "utf-8" });
  var diffText = r2.stdout;
  if (diffText) {
    var hunks = diffText.split(/^diff --git/m).filter(Boolean);
    hunks.forEach(function (h) {
      var header = h.split("\n")[0];
      console.log("\x1b[33m--- " + header + " ---\x1b[0m");
      console.log(h);
    });
    // PI_CONFIRM_SHIP=1 时跳过交互（CI/自动化场景）
    if (process.env.PI_CONFIRM_SHIP !== "1") {
      var input2 = readInput("确认以上 hunk 归属无误，键入 yes 继续：");
      if (input2 !== "yes") {
        console.error("\x1b[1;31m[ship] ✗ hunk 确认失败，已取消发版\x1b[0m");
        process.exit(1);
      }
      console.log("\x1b[32m[ship] ✓ 已确认\x1b[0m");
    } else {
      console.log("\x1b[32m[ship] ✓ hunk 确认（PI_CONFIRM_SHIP 已设，跳过交互）\x1b[0m");
    }
  } else {
    console.log("\x1b[33m[ship] ⚠ 暂存区无变更（可能无实际修改）\x1b[0m");
  }
}

// ── 1. 提交 ─────────────────────────────────────────────────────
function gitCommit() {
  console.log("\x1b[36m[ship] git commit -m \"chore: release\"\x1b[0m");
  var r = spawnSync("git", ["commit", "-m", "chore: release"], { stdio: "inherit", cwd: cwd });
  if (r.status !== 0) {
    console.error("\x1b[1;31m[ship] ✗ git commit 失败\x1b[0m");
    process.exit(r.status || 1);
  }
  console.log("\x1b[32m[ship] ✓ 已提交\x1b[0m");
}

// ── 2. 推送 + 发布（原逻辑） ───────────────────────────────────
function run(step, cmd, args) {
  console.log("\x1b[36m[ship] " + step + ": " + cmd + " " + args.join(" ") + "\x1b[0m");
  var r = spawnSync(cmd, args, { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("\x1b[1;31m[ship] ✗ " + step + " 失败（退出码 " + r.status + "）——后续步骤已跳过！\x1b[0m");
    console.error("\x1b[1;31m[ship]   提交仍保留在本地；修复后手动补跑: git push && npx @vscode/vsce publish\x1b[0m");
    process.exit(r.status || 1);
  }
  console.log("\x1b[32m[ship] ✓ " + step + " 完成\x1b[0m");
}

// 流程编排
try {
  runShip();
  gitCommit();
  run("推送到远程", "git", ["push"]);
  run("发布到市场", "npx", ["@vscode/vsce", "publish"]);
  console.log("\x1b[1;32m[ship] 发版完成：远程已更新 + 市场已发布\x1b[0m");
} catch (e) {
  console.error("\x1b[1;31m[ship] 发版异常：" + e.message + "\x1b[0m");
  process.exit(1);
}
