// watch 双跑（刀6 B）：main（聊天）与 sessions（会话列表）两个 vite watch 并行。
// 两个 watcher 都不置 emptyOutDir（互清会把对方产物删掉，见 vite.sessions.config.mts 注释）。
// 任一子进程退出即整体退出（码透传），Ctrl+C 全停（stdio inherit，信号随终端）。
import { spawn } from "child_process";

const kids = [
  spawn("npx", ["vite", "build", "--watch"], { stdio: "inherit", shell: process.platform === "win32" }),
  spawn("npx", ["vite", "build", "--watch", "--config", "vite.sessions.config.mts"], { stdio: "inherit", shell: process.platform === "win32" }),
];
for (const k of kids) {
  k.on("exit", (code) => process.exit(code ?? 0));
}
