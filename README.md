# <img src="media/pi-icon.png" width="36" align="top" alt="Pi For VSC"> Pi For VSC

[简体中文](./README.md) | [English](./README_EN.md)

一个 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的可视化 VS Code 插件，把 pi 引擎进程内直连嵌进编辑器，流式体验与终端同速；交互参考 Claude Code，轻量不拖慢编辑器，界面代码就是几份本地文件，想改就改。

## 主题

![主题一览](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/themes.png)

- **跟随 VS Code**：按窗口深浅自动取色，配合壁纸插件也能融进背景

![跟随 VS Code 主题](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/%E8%B7%9F%E9%9A%8Fvsc.png)

## 特点

- **进程内直连，不是遥控 CLI**：把 pi 引擎当 SDK import 进扩展（市面上 agent 插件几乎全是 spawn 子进程拼字符串）——pi 的权限模式、排队插话、会话管理原生语义直接继承，终端 TUI 和面板行为零分裂，流式同速只是顺带的结果
- **多会话真并行**：多页签各自独立会话同时跑、互不打断；切页签原子快照接续现场，流式中上滑看历史也不会被拽回
- **插队可反悔**：干活时发的消息自动排队，排队项一键取回编辑框改了重发（pi 原生 dequeue 语义，不是自造的删除）
- **改动可视化**：pi 干完活，面板给出本轮改动清单，一键看原生 diff；不满意整文件还原（连你自己的未提交改动都不会误伤）——敢开 Auto 模式的底气

会话记录、API 凭证全在本机，无云依赖、无遥测。

## 快速开始

在 [扩展商店](https://marketplace.visualstudio.com/items?itemName=HummerBor.pi-for-vscode) 搜 `Pi For VSC` 安装 → 点活动栏 pi 图标。没装 pi 会引导一键安装，没配 key 会引导配置，然后就能聊了：

![干活实景](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/%E6%B5%8B%E8%AF%95.png)

## 用它开发它自己

它的每个版本都是在自己的面板里做出来的：打开项目 → 跟 pi 说「把欢迎页的鸭子换个姿势」→ 它改源码、编译、打包出新 `.vsix` → 装上重载——**它就更新了它自己**，包括你现在看的这段 README。

有需求或问题，欢迎提 [Issue](../../issues)。祝你干活愉快，记得喝水 <img src="media/pi-icon.png" width="20" align="top">

## 许可

[MIT](./LICENSE)
