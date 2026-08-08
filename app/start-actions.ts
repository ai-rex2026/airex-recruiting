"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Anthropic from "@anthropic-ai/sdk";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { askJson, hasAnthropic } from "@/lib/anthropic";
import { normalizeDomain, safeUrl } from "@/lib/domain";

/**
 * 「かんたん開始」ウィザード用のサーバーアクション。
 * 商品URL / 商品テキスト → AIが案件・KWを提案 → 案件作成 → Claude の Web検索ツールで自動収集。
 * 収集まで（打診対象の確定・送信は人の承認が必要。自動送信はしない）。
 */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

function anthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

type SB = Awaited<ReturnType<typeof createClient>>;

async function ctx() {
  const { sb, user, profile } = await getSessionProfile();
  if (!user || !profile) redirect("/login");
  return { sb, user: user!, profile: profile! };
}

async function audit(
  sb: SB,
  tenantId: string,
  actorId: string,
  actorName: string,
  entity: string,
  entityId: string | null,
  action: string,
  detail = ""
) {
  await sb.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_id: actorId,
    actor_name: actorName,
    entity,
    entity_id: entityId,
    action,
    detail,
  });
}

/* ============ Step 1: URL/テキスト → 案件ドラフト提案 ============ */

export type CampaignDraft = {
  client_name: string;
  campaign_name: string;
  product_name: string;
  selling_points: string;
  conversion_point: string;
  keywords: { keyword: string; priority: 1 | 2 | 3 }[];
};

export type ProposeResult =
  | { ok: true; draft: CampaignDraft; input_url: string; note?: string }
  | { ok: false; error: string };

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15000);
}

export async function proposeCampaignFromInput(formData: FormData): Promise<ProposeResult> {
  await ctx();

  const inputUrl = safeUrl(String(formData.get("input_url") || "").trim());
  const inputText = String(formData.get("input_text") || "").trim();

  if (!inputUrl && !inputText) {
    return { ok: false, error: "商品LPのURL、または商品説明のテキストのどちらかを入力してください。" };
  }
  if (!hasAnthropic()) {
    return { ok: false, error: "ANTHROPIC_API_KEY が未設定のため、AI分析を実行できません。" };
  }

  let pageText = "";
  let note: string | undefined;
  if (inputUrl) {
    try {
      const res = await fetch(inputUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
        },
      });
      const html = await res.text();
      pageText = htmlToText(html);
      if (!pageText) note = "LPの本文を取得できませんでした（テキスト入力の内容のみで分析）。";
    } catch {
      note = "LPの取得に失敗しました（タイムアウト等）。入力テキストのみで分析しています。";
    }
  }

  const material = [
    inputUrl ? `商品LPのURL: ${inputUrl}` : "",
    pageText ? `LPから抽出した本文（先頭のみ）:\n${pageText}` : "",
    inputText ? `担当者からの商品情報・メモ:\n${inputText.slice(0, 8000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const out = await askJson<CampaignDraft>(
    `あなたは日本のアフィリエイト広告代理店のプランナーです。商材情報から、広告リクルーティング（ランキング/比較メディアへの掲載打診）用の案件ドラフトを作ります。
- client_name: 運営会社名（分からなければ商材名から推定。不明なら空文字）
- campaign_name: 「〇〇（商材名） 掲載獲得」のような簡潔な案件名
- product_name: 商材・サービス名
- selling_points: 訴求ポイント・信用点（箇条書きを「／」区切りの1行に）
- conversion_point: 想定される成果地点（例: 無料相談申込、資料請求、購入。読み取れなければ妥当な推定）
- keywords: 見込み客が検索しそうな日本語キーワードを8〜12個。検索結果に「ランキング／比較／おすすめ」記事が並びやすい語を優先し、「〇〇 おすすめ」「〇〇 比較」「〇〇 ランキング」型を必ず含める。priority は 1（最優先）〜3。`,
    `以下の商材について案件ドラフトを作成してください。

${material}

出力形式（STRICT JSON のみ）:
{"client_name":"...","campaign_name":"...","product_name":"...","selling_points":"...","conversion_point":"...","keywords":[{"keyword":"...","priority":1}]}`,
    4000
  );

  if (!out || !out.product_name || !Array.isArray(out.keywords)) {
    return { ok: false, error: "AIの分析結果を解析できませんでした。もう一度お試しください。" };
  }

  const draft: CampaignDraft = {
    client_name: String(out.client_name || ""),
    campaign_name: String(out.campaign_name || `${out.product_name} 掲載獲得`),
    product_name: String(out.product_name || ""),
    selling_points: String(out.selling_points || ""),
    conversion_point: String(out.conversion_point || ""),
    keywords: (out.keywords || [])
      .map((k) => ({
        keyword: String(k?.keyword || "").trim(),
        priority: ([1, 2, 3].includes(Number(k?.priority)) ? Number(k?.priority) : 3) as 1 | 2 | 3,
      }))
      .filter((k) => k.keyword)
      .slice(0, 12),
  };
  if (!draft.keywords.length) {
    return { ok: false, error: "キーワードを提案できませんでした。テキストを追加してもう一度お試しください。" };
  }

  return { ok: true, draft, input_url: inputUrl, note };
}

/* ============ Step 2: ドラフト確定 → 案件・KW作成 ============ */

export type CreateFromDraftResult =
  | { ok: true; campaign_id: string; keywords: { id: string; keyword: string }[] }
  | { ok: false; error: string };

export async function createCampaignFromDraft(payload: {
  client_name: string;
  campaign_name: string;
  product_name: string;
  selling_points: string;
  conversion_point: string;
  input_url: string;
  keywords: { keyword: string; priority: number }[];
}): Promise<CreateFromDraftResult> {
  const { sb, profile } = await ctx();

  const keywords = (payload.keywords || [])
    .map((k) => ({
      keyword: String(k.keyword || "").trim(),
      priority: [1, 2, 3].includes(Number(k.priority)) ? Number(k.priority) : 3,
    }))
    .filter((k) => k.keyword)
    .slice(0, 30);
  if (!keywords.length) return { ok: false, error: "キーワードを1つ以上選択してください。" };

  // クライアントを名前で名寄せ（既存があれば再利用）
  const clientName = String(payload.client_name || "").trim();
  let clientId: string | null = null;
  if (clientName) {
    const { data: existing } = await sb
      .from("clients")
      .select("id")
      .eq("tenant_id", profile.tenant_id)
      .eq("name", clientName)
      .maybeSingle();
    if (existing) clientId = existing.id;
    else {
      const { data } = await sb
        .from("clients")
        .insert({ tenant_id: profile.tenant_id, name: clientName })
        .select("id")
        .single();
      clientId = data?.id ?? null;
    }
  }

  const { data: camp, error: campErr } = await sb
    .from("campaigns")
    .insert({
      tenant_id: profile.tenant_id,
      client_id: clientId,
      name: String(payload.campaign_name || "無題の案件"),
      product_name: String(payload.product_name || ""),
      lp_url: safeUrl(String(payload.input_url || "")),
      unit_price: "",
      conversion_point: String(payload.conversion_point || ""),
      approval_terms: "",
      selling_points: String(payload.selling_points || ""),
    })
    .select("id")
    .single();
  if (campErr || !camp) return { ok: false, error: `案件の作成に失敗しました：${campErr?.message ?? "不明なエラー"}` };

  const { data: kwRows, error: kwErr } = await sb
    .from("keywords")
    .insert(
      keywords.map((k) => ({
        tenant_id: profile.tenant_id,
        campaign_id: camp.id,
        keyword: k.keyword,
        priority: k.priority,
      }))
    )
    .select("id, keyword");
  if (kwErr) return { ok: false, error: `キーワードの登録に失敗しました：${kwErr.message}` };

  await audit(
    sb,
    profile.tenant_id,
    profile.id,
    profile.full_name,
    "campaign",
    camp.id,
    "created_from_wizard",
    `かんたん開始：KW ${kwRows?.length ?? 0}件`
  );
  revalidatePath("/campaigns");
  revalidatePath("/board");

  return { ok: true, campaign_id: camp.id, keywords: kwRows ?? [] };
}

/* ============ Step 3: 1キーワードずつ Web検索で自動収集 ============ */

type FoundSite = {
  rank: number | null;
  title: string;
  url: string;
  site_name: string;
  is_ranking_article: boolean;
  reason: string;
  listed_services: { position: number | null; name: string }[];
  own_listed: boolean;
  own_position: number | null;
};

export type CollectAutoResult =
  | { ok: true; found: number; ranking_articles: number; media_new: number }
  | { ok: false; error: string };

function extractLastJsonBlock<T>(text: string, anchor: string): T | null {
  const tryParse = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  const anchorIdx = text.lastIndexOf(anchor);
  if (anchorIdx >= 0) {
    const start = text.lastIndexOf("{", anchorIdx);
    if (start >= 0) {
      const parsed = tryParse(text.slice(start, end + 1));
      if (parsed) return parsed;
    }
  }
  const first = text.indexOf("{");
  if (first < 0) return null;
  return tryParse(text.slice(first, end + 1));
}

export async function collectKeywordAuto(
  campaignId: string,
  keywordId: string
): Promise<CollectAutoResult> {
  const { sb, profile } = await ctx();

  if (!hasAnthropic()) {
    return { ok: false, error: "ANTHROPIC_API_KEY が未設定です。/collect の貼り付け方式をご利用ください。" };
  }

  const { data: camp } = await sb.from("campaigns").select("*").eq("id", campaignId).single();
  const { data: kw } = await sb.from("keywords").select("*").eq("id", keywordId).maybeSingle();
  if (!camp || !kw) return { ok: false, error: "案件またはキーワードが見つかりません。" };

  const productName = camp.product_name || camp.name || "";

  const prompt = `日本語のWebを検索して、検索キーワード「${kw.keyword}」の検索上位に出てくる「ランキング／比較／おすすめ」形式の記事・サイトを特定してください。
- 対象: 複数のサービス・商品を順位付け・比較して紹介している第三者メディアの記事
- 除外: サービス公式サイト・公式LP、ECモールの商品ページ、単なるニュース記事、SNS
- 最大12件
- own_listed = 対象商材「${productName}」（訴求: ${camp.selling_points || "—"}）がその記事内に掲載されているか
- listed_services = 記事内で上位に掲載されているサービス名（分かる範囲で最大10件）

検索・確認が終わったら、最後に STRICT JSON のみを出力してください（前置き・コードフェンス不要）:
{"sites":[{"rank":1,"title":"...","url":"https://...","site_name":"...","is_ranking_article":true,"reason":"判定理由を20字程度で","listed_services":[{"position":1,"name":"..."}],"own_listed":false,"own_position":null}]}`;

  let sites: FoundSite[] = [];
  try {
    const anthropic = anthropicClient();
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 } as any],
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    const parsed = extractLastJsonBlock<{ sites: FoundSite[] }>(text, '"sites"');
    sites = (parsed?.sites ?? []).slice(0, 12);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/web_search|tool|not[_\s]?(available|enabled|supported)|permission/i.test(msg)) {
      return {
        ok: false,
        error: "このAPIキーではWeb検索ツールが利用できないようです。/collect の貼り付け方式をご利用ください。",
      };
    }
    return { ok: false, error: `自動検索に失敗しました（${msg.slice(0, 200)}）。/collect の貼り付け方式もご利用いただけます。` };
  }

  if (!sites.length) {
    return { ok: false, error: "検索結果からランキング/比較記事を特定できませんでした。/collect の貼り付け方式をお試しください。" };
  }

  // ===== 永続化（ingestCollection と同じ流れ）=====
  const { data: snap } = await sb
    .from("serp_snapshots")
    .insert({
      tenant_id: profile.tenant_id,
      keyword_id: keywordId,
      source: "ai_web_search",
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (!snap) return { ok: false, error: "スナップショットの作成に失敗しました。" };

  const { data: aspRows } = await sb
    .from("asp_master")
    .select("domain, asp_name")
    .eq("tenant_id", profile.tenant_id);
  const aspMap = new Map((aspRows ?? []).map((a) => [a.domain, a.asp_name]));

  const prod = String(productName).trim();
  const isOwnName = (name: string) =>
    !!prod && !!name && (name.includes(prod) || prod.includes(name));

  let created = 0;
  let mediaNew = 0;
  let rankingArticles = 0;

  for (let i = 0; i < sites.length; i++) {
    const r = sites[i];
    const url = safeUrl(String(r.url || ""));
    const domain = normalizeDomain(url);
    if (!domain) continue;

    // メディアを名寄せして upsert
    let { data: media } = await sb
      .from("media")
      .select("*")
      .eq("tenant_id", profile.tenant_id)
      .eq("domain", domain)
      .maybeSingle();
    if (!media) {
      const asp = aspMap.get(domain);
      const { data: inserted } = await sb
        .from("media")
        .insert({
          tenant_id: profile.tenant_id,
          domain,
          name: r.site_name || domain,
          asp_type: asp ? "asp" : "direct",
          asp_name: asp || "",
        })
        .select("*")
        .single();
      media = inserted;
      if (inserted) mediaNew++;
    }
    if (!media) continue;

    const { data: entry } = await sb
      .from("serp_entries")
      .insert({
        tenant_id: profile.tenant_id,
        snapshot_id: snap.id,
        media_id: media.id,
        rank: r.rank ?? i + 1,
        article_url: url,
        article_title: r.title || "",
        is_ranking_article: !!r.is_ranking_article,
        judge_reason: r.reason || "",
        own_listed: !!r.own_listed,
        own_rank_in_article: r.own_position ?? null,
      })
      .select("id")
      .single();

    if (entry && r.listed_services?.length) {
      await sb.from("article_listings").insert(
        r.listed_services.slice(0, 10).map((c) => ({
          tenant_id: profile.tenant_id,
          serp_entry_id: entry.id,
          position: c.position ?? null,
          service_name: c.name || "",
          is_own: isOwnName(String(c.name || "")),
        }))
      );
    }

    if (!r.is_ranking_article) continue;
    rankingArticles++;

    // 打診レコード（campaign × media）。既存があれば触らない
    const { data: exist } = await sb
      .from("outreach_targets")
      .select("id")
      .eq("campaign_id", campaignId)
      .eq("media_id", media.id)
      .maybeSingle();
    if (!exist) {
      await sb.from("outreach_targets").insert({
        tenant_id: profile.tenant_id,
        campaign_id: campaignId,
        media_id: media.id,
        kind: r.own_listed ? "replace" : "new",
        status: media.no_solicitation ? "excluded" : "collected",
        status_reason: media.no_solicitation ? "営業お断り（台帳フラグ）" : "",
        article_url: url,
        rank: r.rank ?? i + 1,
      });
      created++;
    }
  }

  await audit(
    sb,
    profile.tenant_id,
    profile.id,
    profile.full_name,
    "collection",
    snap.id,
    "ingested",
    `かんたん開始（AI Web検索） KW:${kw.keyword} / 取得${sites.length}件 / ランキング記事${rankingArticles}件 / 新規打診${created}件`
  );
  revalidatePath("/board");
  revalidatePath("/media");
  revalidatePath(`/campaigns/${campaignId}`);

  return { ok: true, found: sites.length, ranking_articles: rankingArticles, media_new: mediaNew };
}
