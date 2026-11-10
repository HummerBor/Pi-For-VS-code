import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import type { ChangesDiffFile, ChangesFileInfo, HostToWebviewTagged, ToolChangedFile } from "../core/protocol";
import { reverseApplyPatch } from "../domain/patchRevert";
import { loadPiSdk } from "../pi/piSdk";

/**
 * ChangesController —— 工单七「本次改动」宿主侧状态机（刀 C 第一簇自 panel.ts 搬出）。
 *
 * 搬运纪律（同工单四 piCore）：方法体自 panel.ts 逐字符搬运、行为零变化；簇内所有
 * this.L/this.activeTabId/this.post 经下方委托访问器桥到注入的 ChangesHost（panel 实现），
 * 搬运块内部零改写。还原红线（revertFile/headContent 的 patch 逆向任一行不符即拒打不落盘）
 * 随逻辑保留，别「优化」掉任何一道守卫——完整还原边界与选型溯源见 归档.md 工单七 + 裁决 11。
 */
export interface ChangesHost {
  post(msg: HostToWebviewTagged, tabId?: string): void;
  /** 当前语言字典（活值：L 随 this.lang 变，方法桥而非快照） */
  getL(): Record<string, any>;
  /** 活动页签 id（活值：切页签后变） */
  getActiveTabId(): string;
}

export class ChangesController {
  constructor(private readonly host: ChangesHost) {}

  /** 委托访问器：搬运块内 this.L/this.activeTabId/this.post 原样保留，此处桥到 host */
  private get L(): Record<string, any> {
    return this.host.getL();
  }
  private get activeTabId(): string {
    return this.host.getActiveTabId();
  }
  private post(msg: HostToWebviewTagged, tabId?: string): void {
    this.host.post(msg, tabId);
  }
  // ── 工单七：本次改动（git diff 可视化）宿主侧状态。git/还原语义全在本 adapter，核心只产中性事件 ──
  // 三期 per-tab 化（2026-09-20 用户实测「其他会话看的也是同一个改动条」）：原是 panel 全局
  // 单份（单会话时代遗产），多页签下归属错乱——A 页签 run 结束时条画进当时活动的 B 视图。
  // 现 keys=tabId；「查看/关闭」只在活动视图的条上发生，取 activeTabId 即可
  private changesTab = new Map<
    string,
    {
      files: ChangesFileInfo[];
      detail: Map<string, { source: "tool" | "git"; tool: string; patches: string[]; canGit: boolean; inHead: boolean; preexisting: boolean }>;
      dismissed: boolean;
      startP: Promise<Map<string, string> | null> | null;
      lastStateFile: string | null;
      /** 变更页数据缓存（2026-11-05）：清单/detail 一变就作废——hunk 计算按文件 spawn git/读磁盘，
       *  每次开页重算会白白重复一遍（同一轮改动反复看是常态） */
      page: { files: ChangesDiffFile[]; totalAdds: number; totalDels: number } | null;
    }
  >();
  private changesOf(tabId: string) {
    let s = this.changesTab.get(tabId);
    if (!s) {
      s = { files: [], detail: new Map(), dismissed: false, startP: null, lastStateFile: null, page: null };
      this.changesTab.set(tabId, s);
    }
    return s;
  }
  /** dismiss（UiActions.dismissChanges 自 panel.buildUi 搬入）：条只属活动视图，点击必在活动
   *  页签（工单七 per-tab 化：后台条点不到） */
  dismissActive(): void {
    const s = this.changesOf(this.activeTabId);
    s.dismissed = true;
    this.postChangesList(this.activeTabId);
  }

  /** panel.pipeFromCore 的 state 分支（sessionFile 变更 → 清空改动清单）搬入：
   *  换会话文件即换归属，旧清单不跨会话残留 */
  syncStateFile(tabId: string, f: string | null): void {
    const s = this.changesOf(tabId);
    if (f !== s.lastStateFile) {
      s.lastStateFile = f;
      if (s.files.length) {
        s.files = [];
        s.detail.clear();
        s.page = null;
        this.postChangesList(tabId);
      }
    }
  }

  /** webviewReady 重发清单（工单七：变更条随握手重发，webview 重建后不丢）——三期 per-tab：逐页签各发各的 */
  resendLists(): void {
    for (const [tid, s] of this.changesTab) if (s.files.length) this.postChangesList(tid);
  }
  private postChangesList(tabId: string): void {
    const s = this.changesOf(tabId);
    this.post({ type: "changesList", files: s.dismissed ? [] : s.files }, tabId);
  }

  /** agent_start 时对 workspace 做 git status 快照（run 的 baseline；非 git 目录得 null 兑底） */
  snapshotGitStatus(tabId: string): void {
    const s = this.changesOf(tabId);
    s.startP = null;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    s.startP = this.gitStatus(root);
  }

  /** 跑一条 git 命令，成功回 stdout、失败回 null（非 git 目录/git 不在 PATH 都走 null，不抛） */
  private git(args: string[], cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      // 不用 shell:true：路径参数含空格/中文时不被 shell 拆坏（Windows 上 libuv 会搜 PATH）
      const p = spawn("git", args, { cwd });
      let out = "";
      const timer = setTimeout(() => p.kill(), 15000);
      p.stdout.on("data", (d) => (out += String(d)));
      p.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? out : null);
      });
    });
  }

  /** git status --porcelain -z → 相对路径(正斜杠) → XY 状态；非 git 目录回 null。
   *  -z 避开 quotepath 对中文路径的转义；rename 在 -z 下是 new\0old 两段，old 段跳过 */
  private async gitStatus(root: string): Promise<Map<string, string> | null> {
    const out = await this.git(["status", "--porcelain", "-z"], root);
    if (out === null) return null;
    const map = new Map<string, string>();
    const parts = out.split("\0");
    for (let i = 0; i < parts.length - 1; i++) {
      const tok = parts[i];
      if (!tok || tok.length < 4) continue;
      const xy = tok.slice(0, 2);
      const p = tok.slice(3);
      if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i++; // 旧路径段
      map.set(p, xy);
    }
    return map;
  }

  /** agent_settled：合并工具命中清单（piCore 中性回调）与 git 比对兜底，产出「本次改动」 */
  async handleRunSettled(tabId: string, files: ToolChangedFile[]): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const s = this.changesOf(tabId);
    const startStatus = s.startP ? await s.startP : null;
    s.startP = null;
    const nowStatus = await this.gitStatus(root);
    const relOf = (abs: string): string | null => {
      const r = path.relative(root, abs);
      return r.startsWith("..") ? null : r.replace(/\\/g, "/"); // 工作区外不归因
    };
    const norm = (p: string): string => path.normalize(p);
    s.detail.clear();
    s.page = null; // 新一轮清单 → 变更页缓存作废
    const list: ChangesFileInfo[] = [];
    // 1) 工具命中（裁决 11②：还原只对工具清单命中文件提供；git-only 仅展示）
    for (const f of files) {
      // 工单十一：pi 的 edit args.path 常为模型传给的原样相对路径，不锚定 root 会按 ext host
      // 的 cwd 解析成盘符根/垃圾值——relOf 的 path.relative 也基于 cwd 得到乱值使 nowStatus
      // 查不到（tracked 的 package.json 因此误判 inHead=false 错走 prerun 通道，症状二）。
      // 这里单点锚定，归一化后入 changesDetail/changesFiles，下游 diff/还原全链路收直。
      const abs = path.isAbsolute(f.path) ? f.path : path.join(root, f.path);
      const r = relOf(abs);
      const xy = r && nowStatus ? nowStatus.get(r) : undefined;
      const canGit = nowStatus !== null;
      // inHead：HEAD 里有此文件（checkout 可回退）；?? 未跟踪 / A 新增不在 HEAD，只能走 patch 逆向
      const inHead = canGit && !!xy && xy !== "??" && xy[0] !== "A" && xy[1] !== "A";
      s.detail.set(norm(abs), {
        source: "tool",
        tool: f.tool,
        patches: f.patches,
        canGit,
        inHead,
        preexisting: !!(r && startStatus?.has(r)),
      });
      list.push({ path: norm(abs), source: "tool" });
    }
    // 2) git 兑底（裁决 11①：捕获 bash/powershell 改动）——settled 快照里新出现的路径
    if (nowStatus) {
      for (const [r, xy] of nowStatus) {
        const abs = norm(path.join(root, r));
        if ([...s.detail.keys()].some((k) => k.toLowerCase() === abs.toLowerCase())) continue;
        if (startStatus?.has(r)) continue; // 运行前已 dirty，不归因本轮
        s.detail.set(abs, { source: "git", tool: "", patches: [], canGit: true, inHead: xy !== "??" && xy[0] !== "A", preexisting: false });
        list.push({ path: abs, source: "git" });
      }
    }
    s.files = list;
    s.dismissed = false;
    this.postChangesList(tabId);
  }

  /** 「查看本次改动」主链路：文件 QuickPick → 动作二选（diff / 还原） */
  async showChangesFlow(): Promise<void> {
    // QuickPick 是模态全局 UI，用户在活动视图的条上点击 → 数据取活动页签的（工单七 per-tab）
    const s = this.changesOf(this.activeTabId);
    if (!s.files.length) {
      this.post({ type: "notice", text: this.L.chgNone });
      return;
    }
    // 2026-09-10 交互收敛（用户反馈两层 QuickPick 不友好）：文件清单拍成一层，
    // 行内按钮直达 diff/还原，回车默认「看」（能 diff 就 diff，否则尝试还原）
    type ChgButton = vscode.QuickInputButton & { act?: string };
    type ChgItem = vscode.QuickPickItem & { path: string; buttons?: ChgButton[] };
    const buildItems = (): ChgItem[] =>
      s.files.map((f) => {
        const d = s.detail.get(f.path);
        const src = !d ? ""
          : d.source === "git" ? this.L.chgGitOnly
          : this.revertable(d) ? this.L.chgToolRev
          : this.L.chgToolIrrev;
        return {
          label: "$(git-compare) " + path.basename(f.path),
          description: src + (d?.preexisting ? " · " + this.L.chgPreexisting : ""),
          detail: f.path,
          path: f.path,
          buttons: [
            ...(d && (d.canGit && d.inHead || d.source === "tool" && d.patches.length > 0)
              ? [{ iconPath: new vscode.ThemeIcon("diff"), tooltip: this.L.chgActDiff, act: "diff" }]
              : []),
            ...(d && this.revertable(d)
              ? [{ iconPath: new vscode.ThemeIcon("discard"), tooltip: this.L.chgActRevert, act: "revert" }]
              : []),
          ],
        };
      });
    const qp = vscode.window.createQuickPick<ChgItem>();
    qp.items = buildItems();
    qp.placeholder = this.L.chgPickPh;
    qp.onDidTriggerItemButton(async ({ item, button }) => {
      const act = (button as ChgButton).act;
      const d = s.detail.get(item.path);
      if (act === "diff") await this.openChangesDiff(item.path);
      else if (act === "revert" && d) {
        await this.revertFile(item.path, d);
        qp.items = buildItems(); // 还原完原地刷新清单（revertFile 已把文件移出清单）
      }
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      if (!item) return;
      const d = s.detail.get(item.path);
      if (d && (d.canGit && d.inHead || d.source === "tool" && d.patches.length > 0)) void this.openChangesDiff(item.path);
      else this.post({ type: "notice", text: this.L.chgNoAction });
    });
    qp.show();
  }

  /** 还原资格（裁决 11②③）：仅工具命中；tracked 走 git，未跟踪/无 git 仅 edit 有 patch 可逆打 */
  private revertable(d: { source: string; tool: string; patches: string[]; canGit: boolean; inHead: boolean }): boolean {
    if (d.source !== "tool") return false;
    if (d.canGit && d.inHead) return true;
    return d.tool === "edit" && d.patches.length > 0;
  }

  /** diff 入口路由：tracked 开 HEAD 对比；未跟踪/无基线开「本轮改动前 ↔ 当前」
   *  （patch 链逆向取 pi 动文件前的状态，未跟踪文件也有代码对比可看） */
  private hunkKey(p: string): string {
    return path.normalize(p);
  }

  private async openChangesDiff(abs: string): Promise<void> {
    const d = this.changesOf(this.activeTabId).detail.get(this.hunkKey(abs));
    if (d?.canGit && d.inHead) await this.openHeadDiff(abs);
    else await this.openPrerunDiff(abs);
  }

  /** 未跟踪文件的对比：本轮改动前（patch 逆向）↔ 当前 */
  private async openPrerunDiff(abs: string): Promise<void> {
    const headUri = vscode.Uri.parse("pi-head:/" + encodeURIComponent(abs) + "?" + encodeURIComponent("prerun:" + abs));
    await vscode.commands.executeCommand(
      "vscode.diff",
      headUri,
      vscode.Uri.file(abs),
      path.basename(abs) + "  (本轮改动前 ↔ " + this.L.chgWorking + ")",
      { preview: true }
    );
  }

  /** 未跟踪/仅工具命中文件的「本轮改动前」内容（patch 链逆序逆向，裁决 11③）。
   *  失败语义由调用方定：原生 diff 提供者给占位文案、变更页给 note——守卫同源不复制，
   *  两条路径的逆向行为永远一致。 */
  private prerunContent(
    abs: string,
    d: { patches: string[] }
  ): { ok: true; content: string } | { ok: false; why: string } {
    try {
      let content = fs.readFileSync(abs, "utf8");
      for (let i = d.patches.length - 1; i >= 0; i--) {
        const r = reverseApplyPatch(content, d.patches[i]);
        if (!r.ok || r.content === null) return { ok: false, why: r.reason ?? "" };
        content = r.content;
      }
      return { ok: true, content };
    } catch (err: any) {
      return { ok: false, why: String(err?.message ?? err) };
    }
  }

  /** vscode.diff 左侧：HEAD 版本只读内容（TextDocumentContentProvider 回调） */
  async headContent(uri: vscode.Uri): Promise<string> {
    return (await this.tryHeadContent(uri)) ?? this.L.chgHeadFail;
  }

  /** headContent 可分发版（刀3 多实例）：返回 null = 本控制器不持有该 uri 的状态
   *  （prerun 分支缺 detail/patch）——多实例单 scheme 注册时调用方继续问下一个；
   *  HEAD 分支是纯工作区函数无状态，任一控制器可算 */
  async tryHeadContent(uri: vscode.Uri): Promise<string | null> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // 未跟踪文件的对比侧：query 带 prerun: 前缀 → 返回本轮改动前内容（patch 链逆向，
    // 任一步不符返回失败占位——与 revertFile 同源校验，不硬猜）
    // 工单十一实证：uri.query 是编码形态（URI.parse 只拆分不解码，%3A 原样保留）。
    // 故统一先 decodeURIComponent 整个 query 再 startsWith("prerun:") 判断——
    // 旧代码双分支判断（%3A 与裸冒号）+ slice(7) 会把编码串 "prerun%3A..." 切出
    // 半编码残片（"3Ad%3A…"），decode 后带前导垃圾 → changesDetail 查不到 → 左侧白屏；
    // 且 encodeURIComponent 拼的 query 恒为编码形态，裸冒号分支实际永远走不到。
    // 统一 decode 后判断，两种 startsWith 分支之谜就此了结。
    const q = decodeURIComponent(uri.query);
    if (q.startsWith("prerun:")) {
      const abs = q.slice("prerun:".length);
      const d = this.changesOf(this.activeTabId).detail.get(this.hunkKey(abs));
      if (!d || !d.patches.length) return null; // 不持有（多实例分发：问下一家）
      const pre = this.prerunContent(abs, d);
      return pre.ok ? pre.content : this.L.chgHeadFail;
    }
    const rel = q;
    if (!root) return this.L.chgHeadFail;
    const out = await this.git(["show", "HEAD:" + rel], root);
    return out ?? this.L.chgHeadFail;
  }

  /** 查看 tracked 文件的 HEAD ↔ 工作区 diff */
  private async openHeadDiff(abs: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    const headUri = vscode.Uri.parse("pi-head:/" + encodeURIComponent(abs) + "?" + encodeURIComponent(rel));
    await vscode.commands.executeCommand(
      "vscode.diff",
      headUri,
      vscode.Uri.file(abs),
      path.basename(abs) + "  (HEAD ↔ " + this.L.chgWorking + ")",
      { preview: true }
    );
  }

  // ── 变更页（2026-11-05 用户拍板 A 方案：左清单+右并排 diff，截图为形）──
  /** 打开变更页：算好逐文件 hunk 后一次性回发。清单不变时复用缓存
   *  （同一个改动反复看是常态，重算就得多 spawn N 次 git / 重读 N 个文件） */
  async openPage(): Promise<void> {
    const tabId = this.activeTabId;
    const s = this.changesOf(tabId);
    if (!s.files.length) {
      this.post({ type: "notice", text: this.L.chgNone });
      return;
    }
    if (!s.page) s.page = await this.buildPage(s.files);
    const page = s.page;
    if (!page) return; // await 期间被新 run/还原作废：不发过期数据
    this.post({ type: "changesPage", files: page.files, totalAdds: page.totalAdds, totalDels: page.totalDels }, tabId);
  }

  private async buildPage(
    files: ChangesFileInfo[]
  ): Promise<{ files: ChangesDiffFile[]; totalAdds: number; totalDels: number }> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const out: ChangesDiffFile[] = [];
    // 逐文件串行：一个 run 的改动清单通常几十个以内；并发 spawn git 在 Windows 上反而
    // 抢进程创建锁（且本函数只在开页那一刻跑一次，缓存后不重复）
    for (const f of files) out.push(await this.fileDiff(f, root));
    let totalAdds = 0;
    let totalDels = 0;
    for (const f of out) {
      totalAdds += f.adds;
      totalDels += f.dels;
    }
    return { files: out, totalAdds, totalDels };
  }

  /** 单文件 diff：路由与 openChangesDiff 同源（tracked 走 HEAD，其余走 patch 逆向），
   *  但产物是 hunk 文本而不是开编辑器——数据面全在宿主，webview 不做任何 git/磁盘访问 */
  private async fileDiff(f: ChangesFileInfo, root: string): Promise<ChangesDiffFile> {
    const rel = this.relOf(root, f.path);
    const d = this.changesOf(this.activeTabId).detail.get(this.hunkKey(f.path));
    let diff = "";
    let note = "";
    if (d?.canGit && d.inHead && root) {
      // tracked：git 自己算（不读文件，删除文件也能对比；--no-ext-diff 防用户配的外部 diff 输出脏）
      const raw = (await this.git(["diff", "HEAD", "--no-color", "--no-ext-diff", "--", rel], root)) ?? "";
      if (/^Binary files /m.test(raw)) note = this.L.chgPageBinary;
      diff = this.hunkOnly(raw);
      if (!diff && !note) note = this.L.chgPageNoDiff;
    } else {
      // 未跟踪/仅工具命中：基线 = patch 链逆向（无 patch 的未跟踪文件基线是空，全文件算新增）
      let oldText = "";
      if (d && d.patches.length) {
        const pre = this.prerunContent(f.path, d);
        if (pre.ok) oldText = pre.content;
        else note = this.L.chgPageNoBase;
      }
      if (!note) {
        const cur = this.readText(f.path);
        if (!cur.ok) note = cur.binary ? this.L.chgPageBinary : this.L.chgPageGone;
        else diff = this.hunkOnly(await this.unifiedPatch(rel, oldText, cur.text));
      }
    }
    const { adds, dels } = this.countDiff(diff);
    return {
      path: f.path,
      rel,
      adds,
      dels,
      diff: note ? "" : diff,
      note: note || undefined,
      // 资格判定复用 QuickPick 那两个判据（单一真相，不另写一份）：
      // canDiff = 有可取的基线；canRevert = 裁决 11 的还原资格（仅工具命中）
      canDiff: !!d && ((d.canGit && d.inHead) || (d.source === "tool" && d.patches.length > 0)),
      canRevert: !!d && this.revertable(d),
      preexisting: d?.preexisting || undefined,
    };
  }

  /** 工作区内 → 相对路径（正斜杠）；工作区外/无工作区 → 绝对路径原样（不造 ../ 垃圾显示） */
  private relOf(root: string, abs: string): string {
    if (!root) return abs;
    const r = path.relative(root, abs);
    return !r || r.startsWith("..") ? abs.replace(/\\/g, "/") : r.replace(/\\/g, "/");
  }

  /** 读文本；二进制（含 NUL）与不存在分开报（二进制有内容但不能渲染，删除连内容都没了——
   *  两种 note 文案不同，混成一种就是骗用户） */
  private readText(abs: string): { ok: true; text: string } | { ok: false; binary: boolean } {
    try {
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return { ok: false, binary: true };
      return { ok: true, text: buf.toString("utf8") };
    } catch {
      return { ok: false, binary: false };
    }
  }

  /** hunk 计算复用 pi 公开 API（dist/index.d.ts:25 导出 generateUnifiedPatch）——
   *  壳原则：能蹭 pi 的算法就蹭，不自写 Myers；pi 真不可用才退化到「整文件替换」单 hunk
   *  （丢失精细化但不让功能整块挂掉，且行数统计仍然对得上） */
  private async unifiedPatch(rel: string, oldText: string, newText: string): Promise<string> {
    try {
      const sdk = await loadPiSdk();
      const fn = sdk?.generateUnifiedPatch;
      if (typeof fn === "function") return this.hunkOnly(String(fn(rel, oldText, newText) ?? ""));
    } catch {
      /* 退化路径见下 */
    }
    if (oldText === newText) return "";
    const cut = (s: string): string[] => {
      const ls = s.split("\n");
      if (ls.length && ls[ls.length - 1] === "") ls.pop();
      return ls;
    };
    const ol = cut(oldText);
    const nl = cut(newText);
    return ["@@ -1," + ol.length + " +1," + nl.length + " @@", ...ol.map((l) => "-" + l), ...nl.map((l) => "+" + l)].join("\n");
  }

  /** 只留 hunk：从首个 @@ 行起。git 与 pi 的头部形态不同（diff --git/index/---/+++），
   *  剥干净后 webview 只认一种文法，渲染侧不写两套解析 */
  private hunkOnly(text: string): string {
    const lines = String(text ?? "").split("\n");
    let i = 0;
    while (i < lines.length && !lines[i].startsWith("@@")) i++;
    return i >= lines.length ? "" : lines.slice(i).join("\n");
  }

  /** +N/-M 从 hunk 文本数（头部已剥，不会把 +++/--- 算进去；未跟踪文件用不上 git numstat） */
  private countDiff(diff: string): { adds: number; dels: number } {
    let adds = 0;
    let dels = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+")) adds++;
      else if (line.startsWith("-")) dels++;
    }
    return { adds, dels };
  }

  /** 变更页「在 VS Code 中对比」：与 QuickPick 同一条路由（canDiff 已在页面算好，这里只转发） */
  async openNativeDiff(abs: string): Promise<void> {
    await this.openChangesDiff(abs);
  }

  /** 变更页「还原」：资格不足只报不做（与 QuickPick 同口径）；revertFile 自带模态确认与
   *  全部守卫（HEAD checkout / patch 逆向任一行不符即拒打）——webview 无法绕过 */
  async revertByPath(abs: string): Promise<void> {
    const d = this.changesOf(this.activeTabId).detail.get(this.hunkKey(abs));
    if (!d || !this.revertable(d)) {
      this.post({ type: "notice", text: this.L.chgNoAction });
      return;
    }
    await this.revertFile(abs, d);
  }

  /** 单文件还原（破坏性操作，deleteSession 同规格：模态二次确认，失败只报不硬打） */
  private async revertFile(
    abs: string,
    d: { source: string; tool: string; patches: string[]; canGit: boolean; inHead: boolean; preexisting: boolean }
  ): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    // 编辑器里有未保存修改时提醒：还原的是磁盘内容，脏缓冲不会自动同步
    const dirty = vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === abs && doc.isDirty);
    const detailParts = [abs];
    if (d.preexisting) detailParts.push(this.L.chgPreexisting);
    if (dirty) detailParts.push(this.L.chgDirtyWarn);
    const yes = await vscode.window.showWarningMessage(
      this.L.chgRevertAsk,
      { modal: true, detail: detailParts.join("\n") },
      this.L.chgRevertBtn
    );
    if (yes !== this.L.chgRevertBtn) return;
    try {
      if (d.canGit && d.inHead) {
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        const out = await this.git(["checkout", "HEAD", "--", rel], root);
        if (out === null) {
          this.post({ type: "notice", text: this.L.chgRevertFail + "git checkout 失败" });
          return;
        }
      } else {
        // 未跟踪/无 git：edit patch 链逆序逆向（裁决 11③）。任一步不符 → 拒打不落盘
        let content = fs.readFileSync(abs, "utf8");
        for (let i = d.patches.length - 1; i >= 0; i--) {
          const r = reverseApplyPatch(content, d.patches[i]);
          if (!r.ok || r.content === null) {
            this.post({ type: "notice", text: this.L.chgIrreversible + (r.reason ?? "") });
            return;
          }
          content = r.content;
        }
        fs.writeFileSync(abs, content, "utf8");
      }
      this.post({ type: "notice", text: this.L.chgRevertDone + path.basename(abs) });
      const s = this.changesOf(this.activeTabId);
      s.files = s.files.filter((f) => f.path !== abs);
      s.detail.delete(abs);
      s.page = null; // 还原后 diff 已变，缓存作废（页内动作后可原地重发）
      this.postChangesList(this.activeTabId);
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.chgRevertFail + (err?.message ?? err) });
    }
  }
}
