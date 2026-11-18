/**
 * webview 跨功能共享的可变状态（变更页拆成 features/changesPage.ts 时抽出，2026-11-21）。
 *
 * 为什么单独成文件：main.ts 是一个 IIFE + 一百多个函数全靠闭包共享可变值，功能块往文件外
 * 拆的时候，唯一必须跨文件共享的就是这几个「谁都要读、谁都能写」的值。集中到这里 = 有单一
 * 读写口（下面的 getter/setter），不必把整个宿主闭包传出去。不引框架、不改语义：容器还是一份
 * 可变对象，getter/setter 只是读写口，拆分前后是同一份内存、同一次赋值。
 *
 * 分两层，别混：
 *  ① 应用级（所有页签共享一份，本文件的 app 容器）：活动页签 id。
 *     写入口 = setActiveTabId，读入口 = getActiveTabId。
 *  ② 会话级（每个 SessionView 一份，makeSessionView 里 createViewState 建）：
 *     busy（主回合在跑）/ 变更页数据（chgData、chgSel）。
 *     后台页签只能写自己那一份——三期整树搬迁消灭的就是「串会话」这类事故（白 Working、
 *     A 页签的改动显示在 B 页签上），状态搬来 state.ts 也不许把这类事故重新引进来：
 *     所以这些字段**不进** ①，永远是每个视图一个对象。
 *
 * 刻意没搬的两样（不是漏）：
 *  - 消息根节点 root：它仍是 makeSessionView 的局部 var，被同闭包内几十处函数直接读。
 *    搬进 ViewState 就得把那些引用全改一遍（纯 churn、零行为收益），而 state 里那一份
 *    今天没有第二个读者 = 死字段。等真有跨文件功能块要读视图根节点时再搬。
 *  - tabsList 之类只被 main.ts 单文件读写的镜像：同理，没有跨文件读者就不搬。
 */
import type { ChangesDiffFile } from "../../src/core/protocol";

/** 变更页全量数据（宿主一次发齐：清单 + 每文件 hunk）。字段同 protocol 的 ChangesPageMsg，
 *  不含 type 判别符——变更页只要数据面。 */
export interface ChangesData {
  files: ChangesDiffFile[];
  totalAdds: number;
  totalDels: number;
}

/** 每个会话视图一份的状态（原来散在 makeSessionView 闭包里的局部变量） */
export interface ViewState {
  /** 本视图所属页签 id（视图闭包自己的 id，与上行桥的 tabId 不同源） */
  id: string;
  /** 本页签主回合是否在跑（原局部变量 streaming；UI 的 Working 还要叠加「子 agent 仍在跑」） */
  busy: boolean;
  /** 变更页数据；changesList 一到就作废（清单变了 hunk 必变） */
  chgData: ChangesData | null;
  /** 变更页当前选中文件的 path（重渲时优先保住用户的选择） */
  chgSel: string;
}

export function createViewState(id: string): ViewState {
  return { id: id, busy: false, chgData: null, chgSel: '' };
}

/** 应用级共享状态：所有页签一份（写入口只有下面的 setter） */
var app = {
  activeTabId: null as string | null
};

/** 当前活动页签 id（null = 还没收到任何页签消息） */
export function getActiveTabId(): string | null { return app.activeTabId; }
export function setActiveTabId(id: string | null): void { app.activeTabId = id; }
