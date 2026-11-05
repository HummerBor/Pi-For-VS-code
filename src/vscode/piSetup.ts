import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import type { PiClient } from "../pi/piClient";
import { bundledPiVersion } from "../pi/piSdk";
import type { HostToWebviewTagged } from "../core/protocol";

/**
 * PiSetup —— pi 环境管理（鉴权/安装，刀 C 自 panel.ts 搬出）。
 *
 * 搬运纪律（同 changes.ts）：方法体自 panel.ts 逐字符搬运、行为零变化。职责：pi 的
 * 安装/登录/API key/凭证管理 + 改凭证后重连 client——独立于聊天状态机（不碰消息/tab/
 * 队列），故从 panel 剥离。簇内 this.L/this.post/this.core 经委托访问器桥到 host，
 * 方法体零改写；client 生命周期走窄接口 PiSetupCore（改凭证后重连用）。
 */
export interface PiSetupHost {
  post(msg: HostToWebviewTagged, tabId?: string): void;
  getL(): Record<string, any>;
  /** 单语字典（不套 bb）：webview 自己渲染的文案用，避免出现「中文 / English」双节 */
  getLraw(): Record<string, any>;
  getCore(): PiSetupCore;
  /** 打开集成终端跑内置 pi 的 /login（面板侧实现：靠真 node 跑内置 cli，见 panel.openTerminalLogin） */
  openLoginTerminal(): void;
}
/** client 生命周期窄接口（仅 ensureClient/disposeClient/clientRef，PiCore 公共成员满足） */
export interface PiSetupCore {
  ensureClient(): PiClient;
  disposeClient(): void;
  readonly clientRef?: PiClient | undefined;
}

/** 面板内凭证配置页可选的服务商（跟 pi 的 auth.json 键一致）。
 *  label 走 i18n（中文名），id 直接作为 auth.json 的键 */
export interface AuthProviderDef {
  id: string;
  label: string;
}

export class PiSetup {
  /** 本窗口是否已提醒过配置凭证（避免反复打扰） */
  private authOfferShown = false;
  constructor(private readonly host: PiSetupHost) {}
  /** 委托访问器：搬运块内 this.L/this.post/this.core 原样保留，此处桥到 host */
  private get L(): Record<string, any> {
    return this.host.getL();
  }
  private post(msg: HostToWebviewTagged, tabId?: string): void {
    this.host.post(msg, tabId);
  }
  private get core(): PiSetupCore {
    return this.host.getCore();
  }
  /** auth.json 里是否已有凭证（面板侧握手判定「要不要常驻配置页」也用，故公开） */
  hasAuthConfig(): boolean {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8")
      );
      return Object.keys(data).length > 0;
    } catch {
      return false;
    }
  }

  /** 还没有模型凭证时引导用户配置（force=安装完立即弹）。
   *  2026-11-05：不再弹原生 QuickPick 提示，直接开面板内的凭证配置页——
   *  原生弹窗只能选一个动作、关掉就找不回来，而配置页里 API key 与订阅登录同屏。 */
  async maybeOfferKeyConfig(force: boolean): Promise<void> {
    if (this.hasAuthConfig()) return;
    if (force || !this.authOfferShown) {
      this.authOfferShown = true; // 每次窗口只自动弹一次，不反复打扰
      this.post({ type: "authPanelOpen" });
    }
  }

  /** 检测 pi 是否可用，返回版本号字符串，不可用返回 null。
   *  10s 超时杀掉子进程兑底，防 pi --version 挂起时 Promise 永不 resolve
   *
   *  内置 pi（2026-11-05）：判定基准是「vsix 自带的 vendor/pi 在不在」，不是用户 PATH
   *  上有没有 pi。内置在就直接报内置版本——老实现探 PATH 探不到就弹「面板需要它才能
   *  工作 + 一键 npm 安装」，对没装过 pi/node 的用户是假错误，还把他们从配凭证引导上
   *  引偏了（maybeOfferKeyConfig 只在可用分支里）。PATH 探测仅作为旧版包（无 vendor）
   *  的兼容兜底保留。 */
  piVersion(): Promise<string | null> {
    const bundled = bundledPiVersion();
    if (bundled) return Promise.resolve(bundled);
    return this.probePiOnPath();
  }

  /** PATH 上的 pi --version 探测（仅内置缺失时的兜底） */
  private probePiOnPath(): Promise<string | null> {
    return new Promise((resolve) => {
      const p = spawn("pi", ["--version"], {
        shell: process.platform === "win32",
        windowsHide: true,
      });
      let out = "";
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          // ignore
        }
        finish(null);
      }, 10000);
      p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      p.on("error", () => finish(null));
      p.on("close", (code) => finish(code === 0 ? out.trim().split("\n")[0] || "ok" : null));
    });
  }

  /** 一键安装/更新 pi（npm 全局装），进度与结果显示在面板 */
  async installPi(): Promise<void> {
    this.post({ type: "status", text: this.L.installing });
    this.post({ type: "notice", text: "📦 npm install -g @earendil-works/pi-coding-agent…" });
    const proc = spawn("npm", ["install", "-g", "@earendil-works/pi-coding-agent"], {
      shell: true,
      windowsHide: true,
    });
    let tail = "";
    const onOut = (d: Buffer) => (tail = (tail + d.toString()).slice(-300));
    proc.stdout?.on("data", onOut);
    proc.stderr?.on("data", onOut);
    proc.on("error", () => {
      this.post({ type: "status", text: "" });
      void vscode.window.showErrorMessage(
        this.L.npmMissing
      );
    });
    proc.on("close", (code) => {
      this.post({ type: "status", text: "" });
      if (code === 0) {
        this.post({ type: "notice", text: this.L.installDone });
        // 装完后（重新）拉起客户端；还没有凭证则直接弹 key 配置
        if (!this.core.clientRef?.running) this.core.disposeClient();
        const c = this.core.ensureClient();
        void c;
        void this.maybeOfferKeyConfig(true);
      } else {
        void vscode.window.showErrorMessage(this.L.installFail + tail.slice(-200));
      }
    });
  }

  /** 配置页用的服务商清单（id = auth.json 键；文案走单语字典，不套 bb） */
  providers(): AuthProviderDef[] {
    const S = this.host.getLraw();
    return [
      { id: "zai", label: S.providerZai },
      { id: "zai-coding-cn", label: S.providerZaiCn },
      { id: "openrouter", label: "OpenRouter" },
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
      { id: "deepseek", label: "DeepSeek" },
      { id: "google", label: "Google Gemini" },
      { id: "kimi-coding", label: "Kimi For Coding" },
      { id: "qwen-token-plan-cn", label: S.providerQwen },
      { id: "xiaomi", label: S.providerXiaomi },
    ];
  }

  /** auth.json 当前内容（缺失/损坏 → 空对象，不抛） */
  private readAuth(): Record<string, any> {
    try {
      const raw = fs.readFileSync(this.authFile(), "utf8");
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  private authFile(): string {
    return path.join(os.homedir(), ".pi", "agent", "auth.json");
  }

  /** 凭证配置页的数据源：配置页打开/保存/删除后都重发一次，webview 不存本地状态 */
  postAuthState(): void {
    const data = this.readAuth();
    this.post({
      type: "authState",
      providers: this.providers().map((p) => ({
        id: p.id,
        label: p.label,
        // 订阅授权（OAuth）在 auth.json 里是 oauth 类型，与手填 api_key 区分展示
        kind: String(data[p.id]?.type ?? ""),
      })),
    });
  }

  /** 配置页保存：写 ~/.pi/agent/auth.json（与 pi /login 同格式） */
  saveProviderKey(provider: string, key: string): void {
    const id = String(provider || "").trim();
    const val = String(key || "").trim();
    if (!id || !val) return;
    const data = this.readAuth();
    data[id] = { type: "api_key", key: val };
    try {
      fs.mkdirSync(path.dirname(this.authFile()), { recursive: true });
      fs.writeFileSync(this.authFile(), JSON.stringify(data, null, 2) + "\n", "utf8");
      const label = this.providers().find((p) => p.id === id)?.label ?? id;
      this.post({ type: "notice", text: this.L.keySaved + label });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.saveFail + (err?.message ?? err) });
    }
    this.postAuthState();
  }

  /** 配置页删除：只删该服务商那一条，其余凭证原样保留 */
  deleteProviderKey(provider: string): void {
    const id = String(provider || "").trim();
    if (!id) return;
    const data = this.readAuth();
    if (!(id in data)) {
      this.postAuthState();
      return;
    }
    delete data[id];
    try {
      fs.writeFileSync(this.authFile(), JSON.stringify(data, null, 2) + "\n", "utf8");
      this.post({ type: "notice", text: this.L.deleted + id });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.delFail + (err?.message ?? err) });
    }
    this.postAuthState();
  }

  /** 配置模型 API key：写入 ~/.pi/agent/auth.json（与 pi 的 /login 存储格式一致） */
  async configApiKey(): Promise<void> {
    const providers = this.providers();
    const pick = await vscode.window.showQuickPick(
      providers.map((p) => ({ label: p.label, description: p.id, id: p.id })),
      { placeHolder: this.L.pickProvider }
    );
    if (!pick) return;
    const key = await vscode.window.showInputBox({
      prompt: this.L.enterKey,
      password: true,
    });
    if (!key) return;
    this.saveProviderKey(pick.id, key);
  }

  /** 查看/删除已保存的凭证（auth.json） */
  async manageAuth(): Promise<void> {
    const file = path.join(os.homedir(), ".pi", "agent", "auth.json");
    let data: any = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.post({ type: "notice", text: this.L.noAuth });
      return;
    }
    const ids = Object.keys(data);
    if (!ids.length) {
      this.post({ type: "notice", text: this.L.noAuth });
      return;
    }
    const pick = await vscode.window.showQuickPick(
      ids.map((id) => ({
        label: id,
        description: data[id]?.type ?? "",
        detail: this.L.authDetail,
        id,
      })),
      { placeHolder: this.L.authPicker }
    );
    if (!pick) return;
    const yes = await vscode.window.showWarningMessage(
      this.L.delAuthAsk,
      { modal: true },
      this.L.delete
    );
    if (yes !== this.L.delete) return;
    delete data[pick.id];
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
      this.post({ type: "notice", text: this.L.deleted + pick.id });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.delFail + (err?.message ?? err) });
    }
  }
}
