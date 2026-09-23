import { EventEmitter } from "events";
import * as fs from "fs";
import { join } from "path";
import type { GetMessagesResult, GetSessionStatsResult, GetStateResult } from "./protocol";
import { loadPiSdk } from "./piSdk";

/** S 刀：模块级调试落盘（与 piCore 的 dbg 同一文件，经注入的写入器；默认 stderr-noop） */
let dbg: (s: string) => void = () => {};
export function setPiClientDebug(fn: (s: string) => void): void {
  dbg = fn;
}

/** Q 刀（2026-09-23 services 真身实锤）：createAgentSessionServices 内部是
 *  resourceLoader.reload() 全树扫描（skills/提示模板/AGENTS/扩展 + 工作区），
 *  冷 5~10s / 热 10ms（同窗实测：t59 冷 boot 16s、t11 热 boot 223ms）。
 *  services 绑 cwd（官方语义）且无 dispose（runtime.dispose 只 dispose session，
 *  agent-session-runtime.js:112/302 核过）——进程级按 cwd 共享一份：扫一次，
 *  全页签/全会话替换复用（每个页签一个 PiClient，不共享就每开一页签扫一遍）。
 *  Promise 缓存 = 并发 boot 共享同一次扫描；失败不缓存（用户可能刚装好配置）。 */
const sharedServices = new Map<string, Promise<any>>();
function getSharedServices(sdk: any, cwd: string): Promise<any> {
  const hit = sharedServices.get(cwd);
  if (hit) return hit;
  // S 刀（2026-09-23 环境差归案）：创建前后各测一次「事件循环停顿」（setImmediate 延迟）
  // 与小 fs 计时——若它们随 services 单跳唼到秒级 = 扩展宿主线程被卡（别的扩展/GC/IO）
  // 实锤；若它们干净而 services 独慢 = pi 内部在等东西。两行读数定方向
  const bench = (tag: string) => {
    const tb = Date.now();
    void new Promise((r) => setImmediate(r)).then(() => {
      const tf = Date.now();
      let st = 0;
      try {
        st = fs.statSync(__filename).size;
      } catch { /* ignore */ }
      if (st >= 0) dbg(`[boot] bench ${tag} loop=${tf - tb}ms fs=${Date.now() - tf}ms`);
    });
  };
  bench("pre");
  // Y 刀（2026-09-23 X 刀判决：异步干等）：外部资源逐个异步撜表点名——谁慢谁就是等待源。
  // 覆盖 create/picker 共同依赖的五类：配置 json / 可用性缓存 / 会话目录 / 会话文件
  void (async () => {
    const { join } = require("path");
    const agentDir = sdk.getAgentDir();
    const sessDir = join(agentDir, "sessions");
    const t0 = Date.now();
    const mark = (name: string) => dbg("[boot] io " + name + "=" + (Date.now() - t0) + "ms");
    try {
      await fs.promises.readFile(join(agentDir, "auth.json"));
      mark("auth");
      await fs.promises.readFile(join(agentDir, "models.json"));
      mark("models");
      await fs.promises.readFile(join(agentDir, "models-store.json"));
      mark("store");
      const dirs = await fs.promises.readdir(sessDir);
      mark("sessdir");
      const one = dirs.find((d: string) => d.endsWith("--")) || dirs[0];
      if (one) {
        const files = await fs.promises.readdir(join(sessDir, one));
        mark("onesessdir");
        if (files.length) {
          await fs.promises.readFile(join(sessDir, one, files[files.length - 1]));
          mark("sessfile");
        }
      }
    } catch { /* 目录结构变化不影响主链 */ }
  })().then(() => z2Probe(sdk.getAgentDir()));
  const p: Promise<any> = (async () => {
    // T 刀（2026-09-23 四行归案）：工厂的 modelRuntime 可注入——把它拆出来单独掋表
    //（①ModelRuntime.create 在扩展宿主里的真实耗时），并全进程共享（它只是模型目录，
    // 选择权在 session 上）。剩余（ctor+reload+refresh）= services 单跳减本行
    const { join } = require("path");
    const agentDir = sdk.getAgentDir();
    // X 刀（2026-09-23 用户拍板方向：不是 pi 慢是执行环境慢）：create 期间连续采样——
    // tick 全断3.9s = 同步卡死（GC/大同步块）；tick 正常但 create 不回 = 异步干等（IO/spawn）。
    // 只记慤 tick（>200ms）防日志洪水；结束后记最大 lag + 堆内存（GC 旁证）
    let maxLag = 0;
    let gapCount = 0;
    const heap0 = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => {
      const ts = Date.now();
      void new Promise((r) => setImmediate(r)).then(() => {
        const lag = Date.now() - ts;
        if (lag > maxLag) maxLag = lag;
        if (lag > 200) {
          gapCount++;
          dbg("[boot] tick lag=" + lag + "ms");
        }
      });
    }, 150);
    const tm = Date.now();
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      // U 刀（2026-09-23 真凶结案）：create 内部 model-runtime.js:97 会做整段初始化刷新
      //（逐 provider 可用性/鉴权状态构建），实测在扩展宿主里 2.8~9s 抖动（裸进程77ms，
      // 新进程冷缓存放大）。pi 官方留了开关 refreshOnCreate:false——跳过它，可用性由
      // 后台队列（queueAvailabilityRefresh）随后补齐，不挡启动/发消息
      refreshOnCreate: false,
    });
    clearInterval(sampler);
    const heap1 = process.memoryUsage().heapUsed;
    dbg(
      "[boot] bench mr-create=" + (Date.now() - tm) +
        "ms tickMaxLag=" + maxLag + "ms gaps=" + gapCount +
        " heapDelta=" + Math.round((heap1 - heap0) / 1048576) + "MB"
    );
    return sdk.createAgentSessionServices({ cwd, modelRuntime });
  })().then((v: any) => {
    bench("post");
    return v;
  });
  sharedServices.set(cwd, p);
  p.catch(() => {
    if (sharedServices.get(cwd) === p) sharedServices.delete(cwd);
  });
  return p;
}
/** Z2 刀（2026-09-23 实验18 刀口，用户点头打的对照探针）：位置×读法矩阵，
 *  归案「Code.exe 读 ~/.pi 文件内容慢」。
 *  轴一（位置）：原位 vs %TEMP% 副本 vs D 盘副本（顺带 __filename 对照 = 方法开销基线）；
 *  轴二（读法/相位）：statSync / promises.readFile / open+read 拆分 / readFileSync。
 *  判读：副本快 = 路径/文件属性相关（ADS/加密位/盯目录的过滤驱动）；副本一样慢 = 进程级；
 *  open 慢 = 打开被拦，read 慢 = 读内容被拦。
 *  纪律：排在 Y 刀 io 块之后串行跑（两探针并发互相陪绑会污染计时）；z2Done 保证一次性；
 *  sync 组放最后跑（若 sync 也慢会短暂冻结扩展宿主——那本身就是答案，但别冻在探针中途）。 */
let z2Done = false;
async function z2Probe(agentDir: string): Promise<void> {
  if (z2Done) return;
  z2Done = true;
  try {
    const os = require("os");
    const { join: pj } = require("path");
    const src = pj(agentDir, "auth.json");
    const locs: Array<[string, string]> = [["self", __filename], ["orig", src]];
    let copyT = "";
    const tmpCopy = pj(os.tmpdir(), "pi-z2-auth-copy.json");
    const tc = Date.now();
    try {
      fs.copyFileSync(src, tmpCopy);
      locs.push(["tmp", tmpCopy]);
      copyT += " tmp=" + (Date.now() - tc) + "ms";
    } catch { /* 复制失败就少一个对照 */ }
    const dCopy = "D:\\pi-z2-auth-copy.json";
    const td = Date.now();
    try {
      fs.copyFileSync(src, dCopy);
      locs.push(["droot", dCopy]);
      copyT += " droot=" + (Date.now() - td) + "ms";
    } catch { /* D 盘根不可写就少一个对照 */ }
    dbg("[boot] z2 copy" + copyT);
    for (const [tag, p] of locs) {
      const stat: number[] = [];
      const asyncR: number[] = [];
      const open: number[] = [];
      const read: number[] = [];
      const sync: number[] = [];
      for (let i = 0; i < 2; i++) {
        const t = Date.now();
        try { fs.statSync(p); } catch { /* ignore */ }
        stat.push(Date.now() - t);
      }
      for (let i = 0; i < 2; i++) {
        const t = Date.now();
        await fs.promises.readFile(p).catch(() => {});
        asyncR.push(Date.now() - t);
      }
      for (let i = 0; i < 2; i++) {
        let fh: any = null;
        const to = Date.now();
        try { fh = await fs.promises.open(p, "r"); } catch { /* ignore */ }
        open.push(Date.now() - to);
        const tr = Date.now();
        if (fh) await fh.readFile().catch(() => {});
        read.push(Date.now() - tr);
        if (fh) await fh.close().catch(() => {});
      }
      for (let i = 0; i < 2; i++) {
        const t = Date.now();
        try { fs.readFileSync(p); } catch { /* ignore */ }
        sync.push(Date.now() - t);
      }
      dbg(
        "[boot] z2 loc=" + tag +
          " stat=" + stat.join(",") +
          " async=" + asyncR.join(",") +
          " open=" + open.join(",") +
          " read=" + read.join(",") +
          " sync=" + sync.join(",")
      );
    }
  } catch { /* 探针失败不影响主链 */ }
}

/** Q 刀②：扩展激活即后台预热——把这一次全树扫描藏进「开面板之前」；
   *  W 刀：顺带全量预载 bundle 懒加载 chunks（首次 import = 模块加载+杀软扫描，
   *  唯一未排除的冷载卡顿嫌疑；提前到激活期全付掉，不命中也无害） */
export function prewarmPiServices(cwd: string): void {
  void loadPiSdk()
    .then((sdk: any) => {
      try {
        const { findPiPackageRoot } = require("./piSdk");
        const { pathToFileURL } = require("url");
        const root = findPiPackageRoot();
        const dir = join(root, "dist", "bundle", "chunks");
        const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".js"));
        const tp = Date.now();
        let left = files.length;
        for (const f of files) {
          void dynImport(pathToFileURL(join(dir, f)).href)
            .catch(() => {})
            .then(() => {
              left--;
              if (left === 0) dbg("[boot] chunks-preload=" + (Date.now() - tp) + "ms count=" + files.length);
            });
        }
      } catch { /* chunks 目录形态变化时静默 */ }
      return getSharedServices(sdk, cwd);
    })
    .catch(() => {});
}

/**
 * piClient：进程内直连 pi 的适配器。
 *
 * 历史：本类曾 spawn "pi --mode rpc" 子进程、在 stdin/stdout 上按行收发 JSON
 * （协议见 pi 文档 rpc.md）。2026-09-09 用户拍板改为进程内直连（AgentSession /
 * AgentSessionRuntime，见 piSdk.ts 头注释），对外方法签名、事件形状、UI 请求链路
 * 与 RPC 时代保持一致——panel.ts / webview / protocol.ts 不感知底层切换。
 *
 * RPC 语义保留对照（改本文件前必读，这是两代实现的行为契约）：
 * - prompt「接受即回响应」：SDK 的 session.prompt() 要等整轮跑完（含重试）才
 *   resolve，用 PromptOptions.preflightResult 在验收时提前 resolve 外层 Promise；
 *   验收后的失败走事件流，与 rpc.md「Failures after acceptance are reported
 *   through the normal event stream」一致。
 * - 忙时发 prompt（不带 streamingBehavior）：SDK 抛 "Agent is already processing.
 *   Specify streamingBehavior ('steer' or 'followUp') to queue the message."——
 *   与 panel.ts steer 自愈正则 /already processing|streamingBehavior/i 原样匹配，
 *   自愈兜底继续有效。别改这条文案，它是跨模块契约。
 * - 事件形状：AgentSessionEvent 与 RPC 事件流同构（同一套 AgentEvent 的两种出口，
 *   RPC 只多了 JSON 序列化），panel.ts 的 onPiEvent 处理器零改动。
 * - busy/队列：RPC 时代靠镜像+三层对账去猜；现在 isStreaming/pendingMessageCount/
 *   getSteeringMessages() 都是同步真读。panel 的对账代码暂留（变成永真保险），
 *   状态机收敛另立工单处理。
 */
export class PiClient {
  /** pi 推送的事件流（agent_start / message_update / tool_execution_* / queue_update 等） */
  readonly events = new EventEmitter();
  /** 进程内直连没有「进程退出」概念，保留字段兼容 panel 接线，不再触发 */
  onExit?: (code: number | null, detail: string) => void;
  /** 启动失败回调（找不到 pi 包 / 版本不兼容 / 会话创建失败），panel 展示安装指引 */
  onError?: (err: Error) => void;
  /** 扩展请求用户交互（select/confirm/input/editor/notify/setStatus），由上层实现真正的 UI */
  onUiRequest?: (req: any) => void;

  private runtime: any = null; // AgentSessionRuntime（会话替换：new/switch/fork/clone/import）
  private session: any = null; // 当前 AgentSession
  /** pi 真相同步读（工单十五刀6）：RPC 时代镜像+三层对账去猜，直连后 isStreaming 随手可读
   *  （agent-session.d.ts:295）——piCore.busy 的派生源之一 */
  get isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }
  private unsubscribe: (() => void) | null = null;
  /** N 刀（2026-09-23 启动分段计时）：init 各跳耗时上报（piCore.dbg 落 debug log），
   *  与 webview 启动秒表互为印证——慢启动定位器 */
  onDebug: ((msg: string) => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private startOpts: { cwd: string; extraArgs: string[]; proxyUrl?: string; openPath?: string } | null = null;
  /** 扩展 UI 对话框的挂起请求：id → resolver（panel respondUi 回来时配对） */
  private uiPending = new Map<string, { method: string; resolve: (v: any) => void; timer?: NodeJS.Timeout }>();
  private uiSeq = 1;

  get running(): boolean {
    return this.session !== null;
  }

  /** 启动参数（cwd/启动模式/代理/直连会话文件）由 panel 传入；初始化是异步的，所有方法先 await ready() */
  start(cwd: string, extraArgs: string[] = [], proxyUrl?: string, openPath?: string): void {
    if (this.session || this.initPromise) return;
    this.startOpts = { cwd, extraArgs, proxyUrl, openPath };
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    const t0 = Date.now();
    try {
      const sdk = await loadPiSdk();
      this.onDebug?.("[boot] load-pkg +" + (Date.now() - t0) + "ms");
      const { cwd, extraArgs, proxyUrl, openPath } = this.startOpts!;

      // 代理：RPC 时代透传给子进程环境；进程内直接写当前进程环境（pi 的网络栈读环境变量）
      if (proxyUrl) {
        process.env.HTTP_PROXY = proxyUrl;
        process.env.HTTPS_PROXY = proxyUrl;
        process.env.http_proxy = proxyUrl;
        process.env.https_proxy = proxyUrl;
      }

      // 启动参数映射（对应 panel.ensureClient 的 sessionMode，默认值契约见那边的注释）
      // -c → continueRecent（接最近一次）；默认 create（新会话）；--session-dir <dir> → sessionDir
      // 🚫 --no-session 禁用并显式拒绝（审计红线，用户拍板 2026-09-22 判死 ephemeral）：
      // 会话文件是 pi 操作的唯一审计痕迹（删文件等破坏性操作无从追查），「无痕」不可接受，
      // inMemory 映射随之删除。禁令用抛错而非静默忽略——静默落到 create/continue 会让调用方
      // 以为在跑临时会话实际在落盘（或反之），静默语义错位比崩溃危险。pi 本体能力不动
      // （终端 pi --no-session 是用户自由）；插件任何路径不得传该参数（AGENTS.md 约定）。
      if (extraArgs.includes("--no-session")) {
        throw new Error("--no-session disabled: sessions must persist (audit trail)");
      }
      const dirIdx = extraArgs.indexOf("--session-dir");
      const sessionDir = dirIdx >= 0 ? extraArgs[dirIdx + 1] : undefined;
      const useContinue = extraArgs.includes("-c");
      // R 刀（2026-09-23 用户方案「按需加载」）：有记忆会话就 SessionManager.open 直挂目标
      // 文件——砍掉「continueRecent 先接历史最近一条、boot 链再 switchSession 换目标」的
      // 双重附着（用户原话：插件只保存页签→会话路径，启动只载默认打开的，其余按需）。
      // 不传 openPath 的旧语义（-c/create）原样保留；open 打开真实文件，审计红线不破
      const sessionManager = openPath
        ? sdk.SessionManager.open(openPath, sessionDir, cwd)
        : useContinue
          ? sdk.SessionManager.continueRecent(cwd, sessionDir)
          : sdk.SessionManager.create(cwd, sessionDir);

      // 官方 runtime 工厂姿势（sdk.md「Session Management」）：services 绑定 cwd，
      // runtime 负责会话替换（new/switch/fork/clone/import 后 runtime.session 会换新对象）。
      // Q 刀：createRuntime 回调每次会话替换都会被调，services 走进程级共享缓存（见文件头）
      const createRuntime = async (opts: {
        cwd: string;
        sessionManager: any;
        sessionStartEvent?: any;
      }) => {
        const tS = Date.now();
        const services = await getSharedServices(sdk, opts.cwd);
        this.onDebug?.("[boot] services +" + (Date.now() - t0) + "ms (单跳" + (Date.now() - tS) + "ms)");
        const tE = Date.now();
        const sess = await sdk.createAgentSessionFromServices({
          services,
          sessionManager: opts.sessionManager,
          sessionStartEvent: opts.sessionStartEvent,
        });
        this.onDebug?.("[boot] session +" + (Date.now() - t0) + "ms (单跳" + (Date.now() - tE) + "ms)");
        return {
          ...sess,
          services,
          diagnostics: services.diagnostics,
        };
      };
      this.runtime = await sdk.createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir: sdk.getAgentDir(),
        sessionManager,
      });
      this.onDebug?.("[boot] runtime +" + (Date.now() - t0) + "ms");
      this.bindSession();
      // 扩展 UI：0.84.4 不在创建参数里收 uiContext，创建后经 extensionRunner 注入
      // （与 TUI/RPC 模式同款接法）。mode 传 "rpc"：扩展看到的 ctx.mode 语义不变
      // （hasUI=true，TUI 专属方法已在 uiContext 里安全降级）
      this.session.extensionRunner?.setUIContext?.(this.createUiContext(), "rpc");
      this.onDebug?.("[boot] init-done +" + (Date.now() - t0) + "ms");
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** 绑定当前 runtime.session 的事件订阅；每次会话替换后必须重调 */
  private bindSession(): void {
    this.unsubscribe?.();
    this.session = this.runtime.session;
    this.unsubscribe = this.session.subscribe((e: any) => {
      this.events.emit("event", e);
    });
  }

  /** 会话替换后的统一收尾：重订阅 + 给新 session 的 extensionRunner 补挂 UI */
  private afterSessionSwap(): void {
    this.bindSession();
    this.session.extensionRunner?.setUIContext?.(this.createUiContext(), "rpc");
  }

  /** 所有公开方法先过这道门：启动失败时 reject 原始错误（panel 有提示链路） */
  private async ready(): Promise<void> {
    if (!this.initPromise) throw new Error("pi 未启动");
    await this.initPromise;
  }

  /** 回复扩展的 UI 请求（select/confirm/input/editor），与 RPC 时代的响应格式一致 */
  respondUi(resp: Record<string, unknown>): void {
    const id = String(resp.id ?? "");
    const p = this.uiPending.get(id);
    if (!p) return;
    this.uiPending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (p.method === "confirm") p.resolve(resp.cancelled ? false : resp.confirmed === true);
    else p.resolve(resp.cancelled ? undefined : resp.value);
  }

  private createUiContext(): any {
    const request = (method: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<any> => {
      const id = "ui-" + this.uiSeq++;
      if (!this.onUiRequest) {
        // 无上层 UI：与 RPC 无客户端时行为一致——对话框请求直接取消
        return Promise.resolve(undefined);
      }
      return new Promise<any>((resolve) => {
        const entry: { method: string; resolve: (v: any) => void; timer?: NodeJS.Timeout } = {
          method,
          resolve: (v) => {
            if (entry.timer) clearTimeout(entry.timer);
            resolve(v);
          },
        };
        // 超时自动兜底：RPC 时代由 pi 侧自动 resolve（rpc.md「dialog with timeout」），
        // 进程内由本适配器承担同一职责——select/input/editor 超时回 undefined，confirm 回 false
        if (timeoutMs && timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            this.uiPending.delete(id);
            resolve(method === "confirm" ? false : undefined);
          }, timeoutMs);
        }
        this.uiPending.set(id, entry);
        this.onUiRequest!({ type: "extension_ui_request", id, method, ...payload });
      });
    };
    return {
      // ── 对话框：桥接到 panel 的 handleUiRequest（QuickPick/模态确认/输入框）──
      select: (title: string, options: string[], opts?: { timeout?: number }) =>
        request("select", { title, options }, opts?.timeout),
      confirm: (title: string, message: string, opts?: { timeout?: number }) =>
        request("confirm", { title, message }, opts?.timeout),
      input: (title: string, placeholder?: string, opts?: { timeout?: number }) =>
        request("input", { title, placeholder }, opts?.timeout),
      editor: (title: string, prefill?: string) => request("editor", { title, prefill }),
      // fire-and-forget：panel 侧直接展示
      notify: (message: string, notifyType?: string) => {
        if (!this.onUiRequest) return;
        this.onUiRequest({ type: "extension_ui_request", id: "ui-" + this.uiSeq++, method: "notify", message, notifyType });
      },
      // 权限模式显示依赖这条：模式扩展用 statusKey="mode" 推当前权限模式，panel 画在状态栏
      setStatus: (statusKey: string, statusText?: string) => {
        if (!this.onUiRequest) return;
        this.onUiRequest({ type: "extension_ui_request", id: "ui-" + this.uiSeq++, method: "setStatus", statusKey, statusText });
      },
      // ── TUI 专属能力：扩展宿主没有终端，安全 no-op（对齐 rpc.md 的降级表）──
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      setToolsExpanded: () => false,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: async () => ({ success: false, error: "not supported in vscode extension" }),
    };
  }

  /** 发送用户消息；agent 工作中时 steer=true 会排队插话；images 为 base64 图片列表。
   *  Promise 在「pi 验收/排队/拒收」时交付（对齐 RPC 响应时序），不等整轮跑完 */
  prompt(
    text: string,
    steer = false,
    images?: { data: string; mimeType: string }[]
  ): Promise<any> {
    return this.ready().then(
      () =>
        new Promise<any>((resolve, reject) => {
          // preflight ok=false 不再当场 reject 通用文案：pi 的 prompt() 在 preflight 失败时
          // 先调 preflightResult(false) 再 throw 真实原因（压缩中/已在运行/无模型/无 key……
          // agent-session.js prompt() 的 catch 结构），让 rejection 把真错误带上来。
          // 事故教训：通用「pi 拒绝了该消息（preflight rejected）」把「压缩进行中」盖掉，
          // 用户无法判断会话状态（2026-09-15）。ok=true 仍验收即回（RPC 时序契约不变）
          let preflightOk: boolean | null = null;
          const opts: any = {
            preflightResult: (ok: boolean) => {
              preflightOk = ok;
              if (ok) resolve(undefined);
            },
          };
          if (steer) opts.streamingBehavior = "steer";
          // ImageContent 形状与 panel 上送的一致（{type:"image", data, mimeType}），零转换
          if (images && images.length) {
            opts.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
          }
          // 验收后的失败走事件流（rpc.md 契约）；resolve 兜底只在 preflight 回调从未触发时
          // 生效（现版 pi 源码不可达；若 ok=false 且 promise 反常 resolve，宁挂起不伪造成功）
          this.session.prompt(text, opts).then(
            () => { if (preflightOk === null) resolve(undefined); },
            (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)))
          );
        })
    );
  }

  abort(): Promise<any> {
    return this.ready().then(() => this.session.abort()).then(() => ({}));
  }

  /** 快照化：把活对象深拷贝成纯数据，和 RPC 时代「JSONL 序列化产物」同构，
   *  防止 panel/webview 持有 pi 内部活引用造成渲染与真实状态纠缠 */
  private static snapshot<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
  }

  /** 工单24：同步消息快照。session.messages 只含已完成消息（在途 assistant 在 message_end
   *  才入 state，探针 probe-inflight.mjs 实测）——与 piCore 的在途消息深拷贝在**同一个同步块**
   *  里取，两者合起来才是完整真相（不重不漏）。getMessages 的 async 版本仍供他处使用 */
  messagesSync(): any[] {
    return PiClient.snapshot(this.session?.messages ?? []);
  }

  getMessages(): Promise<GetMessagesResult> {
    return this.ready().then(() => ({ messages: PiClient.snapshot(this.session.messages) }));
  }

  /** 同步真读拼成 RPC get_state 的形状（字段含义见 protocol.ts GetStateResult） */
  getState(): Promise<GetStateResult> {
    return this.ready().then(() => {
      const s = this.session;
      return {
        isStreaming: s.isStreaming,
        isCompacting: s.isCompacting,
        sessionFile: s.sessionFile ?? undefined,
        sessionId: s.sessionId,
        sessionName: s.sessionName ?? undefined,
        model: s.model ? { id: s.model.id, name: s.model.name, provider: s.model.provider } : null,
        thinkingLevel: s.thinkingLevel,
        steeringMode: s.steeringMode,
        followUpMode: s.followUpMode,
        autoCompactionEnabled: s.autoCompactionEnabled,
        messageCount: s.messages.length,
        pendingMessageCount: s.pendingMessageCount,
      };
    });
  }

  getSessionStats(): Promise<GetSessionStatsResult> {
    return this.ready().then(() => PiClient.snapshot(this.session.getSessionStats()));
  }

  getAvailableModels(): Promise<any> {
    return this.ready().then(async () => {
      const models = await this.session.modelRuntime.getAvailable();
      return { models: PiClient.snapshot(models) };
    });
  }

  setModel(provider: string, modelId: string): Promise<any> {
    return this.ready().then(async () => {
      const m = this.session.modelRuntime.getModel(provider, modelId);
      if (!m) throw new Error("Model not found: " + provider + "/" + modelId);
      await this.session.setModel(m);
      return { model: PiClient.snapshot(m) };
    });
  }

  getAvailableThinkingLevels(): Promise<any> {
    return this.ready().then(() => ({ levels: this.session.getAvailableThinkingLevels() }));
  }

  setThinkingLevel(level: string): Promise<any> {
    return this.ready().then(() => {
      this.session.setThinkingLevel(level);
      return {};
    });
  }

  newSession(): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.runtime.newSession();
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled };
    });
  }

  /** 加载指定的历史会话文件（*.jsonl）；R 刀：目标已是 open 直连的同一文件时跳过
   *  （避免无谓的会话替换重载——已挂在目标上 */
  switchSession(sessionPath: string): Promise<any> {
    if (sessionPath === this.startOpts?.openPath) {
      return this.ready().then(() => ({ cancelled: false }));
    }
    return this.ready().then(async () => {
      const r = await this.runtime.switchSession(sessionPath);
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled };
    });
  }

  /** 设置当前会话的显示名称 */
  setSessionName(name: string): Promise<any> {
    return this.ready().then(() => {
      this.session.setSessionName(name);
      return {};
    });
  }

  /** 手动压缩上下文。SDK 返回 CompactionResult 本体；panel 读 r.result.tokensBefore，
   *  包一层 .result 保持 RPC 响应形状 */
  compact(customInstructions?: string): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.session.compact(customInstructions);
      return { result: PiClient.snapshot(r) };
    });
  }

  setAutoCompaction(enabled: boolean): Promise<any> {
    return this.ready().then(() => {
      this.session.setAutoCompactionEnabled(enabled);
      return {};
    });
  }

  setAutoRetry(enabled: boolean): Promise<any> {
    return this.ready().then(() => {
      this.session.setAutoRetryEnabled(enabled);
      return {};
    });
  }

  /** 取消进行中的自动重试 */
  abortRetry(): Promise<any> {
    return this.ready().then(() => {
      this.session.abortRetry();
      return {};
    });
  }

  /** 移除排队中的 steer/follow_up 消息并返回其内容 */
  clearQueue(): Promise<any> {
    return this.ready().then(() => PiClient.snapshot(this.session.clearQueue()));
  }

  /** 直入 pi 队列（工单十六：取回后保留集重排队）。session.steer 对 idle 只入队不下跑
   *  （agent.steer = steeringQueue.enqueue，下一轮 run 消费），不会开出第二个 run；
   *  busy 时即插队，送达时序由 pi 队列结构保证（steering 先于 followUp，各队列内部保序） */
  steer(text: string): Promise<any> {
    return this.ready().then(() => this.session.steer(text)).then(() => ({}));
  }

  /** 同上，followUp 归属（工单十六：取回重排队按原类型） */
  followUp(text: string): Promise<any> {
    return this.ready().then(() => this.session.followUp(text)).then(() => ({}));
  }

  /** 只读快照：当前 pi 队列内容（工单十六：取回收口对账用，同步真读非事件猜测） */
  getQueuedMessages(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.ready().then(() => ({
      steering: [...this.session.getSteeringMessages()].map(String),
      followUp: [...this.session.getFollowUpMessages()].map(String),
    }));
  }

  /** 导出会话为 HTML */
  exportHtml(outputPath?: string): Promise<any> {
    return this.ready().then(async () => {
      const path = await this.session.exportToHtml(outputPath || undefined);
      return { path };
    });
  }

  /** 获取可分叉的历史用户消息列表 */
  getForkMessages(): Promise<any> {
    return this.ready().then(() => ({ messages: PiClient.snapshot(this.session.getUserMessagesForForking()) }));
  }

  /** 从某条历史用户消息分叉 */
  fork(entryId: string): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.runtime.fork(entryId);
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled, text: r?.selectedText ?? "" };
    });
  }

  /** 把当前会话复制为新会话。照 RPC 模式源码实现：leaf 处 position:"at" 分叉 */
  clone(): Promise<any> {
    return this.ready().then(async () => {
      const leafId = this.session.sessionManager.getLeafId();
      if (!leafId) throw new Error("Cannot clone session: no current entry selected");
      const r = await this.runtime.fork(leafId, { position: "at" });
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled };
    });
  }

  /** 直接执行 shell 命令，输出进入对话上下文 */
  bash(command: string): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.session.executeBash(command);
      return PiClient.snapshot({
        output: r.output,
        exitCode: r.exitCode,
        cancelled: !!r.cancelled,
        truncated: !!r.truncated,
        fullOutputPath: r.fullOutputPath ?? null,
      });
    });
  }

  /** 获取可用的 /命令（扩展命令、技能、提示模板）。
   *  拼装顺序与 RPC 模式源码一致（extension → prompt → skill），字段形状照抄 */
  getCommands(): Promise<any> {
    return this.ready().then(() => {
      const s = this.session;
      const commands: any[] = [];
      for (const c of s.extensionRunner.getRegisteredCommands()) {
        commands.push({ name: c.invocationName, description: c.description, source: "extension", sourceInfo: c.sourceInfo });
      }
      for (const t of s.promptTemplates) {
        commands.push({ name: t.name, description: t.description, source: "prompt", sourceInfo: t.sourceInfo });
      }
      for (const sk of s.resourceLoader.getSkills().skills) {
        commands.push({ name: "skill:" + sk.name, description: sk.description, source: "skill", sourceInfo: sk.sourceInfo });
      }
      return { commands };
    });
  }

  /** 插话（steer）送达方式：all=每次回复后全部送达；one-at-a-time=每次一条 */
  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<any> {
    return this.ready().then(() => {
      this.session.setSteeringMode(mode);
      return {};
    });
  }

  /** 追问（follow_up）送达方式 */
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<any> {
    return this.ready().then(() => {
      this.session.setFollowUpMode(mode);
      return {};
    });
  }

  dispose(): void {
    // 进程内直连没有子进程可杀——RPC 时代 Windows taskkill /T /F 的脏方案随之作废
    for (const [, p] of this.uiPending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve(p.method === "confirm" ? false : undefined);
    }
    this.uiPending.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const runtime = this.runtime;
    this.runtime = null;
    this.session = null;
    this.initPromise = null;
    if (runtime) void Promise.resolve(runtime.dispose()).catch(() => {});
  }
}
