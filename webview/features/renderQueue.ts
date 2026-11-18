/**
 * 渲染队列（2026-11-25 第 5 刀子刀 5f，从 webview/main.ts 整块拆出；第 5 刀收尾）：
 * scheduleRender / flushRender / deferDuringRender / drainPendingStream + 状态
 * renderPending / liveSyncPending / renderTimer / pendingStream。
 *
 * 为什么是 initRenderQueue(deps)：本模块是**每页签一套**的视图成员（每个 SessionView 一个
 * 延时重绘定时器、一份待重绘快照、一条重绘窗口期的流式事件队列）。入口在 makeSessionView 里
 * 装配一次，页签销毁时由 dispose() 连定时器一起清（不 clearTimeout 会留一条已摘除视图的回调）。
 *
 * ★ 红线一（R10：renderTimer 全仓只允许一份）：同一个 timer 既决定 handleMsg 是否把流式事件
 *   排进 pendingStream（第 5 刀域），又由 drainPendingStream 经 routeMsg 回灌（第 6 刀域）。
 *   所以 routeMsg **留 main.ts**（6a 才搬），经 deps 回调注入；main.ts 不许再存一份 renderTimer。
 *   两边各存 = 判定看一个定时器、回灌看另一个，重绘窗口期的流式事件要么丢、要么乱序。handleMsg
 *   侧只经 queueDuringRender(m) 一个口问「要不要排队」。
 *
 * ★ 红线二（pendingStream 只搬读写口）：它是消息流的排队队列，5b 的 appendDelta 增量渲染仍住
 *   features/liveStream.ts——本模块只负责入队与按原序重放（重放经 deps.routeMsg 交回路由，
 *   不自己碰 DOM/handleMsg）。
 *
 * ★ 红线三（语义零改，用户逐条实测纠过，别「优化」）：
 *   ① 快照先画、事件后补同拍顺序——flushRender 里 render → liveSync → drainPendingStream 的次序
 *      就是「先整树重绘，再续接重定基，最后补放重绘期间攒下的流式事件」；render 与 liveSync 同拍，
 *      防 renderAll 的 liveReset 抹掉先到的重定基状态。
 *   ② 三层合并口径：scheduleRender 的 setTimeout(0) 单拍合并；renderPending / liveSyncPending
 *      各只留最后一份；pendingStream 按到达序整批重放（不丢不乱序）。
 *   逐字核对见 reports/REPORT-t43.md。
 */
import type { HostToWebviewTagged, SessionMessage } from "../../src/core/protocol";

export interface RenderQueueDeps {
  /** 整树重绘（features/messageList.ts 的 renderAll，第 5 刀 5d）——快照先画 */
  renderAll: (list: SessionMessage[]) => void;
  /** 续接重定基（features/liveStream.ts 的 applyLiveSync，第 5 刀 5b）——紧随重绘同拍 */
  applyLiveSync: (msg: SessionMessage) => void;
  /** ★ 消息路由留 main.ts（6a 才搬）：排队的流式事件按原序交回路由（各归各的页签视图） */
  routeMsg: (m: HostToWebviewTagged) => void;
}

export function initRenderQueue(deps: RenderQueueDeps) {
  var renderAll = deps.renderAll;
  var applyLiveSync = deps.applyLiveSync;
  var routeMsg = deps.routeMsg;

  /** 重绘/续接排队（刀5b）：render 与 liveSync 同拍顺序执行（快照重绘 → 在途消息重定基），
   *  防止 renderAll 的 liveReset 抹掉先到的重定基状态 */
  var renderPending: SessionMessage[] | null = null;
  var liveSyncPending: SessionMessage | null = null;
  var renderTimer: number | null = null;
  function scheduleRender() {
    // 三期④：换镜舞蹈退役（原「先换回发起页签再重绘」——闭包天然绑定，无需换）
    if (!renderTimer) renderTimer = setTimeout(function () {
      renderTimer = null;
      flushRender();
    }, 0);
  }
  function flushRender() {
    renderTimer = null;
    if (renderPending) {
      var list = renderPending; renderPending = null;
      renderAll(list);
    }
    if (liveSyncPending) { var msg2 = liveSyncPending; liveSyncPending = null; applyLiveSync(msg2); }
    drainPendingStream();
  }

  // 就被冲掉（快照基线不含它们）。实证教训：宿主侧靠 sleep 等重绘不可靠（长会话重绘能把
  // 20ms 顶穿），顺序保证必须落在消费端。重绘进行中（renderTimer 非空）到达的流式事件
  // 先攒着，flushRender 里 render+liveSync 之后按原序放行——顺序仍是「快照先画、事件后补」
  var pendingStream: HostToWebviewTagged[] = [];
  function deferDuringRender(t: string): boolean {
    // 粘性回显刀（2026-09-23 交接 §八.1，用户令「能改就改了」）：'user' 移出延后名单。
    // 病灶：启动渲染窗口期（renderTimer 非空）发的消息，回显被排进 pendingStream，压到重绘
    // 落地才画——用户体感「气泡 1s 才出」。顺序风险原是「renderAll 的 liveReset 抹先到事件」，
    // 但 addUser 追加 bubble 与 liveReset（只清 live 区）互不触碰，立即画上无序可破；
    // 且历史重绘以 pi session.messages 为唯一真相，回显 bubble 被权威 render 覆盖是设计而非事故。
    return t === 'delta' || t === 'thinking' || t === 'newLive' || t === 'toolCallStart' ||
      t === 'toolCallDelta' || t === 'toolStart' || t === 'toolEnd' ||
      t === 'queuedAdd' || t === 'queuedDelivered' || t === 'queuedRemove' || t === 'queuedClear';
  }
  function drainPendingStream() {
    if (!pendingStream.length) return;
    var q = pendingStream; pendingStream = [];
    for (var i = 0; i < q.length; i++) routeMsg(q[i]);
  }

  // ── 对 main.ts 的读写口（handleMsg 只经这几个口，绝不自己持有队列状态）──
  /** 重绘在途（延后一拍）时把流式事件排队；返回 true = 已排队，调用方直接返回。
   *  R10：是否在途由模块唯一的 renderTimer 判，main.ts 不存副本 */
  function queueDuringRender(m: HostToWebviewTagged): boolean {
    if (renderTimer !== null && deferDuringRender(m.type)) { pendingStream.push(m); return true; }
    return false;
  }
  /** 待重绘快照（uiState / render 分支；同一拍内后到的覆盖先到的，与原赋值语义一致） */
  function setRenderPending(list: SessionMessage[] | null) { renderPending = list; }
  /** 待续接重定基（uiState / liveSync 分支；只留最后一份） */
  function setLiveSyncPending(msg: SessionMessage | null) { liveSyncPending = msg; }
  /** 页签视图销毁：清掉在途的延时重绘（原 dispose 里的 clearTimeout 分支） */
  function dispose() {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  }

  return {
    /** 延后一拍合并重绘（render / liveSync / uiState 三个分支共用） */
    scheduleRender: scheduleRender,
    /** 重绘在途时把流式事件排队（true = 已排队，调用方 return） */
    queueDuringRender: queueDuringRender,
    /** 待重绘快照写入 */
    setRenderPending: setRenderPending,
    /** 待续接重定基写入 */
    setLiveSyncPending: setLiveSyncPending,
    /** 页签视图销毁时清定时器 */
    dispose: dispose
  };
}
