/**
 * 错误气泡「↺ 修改后重试」入口的放行判定（2026-10-23 用户拍板：402 余额不足不该给重试）。
 *
 * 背景（截图实测）：子 agent 402 insufficient_balance 失败后，错误气泡仍挂「↺ 修改后重试」——
 * 该入口的语义是「改消息内容再发可能变好」，但余额/配额/鉴权类是账户侧问题，改什么都过不去，
 * 重发只是白撞一次请求。这类错误给指引（充值/换 key/换模型），不给重试入口。
 *
 * 口径：NON_RETRYABLE 对齐 pi 的 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN
 * （agent-session.js isRetryableAssistantError 的不重试家族），并补 pi 没列全的
 * 「Insufficient account balance / insufficient_balance / 402」。注意 pi 的 auto-retry
 * 正门是 RETRYABLE 白名单（429/5xx/网络类），402 两表都不命中、pi 本来就不会自动重试——
 * 本判定只管插件自己那个 UI 入口，别拿它反推 pi 的自动重试行为。
 *
 * 零 import 纯逻辑叶（webview 共享编译无 node 类型）；口径用例钉在
 * scripts/test/errorClass.test.mts。
 */

/** 重发也过不去的错误家族：余额/配额/用量限制/鉴权（401/402/403） */
const NON_RETRYABLE =
  /insufficient[_ ]?(?:account )?balance|available balance|insufficient_quota|out of budget|quota exceeded|usage limit|GoUsageLimitError|FreeUsageLimitError|billing|payment|\b40[123]\b|unauthorized|forbidden|invalid api key|authentication failed|credentials (?:may have )?expired/i;

/** 错误气泡是否给「修改后重试」入口：默认给（超时/过载/5xx 等改改重发有意义），NON_RETRYABLE 家族除外 */
export function isEditRetryable(errText: string): boolean {
  return !NON_RETRYABLE.test(String(errText ?? ""));
}
