/**
 * AI利用料の単価表と金額計算。
 *
 * 単価は変わるので、記録時点でトークン数を金額に変換して ai_usage に凍結する。
 * 後から単価表を直しても過去の実績が動かないようにするため。
 */

/** 100万トークンあたりの単価（USD） */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** 単価表にないモデルは Sonnet 相当で見積もる（実際より安く見えるより高く見えるほうが安全） */
const FALLBACK = { in: 3, out: 15 };

/** Web検索ツールは1検索あたりの従量（トークンとは別建て） */
const WEB_SEARCH_USD_PER_CALL = 0.01;

/** 円換算レート。請求はUSDなので、画面表示のための目安 */
export const USD_JPY = Number(process.env.USD_JPY) || 155;

export function usdFor(
  model: string,
  inputTokens: number,
  outputTokens: number,
  webSearches = 0
): number {
  const p = PRICES[model] ?? FALLBACK;
  return (
    (inputTokens / 1e6) * p.in +
    (outputTokens / 1e6) * p.out +
    webSearches * WEB_SEARCH_USD_PER_CALL
  );
}

export const yen = (usd: number) => usd * USD_JPY;

/** 金額の表示。数円単位なので小数1桁まで出す */
export function fmtYen(usd: number): string {
  const v = yen(usd);
  if (v === 0) return "0円";
  if (v < 10) return `${v.toFixed(1)}円`;
  return `${Math.round(v).toLocaleString("ja-JP")}円`;
}

/** 何の処理でかかったコストか。画面の内訳はこの単位で出す */
export type UsageKind =
  | "collect_search"
  | "collect_judge"
  | "enrich"
  | "ingest"
  | "campaign_draft"
  | "kw_suggest"
  | "document"
  | "message"
  | "reply"
  | "contact_fix";

export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
  collect_search: "収集：検索",
  collect_judge: "収集：ランキング判定",
  enrich: "記事本文の読取",
  ingest: "貼り付け収集の解析",
  campaign_draft: "案件ドラフト作成",
  kw_suggest: "KW候補の提案",
  document: "資料の読み取り",
  message: "打診文面の生成",
  reply: "返信の分類",
  contact_fix: "問い合わせURL候補",
};
