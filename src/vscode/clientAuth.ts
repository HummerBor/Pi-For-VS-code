/**
 * 工单33 授权层：控制面零信任（2026-10-29 用户拍板「只有注册过的插件才能接入」）。
 *
 * 威胁模型与安全口径（诚实版）：VS Code 命令不带调用方身份（executeCommand 谁都能调），
 * 所以控制面默认零信任——首次调用 `authorizeClient` 时弹原生确认框（用 getExtension 取
 * **真实**扩展信息展示 + 列明能力清单），用户同意才入信任表（globalState 持久）并发随机
 * clientToken；此后所有控制面命令（runPrompt/abortSession/openSession）携带令牌校验。
 * 只防误用/防未授权调用——同宿主恶意代码（扩展信任域内的任意代码）冒名弹窗/取杖属
 * VS Code 扩展模型固有上限，不承诺防御（2026-10-29 拍板口径，别在注释/文档里吹）。
 *
 * 三条硬约定（2026-10-29 用户拍板，错一条就是安全口子）：
 * - **绝不静默重发杖**：重调 authorizeClient 一律弹窗明示「吊旧杖换新杖」，同意才换。
 *   静默重发 = 冒名重领通道（命令层无调用方身份，旧杖被偷的人能悄悄换新杖）。
 * - **无逃生门**：没有免弹窗/预授权配置——「无人值守」场景 = 装机后人工点一次注册
 *   （一生一次，之后全部静默）。留预授权配置 = 把口子重新打开，用户明令删掉。
 * - **令牌 90 天过期**：到期后**首次**调用弹窗续权（同意 = 同令牌再延 90 天，本次调用
 *   放行；拒绝 = 本次与后续调用一律拒收，直到重新注册）。续权不换杖是为了续权响应
 *   没有「发杖回程」——普通命令的返回值不带令牌，换杖调用方收不到（实现级自裁，进 REPORT）。
 *
 * 能力裁剪：令牌只覆盖注册时列明的命令（白名单见 ALLOWED_CAPS），别的命令一律
 * unauthorized——泄漏的令牌也调不动白名单外的东西。
 */
import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { bb, fmt } from "../core/i18n";

/** 信任表 key（globalState 持久）：extensionId → { token, caps, grantedAt, expiresAt } */
const GRANTS_KEY = "piChat.clientGrants";
/** 令牌有效期：90 天（2026-10-29 拍板） */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 能力裁剪白名单：令牌只覆盖注册过的命令，白名单外的能力不可被请求（发杖时就裁掉） */
export const ALLOWED_CAPS = ["piChat.runPrompt", "piChat.abortSession", "piChat.openSession"];

interface Grant {
  token: string;
  caps: string[];
  grantedAt: number;
  expiresAt: number;
}
type Grants = Record<string, Grant>;

export interface AuthOk {
  ok: true;
  clientToken: string;
}
export interface AuthFail {
  ok: false;
  reason: "bad-request" | "unknown-extension" | "denied" | "cancelled";
}
export type AuthResult = AuthOk | AuthFail;

/** 真实扩展信息展示（弹窗文案用）：displayName（id v版本）——getExtension 取到什么显什么，
 *  取不到（被卸载的存量授权撤销时）退回裸 id，绝不编造 */
function extLabel(extOrId: vscode.Extension<any> | string): string {
  if (typeof extOrId === "string") return extOrId;
  const pj = extOrId.packageJSON ?? {};
  const name = typeof pj.displayName === "string" && pj.displayName ? pj.displayName : extOrId.id;
  const ver = typeof pj.version === "string" && pj.version ? " v" + pj.version : "";
  return name + "（" + extOrId.id + ver + "）";
}

export class ClientAuth {
  /** 本进程已弹过续权窗的令牌：「到期首次调用弹窗续权」——拒绝后不逐次骚扰（实现级自裁） */
  private renewNagged = new Set<string>();

  constructor(private readonly globalState: vscode.Memento) {}

  private load(): Grants {
    return this.globalState.get<Grants>(GRANTS_KEY, {});
  }

  /** 首次注册（一生一次弹窗）/ 重注册（吊旧杖换新杖，绝不静默重发——见文件头硬约定） */
  async authorizeClient(args?: { extensionId?: string; caps?: string[] }): Promise<AuthResult> {
    const extensionId = typeof args?.extensionId === "string" ? args.extensionId.trim() : "";
    if (!extensionId) return { ok: false, reason: "bad-request" };
    const ext = vscode.extensions.getExtension(extensionId);
    if (!ext) return { ok: false, reason: "unknown-extension" };
    // 能力裁剪：只收白名单内的命令能力；未传 = 三件套全量（弹窗如实列明给用户看）
    let caps: string[] = ALLOWED_CAPS;
    if (Array.isArray(args?.caps)) {
      caps = args.caps.filter((c): c is string => typeof c === "string" && ALLOWED_CAPS.includes(c));
      if (!caps.length) return { ok: false, reason: "bad-request" };
    }
    const label = extLabel(ext);
    const grants = this.load();
    if (grants[extensionId]) {
      // 重注册路径：必须明示「吊旧换新」，用户看不到「换」字 = 骗子换杖通道
      const pick = await vscode.window.showWarningMessage(fmt(bb("caReRegisterAsk"), label), { modal: true }, bb("caReplaceBtn"));
      if (pick !== bb("caReplaceBtn")) return { ok: false, reason: "cancelled" };
    } else {
      const pick = await vscode.window.showWarningMessage(fmt(bb("caAuthAsk"), label), { modal: true }, bb("caAuthAllow"), bb("caAuthDeny"));
      if (pick !== bb("caAuthAllow")) return { ok: false, reason: "denied" };
    }
    const grant: Grant = {
      token: randomBytes(32).toString("base64url"),
      caps,
      grantedAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    grants[extensionId] = grant;
    await this.globalState.update(GRANTS_KEY, grants);
    // 授权动作必发通知留痕（2026-10-29 拍板）：弹窗只在当下可见，通知可回查
    void vscode.window.showInformationMessage(fmt(bb("caAuthNotify"), label));
    return { ok: true, clientToken: grant.token };
  }

  /** 撤销：弹窗确认后清该扩展的信任记录，令牌立即失效 */
  async revokeClient(args?: { extensionId?: string }): Promise<{ ok: boolean; reason?: string }> {
    const extensionId = typeof args?.extensionId === "string" ? args.extensionId.trim() : "";
    if (!extensionId) return { ok: false, reason: "bad-request" };
    const grants = this.load();
    if (!grants[extensionId]) return { ok: false, reason: "not-found" };
    const ext = vscode.extensions.getExtension(extensionId);
    const label = ext ? extLabel(ext) : extLabel(extensionId);
    const pick = await vscode.window.showWarningMessage(fmt(bb("caRevokeAsk"), label), { modal: true }, bb("caRevokeBtn"));
    if (pick !== bb("caRevokeBtn")) return { ok: false, reason: "cancelled" };
    delete grants[extensionId];
    await this.globalState.update(GRANTS_KEY, grants);
    void vscode.window.showInformationMessage(fmt(bb("caRevokeNotify"), label));
    return { ok: true };
  }

  /** 命令入口校验（必须是命令 handler 第一行，reject 早于任何副作用）：
   *  未注册 / 令牌不匹配 / 白名单外命令 → { ok:false, reason:"unauthorized" }（零副作用）；
   *  过期 → 首次弹续权窗（见文件头硬约定）。令牌比对用普通字符串比较——令牌是 32 字节
   *  随机数且走同进程 IPC，定时侧信道不构成现实威胁（安全口径见文件头，不夸大） */
  async verify(clientToken: unknown, command: string): Promise<{ ok: boolean; reason?: string }> {
    if (typeof clientToken !== "string" || !clientToken) return { ok: false, reason: "unauthorized" };
    const grants = this.load();
    const hit = Object.entries(grants).find(([, g]) => g.token === clientToken);
    if (!hit) return { ok: false, reason: "unauthorized" };
    const [extensionId, grant] = hit;
    if (!grant.caps.includes(command)) return { ok: false, reason: "unauthorized" };
    if (Date.now() < grant.expiresAt) return { ok: true };
    // 过期续权：到期首次调用弹窗；拒绝/已弹过 → 静默拒收（续权不换杖，理由见文件头）
    if (this.renewNagged.has(clientToken)) return { ok: false, reason: "unauthorized" };
    this.renewNagged.add(clientToken);
    const ext = vscode.extensions.getExtension(extensionId);
    const label = ext ? extLabel(ext) : extLabel(extensionId);
    const pick = await vscode.window.showWarningMessage(fmt(bb("caRenewAsk"), label), { modal: true }, bb("caRenewBtn"));
    if (pick !== bb("caRenewBtn")) return { ok: false, reason: "unauthorized" };
    grant.expiresAt = Date.now() + TOKEN_TTL_MS;
    grants[extensionId] = grant;
    await this.globalState.update(GRANTS_KEY, grants);
    this.renewNagged.delete(clientToken);
    void vscode.window.showInformationMessage(fmt(bb("caAuthNotify"), label)); // 续权=授权动作，同样留痕
    return { ok: true };
  }
}
