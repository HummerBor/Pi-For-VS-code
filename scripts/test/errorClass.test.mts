/**
 * isEditRetryable 口径用例（2026-10-23 用户拍板：402 余额不足不该给「修改后重试」入口）。
 *
 * 钉死两头：
 * - 余额/配额/用量限制/鉴权家族（含 pi 的 NON_RETRYABLE 表 + 截图实测的
 *   "402 Insufficient account balance / insufficient_balance"）一律不给重试入口；
 * - 超时/过载/5xx/网络类照旧给入口（改改重发有意义）。
 *
 * 运行：npm run test:errclass（Node 直跑，零依赖，不进 tsc 编译门禁）
 */
import assert from "node:assert";
import { isEditRetryable } from "../../src/domain/errorClass.ts";

// ── 不给重试：余额/配额/用量/鉴权家族 ─────────────────────────────────────
const noRetry = [
  // 截图实测原文（402 insufficient_balance，两个变体都要命中）
  '402: {"code":"402","message":"Insufficient account balance","type":"insufficient_balance"}',
  "Insufficient account balance",
  // pi NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN 原表
  "GoUsageLimitError: free tier exhausted",
  "FreeUsageLimitError: try again tomorrow",
  "Monthly usage limit reached",
  "available balance is too low",
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing account closed",
  // 鉴权家族（改消息也过不去，先换 key/重登录）
  "401 Unauthorized",
  "403 Forbidden",
  "invalid api key",
  'Authentication failed for "zai". Credentials may have expired or network is unavailable.',
];
for (const s of noRetry) {
  assert.strictEqual(isEditRetryable(s), false, "应不给重试入口: " + s);
}

// ── 照旧给重试：临时性错误 ────────────────────────────────────────────────
const retryable = [
  "Request timed out",
  "429 Too Many Requests",
  "502 Bad Gateway",
  "overloaded_error: model overloaded",
  "network error: connection refused",
  "ECONNRESET",
  "",
];
for (const s of retryable) {
  assert.strictEqual(isEditRetryable(s), true, "应给重试入口: " + s);
}

console.log("errorClass.test.mts: all passed");
