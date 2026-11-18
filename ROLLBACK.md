# 回滚指南（main.ts 拆分战役）

> 目的：这轮拆分不管做到哪一步，**任何时刻都能退回到一个能用的版本**。
> 三道保险已经就位，见下。

## 一、三道保险

| 保险 | 位置 | 是什么 |
|---|---|---|
| 1. git 锚点 | tag `baseline-before-split` = `9530019` | 第 3 刀 + 会话行右键复制路径 + AGENTS 规则，compile 绿、回归全过 |
| 2. 能用版安装包 | `archive/pi-for-vscode-0.1.50-as-shipped.vsix` | **你现在装着的那个版本**（市场/本地能跑的） |
| 3. 基线源码安装包 | `archive/pi-for-vscode-0.1.50-split-baseline.vsix` | 当前源码 HEAD 打的包，含第 3 刀 |

> 拆分每做完 3 单，再往 `archive/` 追加一个当日包（版本号不 bump，靠文件名区分）。

## 二、三种回退场景

### A. 刚做完某一单，发现行为不对（最常见）

```bash
git log --oneline -5              # 找到那一单的哈希
git revert <哈希>                  # 反向提交，历史不动，最安全
```

只想退某个文件：

```bash
git checkout <上一个好的哈希> -- webview/main.ts webview/features/xxx.ts
```

### B. 整个插件装上去直接不能用（最坏情况）

1. VS Code 扩展面板 → 卸载 `Pi For VSC`
2. 装回你现在能用的那个包：

```bash
code --install-extension "d:\work\docs\pi test\pi-vscode\archive\pi-for-vscode-0.1.50-as-shipped.vsix"
```

3. 重载窗口（`Developer: Reload Window`）

这条一定回得去——那个包就是当前机器上正在用的版本，原样备份的。

### C. 装回旧版后，子 agent 面板异常

原因：harness 的版本门**只升不降**（`bundled > target` 才覆盖）。拆分中若把内置 harness bump 到 v27，
回滚插件后 `<agentDir>/extensions/subagent/harness.json` 仍是 v27，旧插件（内置 v26）不会覆盖它。

处理：

1. 把 `C:\Users\Administrator\.pi\agent\extensions\subagent` 整个改名成 `subagent.bak`（**不要删**，先改名）
2. 重载窗口 → 旧插件会把内置版本重新同步过去
3. 确认 `<agentDir>/extensions/subagent/harness.json` 的版本号 = 当前插件内置的版本

## 三、每单铁律（已写进任务书）

- **一单一个 commit**，绝不把两单的改动混进一次提交
- 报告里必须写：本单 commit 哈希 + 回滚命令（`git revert <哈希>`）
- 每 3 单打一次包，存进 `archive/`，文件名带日期和单号
- 任何破坏性操作（`git reset --hard`、删除会话文件、删 `archive/`）**必须先问用户**

## 四、验收入口

每单必须同时满足才算过：`npm run compile` 全绿 + 13 组测试基线一致 + 逐字核对通过 + 文件集自检。
任何一项不过 → 不提交，或提交后立刻 revert。
