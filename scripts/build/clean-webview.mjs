// 一次性清空 webview 产物目录（build:webview 前置）。
// 为什么不是构建配置里的 emptyOutDir：现在是双入口（main + sessions）各自构建，
// 谁的 emptyOutDir:true 都会在 watch 双跑时把对方的产物清掉——清目录只在
// 全量构建前跑一次（脚本前置），watch 期间不清。
import { rmSync } from "fs";
rmSync("dist/webview", { recursive: true, force: true });
