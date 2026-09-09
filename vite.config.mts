import { defineConfig, type Plugin } from "vite";
import { copyFileSync } from "fs";

/** 把 HTML 模板拷进产物目录（webview/ 源码不随 vsix 分发） */
function copyHtmlTemplate(): Plugin {
  return {
    name: "copy-html-template",
    closeBundle() {
      copyFileSync("webview/index.html", "dist/webview/index.html");
    },
  };
}

/**
 * webview 前端构建配置：
 * - 入口 webview/main.ts（内含 import "./style.css"）
 * - IIFE 单文件输出 dist/webview/main.js + 抽离样式 dist/webview/main.css
 * - 宿主 src/webview-html.ts 读取产物并按 CSP nonce 注入 webview
 */
export default defineConfig({
  plugins: [copyHtmlTemplate()],
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "webview/main.ts",
      name: "PiWebview",
      formats: ["iife"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "main[extname]",
      },
    },
  },
});
