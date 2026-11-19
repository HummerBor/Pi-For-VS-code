# dispatch-t35 — 文档预算落地：AGENTS 三条硬预算 + PROGRESS 去工单化

> 派单日 2026-11-19。工单全文见 `DIRECTOR.md`「工单35」。收单即删本文件。

## 一、背景（已取证）

| 文件 | 行 | 字节 | ≈token |
|---|---|---|---|
| PROGRESS.md | 52 | 3,484 | 897 |
| AGENTS.md | 121 | 8,441 | 2,243 |
| docs/decisions.md | 209 | 15,098 | 3,933 |
| 归档.md | 3,323 | 299,447 | 74,211 |

`归档.md` 就是「只追加、只迁入、不删」规则下的终态，同一机制正在 PROGRESS.md 上重演。
为什么算 token 而不是行数：压缩后要**重读** AGENTS+PROGRESS 来恢复环境（指针方案），
体积直接乘进每次恢复成本；且行数上限需要人做「这条还有用吗」的模糊判断，必然放水。

## 二、范围

1. `AGENTS.md`「文档纪律」小节新增三条**可机械判定**的预算：
   - 单文件 ≤ **1.5k token**（估算口径：`字符数 / 2.2`，中文为主）
   - `PROGRESS.md` 每条 ≤ **2 行**：只说「是什么 + 在哪」，修法/理由/风险一律进 `DIRECTOR.md` 或 `docs/decisions.md`
   - `PROGRESS.md` 每小节 ≤ 1 屏
2. `AGENTS.md`「工作方法：边干边记」里的口径同步：保留「滚动窗口」与「只记状态不记细节」，
   把「70 行以内 / 只留 25 条」改成 token 口径（行长会随排版漂，token 不会）。
3. `PROGRESS.md` 待办 4（`slim-subagent-frames.mjs` 禁 `--apply`）现在带了完整修法清单
   （parentId 上溯 / 原子替换 / `.bak` 守卫 / 帧终态守卫…），这是工单内容不是交接卡内容：
   压成 **一行**：「`slim-subagent-frames.mjs` 修好前禁 `--apply`（会洗掉会话历史），修法见
   `docs/history/交接-webview拆分完成.md` §五 第 8 条」。**修法原文已在该文件里，不要复制到别处、
   也不要删原文。**
4. 顺手核对 `PROGRESS.md` 其它条目是否也超 2 行；超了就按同一规则压（不许新增内容）。

## 三、边界（不许顺手做）

- **不动 `归档.md`**（3,323 行那个，单独单，等用户拍板）
- 不动 `docs/decisions.md`、不动 `docs/history/**`
- **不动 `DIRECTOR.md`**（施工工单区是总监刚写的，另一个单也在跑，会冲突）
- 不新建任何文件（不加 `MEMORY.md` / `NOTES.md` 之类第 N 个事实源）
- 不跑 `npm run compile`（纯文档单，另一个施工单在编译，并发会抢 `dist/`）
- 不 `git add -A`；提交只用 pathspec 提 `AGENTS.md` + `PROGRESS.md`

## 四、验证

1. 量出改后数字并写进回报：`wc -l`、`wc -c`、`字符数/2.2`，三个文件都列
2. `PROGRESS.md` 改后 ≤ 1.5k token（改前 897，**只许减不许增**）
3. `grep -n "1.5k token\|每条 ≤ 2 行\|每小节" AGENTS.md` 能命中三条预算
4. `grep -n "slim-subagent-frames" PROGRESS.md` 只剩一行且带文件指针
5. `git show --stat HEAD` 只有 `AGENTS.md` 和 `PROGRESS.md`

## 五、交接

- 回报写 `.pi/reports/REPORT-t35.md`（不进 git）：改前/改后数字对照表 + 逐条改动理由一行
- 格式规范：UTF-8 无 BOM；CRLF warning 属常态不算失败
- 不 push
