---
name: pricing-table
description: 维护 pi 面板的「分时段价目表」（<agentDir>/pi-vscode-pricing.json）。当用户贴出厂商价目截图/表格、要求「把某个模型的价格加进去 / 改价 / 换模型后价格不对 / 花费和账单对不上」时使用。
---

# 分时段价目表维护

面板「上下文用量」弹层里有两种钱：

- **合计** = pi 记账（`getSessionStats().cost`），pi 的 models 目录每个模型只有**一套价**，正好是厂商的**高峰价**；
- **时段价估算** = 本表算出来的钱，按高峰/空闲两档计价，**这一行才和平台账单对得上**。

所以用户换模型后如果「钱显示得不对」，第一件事就是往本表里加一条。

## 文件位置（唯一，别新建别的地方）

```
<agentDir>/pi-vscode-pricing.json      # 一般就是 ~/.pi/agent/pi-vscode-pricing.json
```

不存在时，让用户点 ⚙ 菜单「分时段价目表」或跑命令面板 `pi: 打开分时段价目表`，插件会自动按模板建好并打开。

## 格式

单价单位统一是 **元 / 百万 token**（人民币，不是美元），四类：`input`（缓存未命中输入）、`cacheRead`（缓存命中输入）、`cacheWrite`（缓存写入，多数厂商为 0）、`output`。

```json
{
  "version": 1,
  "utcOffsetMinutes": 480,
  "peak": { "weekdays": [1, 2, 3, 4, 5], "from": "09:00", "to": "18:00" },
  "models": {
    "deepseek-flash": {
      "name": "DeepSeek V4.1 Flash",
      "peak":    { "input": 2,   "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
      "offpeak": { "input": 1,   "cacheRead": 0.02, "cacheWrite": 0, "output": 4 }
    }
  }
}
```

- `models` 的键必须是 **pi 的模型 id**（`deepseek-flash`、`mimo-v2.6-flash`…），不是厂商展示名。拿不准就让用户看弹层「估算单价…· {m}」那行的 id，或读 `~/.pi/agent/models-store.json`。
- `weekdays` 用 JS 口径 0=周日 … 6=周六。只有厂商真的按时段计价才写两档；单一价的模型只写 `peak` 即可（缺 `offpeak` 时按 peak 计）。
- `from > to` 表示跨零点的高峰区间（例如夜间高峰）。
- 已有条目的其他模型原样保留，**只增改需要的那条**，别整体重写文件。

## 从截图/表格提取（关键映射）

| 厂商表里的行 | 写进哪个字段 |
|---|---|
| 输入（缓存**未**命中 / cache miss） | `input` |
| 输入（缓存**命中** / cache hit / 缓存读取） | `cacheRead` |
| 缓存写入 / cache write | `cacheWrite`（没有就 0） |
| 输出 / output / completion | `output` |
| 空闲时段 / off-peak / 非高峰 | `offpeak` 那一档 |
| 高峰时段 / peak / 标准价 | `peak` 那一档 |

- 只给了单一价 → 全部写 `peak`，不写 `offpeak`。
- 时段划分在截图里写着（例：高峰 09:00–18:00 工作日）→ 同时更新顶层 `peak`；没写就别动它。
- 单位是「每 1M tokens」的元；若厂商标的是美元，**换算成人民币**再写（乘汇率，面板设置里的 `piChat.usdCnyRate`，默认 7.2），否则会差 7 倍。
- 图里数字模糊/有多个档位对不上时，**问用户**，不要猜。

## 写完之后

1. 校验 JSON 语法（一个多余逗号就会让整表回落内置价，插件不报错、只是数字变回旧值）。
2. 告诉用户：不用重载窗口，弹层/页脚下一次 1 秒心跳就会用上新价；请他打开弹层看「时段价估算 ≈ ¥x」跟账单是否对上。
3. 对不上时优先核对三件事：模型 id 拼写、单位是不是元/百万 token、高峰时段划分。

## 别做的事

- 不要为了让数字好看去改 `cacheRead`/`input` 的比例——这是对账用的表，不是调参旋钮。
- 不要在表里放"其他模型随便给个数"的兜底条目（面板宁可不估价并标「无价目」，也不显示一个编的数）。
- 不要把这张表塞进 `~/.pi/agent/settings.json` 或 `models.json`：那是 pi 自己的配置，插件只读本表。
