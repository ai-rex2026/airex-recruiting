/** ドメイン正規化（名寄せキー） */
export function normalizeDomain(input: string): string {
  let s = (input || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

export function safeUrl(u: string): string {
  const s = (u || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** 打診レコードのステータス定義（要件定義書 7.1） */
export const OUTREACH_STATUS = {
  collected: "収集済",
  excluded: "対象外",
  confirmed: "対象確定",
  drafted: "文面生成済",
  awaiting_approval: "送信承認待ち",
  queued: "送信待ち",
  sent: "送信済",
  uncertain: "不確定",
  exception: "例外",
  replied: "返信あり",
  negotiating: "条件交渉中",
  placeable: "掲載可能",
  placed: "掲載中",
  reported: "報告済",
  rejected: "掲載不可",
  no_reply: "返答なし",
} as const;

export type OutreachStatus = keyof typeof OUTREACH_STATUS;

export const STATUS_ORDER: OutreachStatus[] = [
  "collected",
  "confirmed",
  "drafted",
  "awaiting_approval",
  "queued",
  "sent",
  "uncertain",
  "exception",
  "replied",
  "negotiating",
  "placeable",
  "placed",
  "reported",
  "rejected",
  "no_reply",
  "excluded",
];

/** 送信結果の分類（要件定義書 7.2） */
export const SEND_RESULT = {
  queued: "送信待ち",
  success: "成功",
  uncertain: "不確定",
  form_error: "フォーム不備",
  url_error: "URL不正",
  captcha: "CAPTCHA",
  no_solicitation: "営業お断り",
  manual: "手動送信済",
} as const;
export type SendResult = keyof typeof SEND_RESULT;

/** 二重送信防止：この結果を持つ打診は再送対象にしない */
export const BLOCKING_RESULTS: SendResult[] = [
  "success",
  "uncertain",
  "no_solicitation",
  "manual",
];

export const REPLY_CLASS = {
  placeable: "掲載可能",
  negotiating: "条件交渉",
  rejected: "掲載不可",
  irrelevant: "自動応答・無関係",
} as const;

export function statusTone(s: string): string {
  if (["placed", "reported", "placeable"].includes(s)) return "bg-emerald-100 text-emerald-800";
  if (["rejected", "excluded"].includes(s)) return "bg-zinc-200 text-zinc-600";
  if (["exception", "uncertain"].includes(s)) return "bg-amber-100 text-amber-800";
  if (["awaiting_approval", "queued"].includes(s)) return "bg-orange-100 text-orange-800";
  if (["sent", "replied", "negotiating"].includes(s)) return "bg-sky-100 text-sky-800";
  return "bg-slate-100 text-slate-700";
}
