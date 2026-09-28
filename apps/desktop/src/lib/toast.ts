/**
 * 客户端提示（toast）的纯数据层：语义色调、错误编号拆分、去重 ID 和无障碍角色。
 * 渲染在 components/Toast.tsx；本文件不依赖 React / CSS，便于回归测试直接加载。
 */
import { splitUserErrorText } from "./userFacingErrors";

/** 与 NoticeRow / AppDialog 相同的四种语义色调。 */
export type ToastTone = "info" | "success" | "warning" | "danger";

export type ToastInput = {
  tone: ToastTone;
  title?: string;
  message: string;
  /** 错误编号；不传时从 message 中的「错误编号：xxx」行拆出。 */
  code?: string | null;
  /** 业务 ID：同一 ID 的提示在显示或排队期间只出现一次。 */
  id?: string;
  autoClose?: number | false;
};

export type ToastModel = {
  id: string;
  tone: ToastTone;
  title: string | null;
  message: string;
  code: string | null;
  autoClose?: number | false;
  /** 失败 / 警告立即播报（alert = assertive），其余礼貌播报（status = polite）。 */
  role: "alert" | "status";
};

/** 同时显示的提示上限：820×560 主窗口里超过 3 条会压到连接按钮区域。 */
export const TOAST_LIMIT = 3;
export const TOAST_AUTO_CLOSE_MS = 2600;
export const TOAST_WIDTH = 320;

export const TOAST_TONES: readonly ToastTone[] = ["info", "success", "warning", "danger"];

export function toastRole(tone: ToastTone): ToastModel["role"] {
  return tone === "danger" || tone === "warning" ? "alert" : "status";
}

/** 去重 ID 会成为 DOM id：用内容哈希，避免空格、引号等字符出现在 id 里。 */
function hashKey(text: string) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/**
 * 统一整理一条提示：错误编号单独成行展示；没有业务 ID 的相同提示共用一个 ID，
 * 显示或排队期间不会重复堆叠，关闭后再次出现仍可重新显示。
 */
export function toToastModel(input: ToastInput): ToastModel {
  let message = input.message;
  let code = input.code?.trim() || null;
  const split = splitUserErrorText(message);
  if (split.code) {
    message = split.message;
    code = code ?? split.code;
  }
  const title = input.title?.trim() ? input.title : null;
  return {
    id: input.id ?? `client-notice-${hashKey(JSON.stringify([input.tone, title, message, code]))}`,
    tone: input.tone,
    title,
    message,
    code,
    ...(input.autoClose === undefined ? {} : { autoClose: input.autoClose }),
    role: toastRole(input.tone)
  };
}
