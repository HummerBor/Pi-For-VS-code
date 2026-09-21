import { defineConfig, type Plugin } from "vite";
import { copyFileSync } from "fs";
import { buildPreview } from "./scripts/preview-html.mjs";

/** 把 HTML 模板拷进产物目录（webview/ 源码不随 vsix 分发），并重新生成浏览器调试预览页
 *  （emptyOutDir 会把 dist 整目录清空——preview.html 不在 watch 产物里，必须每次重建，
 *  否则 vite build --watch 首轮就把预览页清没了，实测事故 2026-09-21） */
function copyHtmlTemplate(): Plugin {
  return {
    name: "copy-html-template",
    closeBundle() {
      copyFileSync("webview/index.html", "dist/webview/index.html");
      try { buildPreview(); } catch { /* 预览页生成失败不挡构建（out/i18n.js 未就绪等） */ }
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
    // 工单二十：产物是经 CSP nonce 注入的内联脚本且不开 sourcemap，保注释无可读性收益——
    // minify 同时去除 esbuild 自带的 //#region 标记并缩体积
    minify: true,
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
