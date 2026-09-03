import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/**
 * 通过 RPC 模式驱动 pi 后台进程。
 * 协议见 pi 文档 docs/rpc.md：stdin/stdout 上按行传输 JSON。
 * 注意：pi 的 JSONL 只按 \n 分帧（不能用 readline，它会按 U+2028/U+2029 切分）。
 */
export class PiClient {
  /** pi 推送的事件流（agent_start / message_update / tool_execution_* 等） */
  readonly events = new EventEmitter();
  /** pi 进程退出回调 */
  onExit?: (code: number | null) => void;
  /** pi 进程启动失败回调（如找不到 pi 命令） */
  onError?: (err: Error) => void;
  /** 扩展请求用户交互（select/confirm/input/editor/notify），由上层实现真正的 UI */
  onUiRequest?: (req: any) => void;

  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, Pending>();

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  start(cwd: string, extraArgs: string[] = [], proxyUrl?: string): void {
    if (this.running) return;

    // pi 只认 HTTP_PROXY / HTTPS_PROXY 环境变量（大小写都传，兼容不同库）
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SKIP_VERSION_CHECK: "1" };
    if (proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;
    }

    // Windows 上 pi 是 pi.cmd，需要 shell:true 才能解析到
    const proc = spawn("pi", [...extraArgs, "--mode", "rpc"], {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
      env,
    });
    this.proc = proc;
    this.buffer = "";

    proc.stdout!.on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const idx = this.buffer.indexOf("\n");
        if (idx === -1) break;
        let line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim().length > 0) this.handleLine(line);
      }
    });

    proc.stderr!.on("data", (chunk: Buffer | string) => {
      console.error("[pi stderr]", chunk.toString());
    });

    proc.on("error", (err) => {
      this.onError?.(err);
    });

    proc.on("close", (code) => {
      this.proc = null;
      const err = new Error("pi 进程已退出 (code " + code + ")");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.onExit?.(code);
    });
  }

  /** 回复扩展的 UI 请求（select/confirm/input/editor） */
  respondUi(resp: Record<string, unknown>): void {
    this.write(resp);
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[pi] 非 JSON 输出:", line);
      return;
    }

    // 命令响应：与 pending 请求配对
    if (msg.type === "response") {
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (p) {
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.data);
        else p.reject(new Error(msg.error || "命令执行失败"));
      }
      return;
    }

    // 扩展的 UI 请求：交给上层用 VS Code 原生 UI 处理；没有上层就自动跳过
    if (msg.type === "extension_ui_request") {
      if (this.onUiRequest) {
        this.onUiRequest(msg);
      } else {
        const resp: any = { type: "extension_ui_response", id: msg.id };
        if (msg.method === "confirm") resp.confirmed = false;
        else resp.cancelled = true;
        this.write(resp);
      }
      return;
    }

    // 其余都是事件
    this.events.emit("event", msg);
  }

  private write(obj: object): void {
    this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
  }

  /** 发送一条 RPC 命令，返回命令响应（不是 agent 完整结果） */
  send(cmd: object): Promise<any> {
    if (!this.running) return Promise.reject(new Error("pi 未在运行"));
    const id = "req-" + this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ ...cmd, id });
    });
  }

  /** 发送用户消息；agent 工作中时 steer=true 会排队插话；images 为 base64 图片列表 */
  prompt(
    text: string,
    steer = false,
    images?: { data: string; mimeType: string }[]
  ): Promise<any> {
    const cmd: any = { type: "prompt", message: text };
    if (steer) cmd.streamingBehavior = "steer";
    if (images && images.length) {
      cmd.images = images.map((i) => ({
        type: "image",
        data: i.data,
        mimeType: i.mimeType,
      }));
    }
    return this.send(cmd);
  }

  abort(): Promise<any> {
    return this.send({ type: "abort" });
  }

  getMessages(): Promise<any> {
    return this.send({ type: "get_messages" });
  }

  getState(): Promise<any> {
    return this.send({ type: "get_state" });
  }

  getSessionStats(): Promise<any> {
    return this.send({ type: "get_session_stats" });
  }

  getAvailableModels(): Promise<any> {
    return this.send({ type: "get_available_models" });
  }

  setModel(provider: string, modelId: string): Promise<any> {
    return this.send({ type: "set_model", provider, modelId });
  }

  getAvailableThinkingLevels(): Promise<any> {
    return this.send({ type: "get_available_thinking_levels" });
  }

  setThinkingLevel(level: string): Promise<any> {
    return this.send({ type: "set_thinking_level", level });
  }

  newSession(): Promise<any> {
    return this.send({ type: "new_session" });
  }

  /** 加载指定的历史会话文件（*.jsonl） */
  switchSession(sessionPath: string): Promise<any> {
    return this.send({ type: "switch_session", sessionPath });
  }

  /** 设置当前会话的显示名称 */
  setSessionName(name: string): Promise<any> {
    return this.send({ type: "set_session_name", name });
  }

  /** 手动压缩上下文 */
  compact(customInstructions?: string): Promise<any> {
    const cmd: any = { type: "compact" };
    if (customInstructions) cmd.customInstructions = customInstructions;
    return this.send(cmd);
  }

  setAutoCompaction(enabled: boolean): Promise<any> {
    return this.send({ type: "set_auto_compaction", enabled });
  }

  setAutoRetry(enabled: boolean): Promise<any> {
    return this.send({ type: "set_auto_retry", enabled });
  }

  /** 取消进行中的自动重试 */
  abortRetry(): Promise<any> {
    return this.send({ type: "abort_retry" });
  }

  /** 移除排队中的 steer/follow_up 消息并返回其内容 */
  clearQueue(): Promise<any> {
    return this.send({ type: "clear_queue" });
  }

  /** 导出会话为 HTML */
  exportHtml(outputPath?: string): Promise<any> {
    const cmd: any = { type: "export_html" };
    if (outputPath) cmd.outputPath = outputPath;
    return this.send(cmd);
  }

  /** 获取可分叉的历史用户消息列表 */
  getForkMessages(): Promise<any> {
    return this.send({ type: "get_fork_messages" });
  }

  /** 从某条历史用户消息分叉 */
  fork(entryId: string): Promise<any> {
    return this.send({ type: "fork", entryId });
  }

  /** 把当前会话复制为新会话 */
  clone(): Promise<any> {
    return this.send({ type: "clone" });
  }

  /** 直接执行 shell 命令，输出进入对话上下文 */
  bash(command: string): Promise<any> {
    return this.send({ type: "bash", command });
  }

  /** 获取可用的 /命令（扩展命令、技能、提示模板） */
  getCommands(): Promise<any> {
    return this.send({ type: "get_commands" });
  }

  /** 插话（steer）送达方式：all=每次回复后全部送达；one-at-a-time=每次一条 */
  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<any> {
    return this.send({ type: "set_steering_mode", mode });
  }

  /** 追问（follow_up）送达方式 */
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<any> {
    return this.send({ type: "set_follow_up_mode", mode });
  }

  dispose(): void {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null) return;
    if (process.platform === "win32") {
      // shell:true 时直接 kill 只会杀掉 cmd.exe，用 taskkill 连子进程一起杀
      try {
        spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } catch {
        // ignore
      }
    } else {
      try {
        p.kill();
      } catch {
        // ignore
      }
    }
  }
}
