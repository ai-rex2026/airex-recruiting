import Anthropic from "@anthropic-ai/sdk";

/**
 * モデルは2階層にする。判断・生成が要る処理は品質側、機械的な抽出・分類は低コスト側。
 * 記事本文の読取はこのアプリで最も量が多く、実記事21件で突き合わせたところ
 * 掲載順位97.6%・記事種別100%・自社掲載100%が一致し、残差も表記の粒度差だった。
 * 単価は 1/3（$3/$15 → $1/$5）になる。
 */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
export const MODEL_FAST = process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-4-5";

export function hasAnthropic() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function client() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/** 1回の呼び出しで実際に使ったトークン。コスト可視化のために必ず呼び出し元へ返す */
export type AiUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** Web検索ツールの実行回数（トークンとは別に従量課金される） */
  web_searches?: number;
};

export type AskOpts = {
  maxTokens?: number;
  model?: string;
  /** 使用量の記録先。lib/usage.ts の meterTo() を渡す */
  meter?: (u: AiUsage) => Promise<void> | void;
};

export async function askText(system: string, user: string, opts: AskOpts = {}) {
  const model = opts.model ?? MODEL;
  const res = await client().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 2000,
    system,
    messages: [{ role: "user", content: user }],
  });
  await opts.meter?.({
    model,
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
  });
  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

const JSON_ONLY = "\n\n必ず JSON のみを出力すること。前置き・後置き・コードフェンスを付けない。";

function parseJson<T>(raw: string): T | null {
  const cleaned = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

/** JSON を返させる。パースに失敗したら null */
export async function askJson<T>(
  system: string,
  user: string,
  opts: AskOpts = {}
): Promise<T | null> {
  return parseJson<T>(
    await askText(system + JSON_ONLY, user, { maxTokens: 4000, ...opts })
  );
}

/**
 * PDF などのコンテンツブロックを添えて JSON を返させる。
 * PDF は DocumentBlockParam で直接渡せるので、図やスキャンも視覚的に読ませられる。
 */
export async function askJsonWithContent<T>(
  system: string,
  content: Anthropic.Messages.ContentBlockParam[],
  opts: AskOpts = {}
): Promise<T | null> {
  const model = opts.model ?? MODEL;
  const res = await client().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4000,
    system: system + JSON_ONLY,
    messages: [{ role: "user", content }],
  });
  await opts.meter?.({
    model,
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
  });
  const raw = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  return parseJson<T>(raw);
}

/** アップロードされた資料を Claude に渡す形にする（PDF は document ブロック、他はテキスト） */
export function fileContentBlock(
  fileName: string,
  mediaType: string,
  base64OrText: string,
  isPdf: boolean
): Anthropic.Messages.ContentBlockParam {
  if (isPdf) {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64OrText },
      title: fileName,
    };
  }
  return { type: "text", text: `資料「${fileName}」（${mediaType}）の内容:\n${base64OrText}` };
}
