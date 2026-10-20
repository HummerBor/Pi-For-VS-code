import { defineConfig, type Plugin } from "vite";
import { copyFileSync } from "fs";

/** 会话列表 webview 第二入口（刀6 B）：独立 bundle sessions.js + sessions.css。
 *  与主入口（聊天 main.js）分开构建：两个 webview 各自注入各自的产物，互不拖体积。
 *  emptyOutDir=false——主入口清目录（emptyOutDir:true）会把本入口的产物一并清掉，
 *  watch 双跑时主入口每次重编都会清空 dist → 两个入口都置 false，清目录挪到
 *  build:webview 脚本的前置 clean（一次性，watch 期间不清）。 */
function copySessionsTemplate(): Plugin {
  return {
    name: "copy-sessions-template",
    closeBundle() {
      copyFileSync("webview/sessions.html", "dist/webview/sessions.html");
    },
  };
}

export default defineConfig({
  plugins: [copySessionsTemplate()],
  build: {
    outDir: "dist/webview",
    emptyOutDir: false,
    target: "es2020",
    minify: true,
    sourcemap: false,
    lib: {
      entry: "webview/sessions.ts",
      name: "PiSessions",
      formats: ["iife"],
      fileName: () => "sessions.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "sessions[extname]",
      },
    },
  },
});
