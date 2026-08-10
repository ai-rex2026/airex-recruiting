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

/* ============ 案件情報の更新（案件詳細ハブの「案件情報・KW」タブ） ============ */

export async function updateCampaignInfo(formData: FormData) {
  const { sb, profile } = await ctx();
  const id = String(formData.get("id"));
  if (!id) return;
  await sb
    .from("campaigns")
    .update({
      name: String(formData.get("name") || "無題の案件"),
      product_name: String(formData.get("product_name") || ""),
      lp_url: safeUrl(String(formData.get("lp_url") || "")),
      unit_price: String(formData.get("unit_price") || ""),
      conversion_point: String(formData.get("conversion_point") || ""),
      approval_terms: String(formData.get("approval_terms") || ""),
      selling_points: String(formData.get("selling_points") || ""),
    })
    .eq("id", id);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "campaign", id, "updated");
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/campaigns");
  revalidatePath("/start");
}

/* ============ 陣取りボードから打診対象を追加 ============ */

/**
 * 検索結果（serp_entries）由来のメディアを、campaign×media の打診対象として追加する。
 * ingestCollection と同じ判定（kind: own_listed→replace / status: 営業お断りなら excluded、それ以外 collected）。
 */
export async function addOutreachTarget(formData: FormData) {
  const { sb, profile } = await ctx();
  const campaignId = String(formData.get("campaign_id") || "");
  const mediaId = String(formData.get("media_id") || "");
  if (!campaignId || !mediaId) return;

  // 既存があれば触らない（campaign×media は一意）
  const { data: exist } = await sb
    .from("outreach_targets")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("media_id", mediaId)
    .maybeSingle();
  if (exist) return;

  const { data: media } = await sb
    .from("media")
    .select("no_solicitation, domain")
    .eq("id", mediaId)
    .maybeSingle();
  if (!media) return;

  const ownListed = String(formData.get("own_listed")) === "true";
  const rank = Number(formData.get("rank"));

  const { data: created } = await sb
    .from("outreach_targets")
    .insert({
      tenant_id: profile.tenant_id,
      campaign_id: campaignId,
      media_id: mediaId,
      kind: ownListed ? "replace" : "new",
      status: media.no_solicitation ? "excluded" : "collected",
      status_reason: media.no_solicitation ? "営業お断り（台帳フラグ）" : "",
      article_url: safeUrl(String(formData.get("article_url") || "")),
      rank: Number.isFinite(rank) && rank > 0 ? rank : null,
    })
    .select("id")
    .single();

  await audit(
    sb,
    profile.tenant_id,
    profile.id,
    profile.full_name,
    "outreach_target",
    created?.id ?? null,
    "created_from_board",
    `media:${media.domain}`
  );
  revalidatePath("/board");
  revalidatePath(`/campaigns/${campaignId}`);
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

function htmlToText(html: string, limit = 15000): string {
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
    .slice(0, limit);
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

/* ============ Step 2: ドラフト確定 → 案件・KW作成（＋収集ジョブ登録） ============ */

export type RunnableJob = { job_id: string; keyword_id: string; keyword: string };

export type CreateFromDraftResult =
  | { ok: true; campaign_id: string; jobs: RunnableJob[] }
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

  // キーワードごとに収集ジョブ（pending）を登録する。進捗はウィザードを閉じても /start に残る
  const { data: jobRows } = await sb
    .from("collection_jobs")
    .insert(
      (kwRows ?? []).map((k) => ({
        tenant_id: profile.tenant_id,
        campaign_id: camp.id,
        keyword_id: k.id,
        status: "pending",
        source: "ai_web_search",
      }))
    )
    .select("id, keyword_id");
  const jobByKw = new Map((jobRows ?? []).map((j) => [j.keyword_id, j.id]));

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
  revalidatePath("/start");

  return {
    ok: true,
    campaign_id: camp.id,
    jobs: (kwRows ?? [])
      .filter((k) => jobByKw.has(k.id))
      .map((k) => ({ job_id: jobByKw.get(k.id) as string, keyword_id: k.id, keyword: k.keyword })),
  };
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
  | { ok: true; job_id: string; snapshot_id: string; found: number; ranking_articles: number; media_new: number }
  | { ok: false; error: string };

/** running のまま5分を超えたジョブは中断とみなして引き継ぐ */
const STALE_RUNNING_MS = 5 * 60 * 1000;

function isFreshRunning(job: { status: string; started_at: string | null }): boolean {
  return (
    job.status === "running" &&
    !!job.started_at &&
    Date.now() - new Date(job.started_at).getTime() < STALE_RUNNING_MS
  );
}

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

export async function collectKeywordAuto(jobId: string): Promise<CollectAutoResult> {
  const { sb, profile } = await ctx();

  if (!hasAnthropic()) {
    return { ok: false, error: "ANTHROPIC_API_KEY が未設定です。/collect の貼り付け方式をご利用ください。" };
  }

  let { data: job } = await sb.from("collection_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "収集ジョブが見つかりません。" };

  // 二重実行ガード：running かつ開始から5分以内なら実行しない（5分超は中断とみなして引き継ぐ）
  if (isFreshRunning(job)) {
    return { ok: false, error: "実行中です。しばらく待ってから画面を更新してください。" };
  }

  // done ジョブの再実行（定点観測）は履歴を残すため、新しいジョブ行を作ってそちらを実行する
  if (job.status === "done") {
    const { data: newJob } = await sb
      .from("collection_jobs")
      .insert({
        tenant_id: profile.tenant_id,
        campaign_id: job.campaign_id,
        keyword_id: job.keyword_id,
        status: "pending",
        source: "ai_web_search",
      })
      .select("*")
      .single();
    if (!newJob) return { ok: false, error: "再収集ジョブの作成に失敗しました。" };
    job = newJob;
  }

  const campaignId: string = job.campaign_id;
  const keywordId: string = job.keyword_id;

  await sb
    .from("collection_jobs")
    .update({ status: "running", started_at: new Date().toISOString(), error_detail: "", finished_at: null })
    .eq("id", job.id);
  revalidatePath("/start");

  const fail = async (error: string): Promise<CollectAutoResult> => {
    await sb
      .from("collection_jobs")
      .update({ status: "error", error_detail: error.slice(0, 500), finished_at: new Date().toISOString() })
      .eq("id", job.id);
    revalidatePath("/start");
    return { ok: false, error };
  };

  const { data: camp } = await sb.from("campaigns").select("*").eq("id", campaignId).single();
  const { data: kw } = await sb.from("keywords").select("*").eq("id", keywordId).maybeSingle();
  if (!camp || !kw) return fail("案件またはキーワードが見つかりません。");

  const productName = camp.product_name || camp.name || "";

  const prompt = `日本語のWebを検索して、検索キーワード「${kw.keyword}」の検索上位に出てくる「ランキング／比較／おすすめ」形式の記事・サイトを特定してください。
- 対象: 複数のサービス・商品を順位付け・比較して紹介している第三者メディアの記事
- 除外: サービス公式サイト・公式LP、ECモールの商品ページ、単なるニュース記事、SNS
- 最大12件
- own_listed = 対象商材「${productName}」（訴求: ${camp.selling_points || "—"}）がその記事内に掲載されているか
- listed_services = 記事内に掲載されている商品・サービス名。次のルールに厳密に従うこと:
  - 記事に明確な順位付きランキングがある場合: position を 1..N として上位から最大10件
  - 順位のないリスト・言及のみの場合: 特定できる商品・サービス名をすべて（最大15件）、position はすべて null
  - 商品・サービス名を特定できない場合: 空配列 [] を返す
  - 「情報不足のため特定不可」「不明」などのプレースホルダ文字列を name に入れてはならない（実在の商品・サービス名のみ）

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
      return fail("このAPIキーではWeb検索ツールが利用できないようです。/collect の貼り付け方式をご利用ください。");
    }
    return fail(`自動検索に失敗しました（${msg.slice(0, 200)}）。/collect の貼り付け方式もご利用いただけます。`);
  }

  if (!sites.length) {
    return fail("検索結果からランキング/比較記事を特定できませんでした。/collect の貼り付け方式をお試しください。");
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
  if (!snap) return fail("スナップショットの作成に失敗しました。");

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
        r.listed_services.slice(0, 15).map((c) => ({
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

  await sb
    .from("collection_jobs")
    .update({
      status: "done",
      found_count: sites.length,
      ranking_count: rankingArticles,
      media_new: mediaNew,
      snapshot_id: snap.id,
      finished_at: new Date().toISOString(),
    })
    .eq("id", job.id);

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
  revalidatePath("/start");
  revalidatePath(`/campaigns/${campaignId}`);

  return { ok: true, job_id: job.id, snapshot_id: snap.id, found: sites.length, ranking_articles: rankingArticles, media_new: mediaNew };
}

/* ============ 収集ジョブの再開・再収集・個別作成 ============ */

export type StartJobsResult = { ok: true; jobs: RunnableJob[] } | { ok: false; error: string };

/**
 * 案件の収集ジョブをまとめて用意する。
 * mode "resume": 未実行（pending／ジョブなし）・失敗（error）・中断（stale running）だけを対象にする
 * mode "all"   : 加えて、完了済みキーワードにも新しいジョブを作って全KWを再収集する（定点観測）
 * 実行そのものはクライアントが collectKeywordAuto を1件ずつ呼ぶ。
 */
export async function startCollectionForCampaign(
  campaignId: string,
  mode: "resume" | "all" = "resume"
): Promise<StartJobsResult> {
  const { sb, profile } = await ctx();

  const { data: kws } = await sb
    .from("keywords")
    .select("id, keyword")
    .eq("campaign_id", campaignId)
    .order("created_at");
  if (!kws?.length) return { ok: false, error: "この案件にはキーワードがありません。" };

  const { data: jobs } = await sb
    .from("collection_jobs")
    .select("id, keyword_id, status, started_at, created_at")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });

  const latest = new Map<string, { id: string; status: string; started_at: string | null }>();
  for (const j of jobs ?? []) if (!latest.has(j.keyword_id)) latest.set(j.keyword_id, j);

  const runnable: RunnableJob[] = [];
  const toCreate: { id: string; keyword: string }[] = [];

  for (const k of kws) {
    const j = latest.get(k.id);
    if (!j) {
      toCreate.push(k);
      continue;
    }
    if (j.status === "pending" || j.status === "error") {
      runnable.push({ job_id: j.id, keyword_id: k.id, keyword: k.keyword });
      continue;
    }
    if (j.status === "running") {
      // 5分超の running は中断とみなして引き継ぐ（実行時ガードは collectKeywordAuto 側にもある）
      if (!isFreshRunning(j)) runnable.push({ job_id: j.id, keyword_id: k.id, keyword: k.keyword });
      continue;
    }
    if (j.status === "done" && mode === "all") toCreate.push(k);
  }

  if (toCreate.length) {
    const { data: created } = await sb
      .from("collection_jobs")
      .insert(
        toCreate.map((k) => ({
          tenant_id: profile.tenant_id,
          campaign_id: campaignId,
          keyword_id: k.id,
          status: "pending",
          source: "ai_web_search",
        }))
      )
      .select("id, keyword_id");
    const kwName = new Map(kws.map((k) => [k.id, k.keyword]));
    for (const j of created ?? [])
      runnable.push({ job_id: j.id, keyword_id: j.keyword_id, keyword: kwName.get(j.keyword_id) ?? "" });
  }

  // キーワードの登録順に実行する
  const order = new Map(kws.map((k, i) => [k.id, i]));
  runnable.sort((a, b) => (order.get(a.keyword_id) ?? 0) - (order.get(b.keyword_id) ?? 0));

  revalidatePath("/start");
  return { ok: true, jobs: runnable };
}

/* ============ 第2段階：記事本文の読取（掲載枠の抽出） ============ */

export type EnrichResult =
  | { ok: true; found: number; own_listed: boolean }
  | { ok: false; error: string };

type EnrichedBody = {
  is_ranking_article: boolean;
  listed_services: { position: number | null; name: string }[];
  own_listed: boolean;
  own_position: number | null;
};

/**
 * 記事本文をサーバー側で取得し、掲載枠（記事内の商品・サービスと順位）を本文から抽出して保存する。
 * Web検索（SERPスニペット）だけでは読めない比較表・ランキング表を補完する第2段階。
 * 既存の article_listings は置き換える。取得失敗時は既存データに触れない。
 */
export async function enrichArticleListings(serpEntryId: string): Promise<EnrichResult> {
  const { sb, profile } = await ctx();

  if (!hasAnthropic()) {
    return { ok: false, error: "ANTHROPIC_API_KEY が未設定です。" };
  }

  const { data: entry } = await sb
    .from("serp_entries")
    .select(
      "*, snapshot:serp_snapshots(id, keyword:keywords(id, keyword, campaign_id, campaign:campaigns(id, name, product_name, selling_points)))"
    )
    .eq("id", serpEntryId)
    .maybeSingle();
  if (!entry) return { ok: false, error: "記事エントリが見つかりません。" };
  if (!entry.article_url) return { ok: false, error: "記事URLがありません。" };

  const snapObj = entry.snapshot as unknown as {
    keyword?: {
      keyword: string;
      campaign_id: string;
      campaign?: { id: string; name: string; product_name: string; selling_points: string } | null;
    } | null;
  } | null;
  const camp = snapObj?.keyword?.campaign;
  const campaignId = snapObj?.keyword?.campaign_id ?? "";
  const productName = camp?.product_name || camp?.name || "";

  // --- 記事本文の取得（比較表は中盤以降にあることが多いので 30,000 文字まで読む） ---
  let bodyText = "";
  try {
    const res = await fetch(entry.article_url, {
      signal: AbortSignal.timeout(12_000),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "accept-language": "ja,en;q=0.8",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return { ok: false, error: `本文取得不可(${res.status})` };
    const html = await res.text();
    bodyText = htmlToText(html, 30_000);
  } catch {
    return { ok: false, error: "本文取得不可(タイムアウト等)" };
  }
  if (!bodyText) return { ok: false, error: "本文取得不可(本文なし)" };

  // --- 本文から掲載枠を抽出 ---
  const out = await askJson<EnrichedBody>(
    `あなたは日本のアフィリエイト広告代理店のリサーチ担当です。記事本文から「掲載枠」（記事内で紹介されている商品・サービスとその順位）を抽出します。
ルール（厳守）:
- 記事に明確な順位付きランキングがある場合: listed_services の position を 1..N として上位から最大20件
- 順位のない比較表・リスト（「おすすめ15選」等）の場合: 特定できる商品・サービス名をすべて記事内の登場順で最大20件、position はすべて null
- 商品・サービス名を特定できない場合: listed_services は空配列 []
- 「情報不足のため特定不可」「不明」などのプレースホルダ文字列を name に入れてはならない（実在の商品・サービス名のみ）
- is_ranking_article = この記事が複数の商品・サービスを紹介・比較するランキング/比較/おすすめ記事かどうか
- own_listed = 対象商材「${productName}」が掲載商品として記事内に含まれるか。含まれる場合、順位が分かれば own_position（無ければ null）`,
    `対象商材: ${productName}（訴求: ${camp?.selling_points || "—"}）
記事タイトル: ${entry.article_title || "—"}
記事URL: ${entry.article_url}

記事本文（抽出テキスト）:
---
${bodyText}
---

出力形式（STRICT JSON のみ）:
{"is_ranking_article":true,"listed_services":[{"position":1,"name":"..."}],"own_listed":false,"own_position":null}`,
    4000
  );
  if (!out || !Array.isArray(out.listed_services)) {
    return { ok: false, error: "本文の解析に失敗しました。" };
  }

  const prod = String(productName).trim();
  const isOwnName = (name: string) => !!prod && !!name && (name.includes(prod) || prod.includes(name));

  const services = out.listed_services
    .map((s) => ({
      position: s?.position != null && Number(s.position) > 0 ? Number(s.position) : null,
      name: String(s?.name || "").trim(),
    }))
    .filter((s) => s.name)
    .slice(0, 20);

  // --- 置き換え保存 ---
  await sb.from("article_listings").delete().eq("serp_entry_id", entry.id);
  if (services.length) {
    await sb.from("article_listings").insert(
      services.map((s) => ({
        tenant_id: profile.tenant_id,
        serp_entry_id: entry.id,
        position: s.position,
        service_name: s.name,
        is_own: isOwnName(s.name),
      }))
    );
  }

  const ownListed = !!out.own_listed;
  const today = new Date().toISOString().slice(0, 10);
  const baseReason = String(entry.judge_reason || "")
    .replace(/／?本文読取済\(\d{4}-\d{2}-\d{2}\)/g, "")
    .trim();
  const judgeReason = `${baseReason ? `${baseReason}／` : ""}本文読取済(${today})`.slice(0, 500);

  await sb
    .from("serp_entries")
    .update({
      is_ranking_article: !!out.is_ranking_article,
      own_listed: ownListed,
      own_rank_in_article: out.own_position ?? null,
      judge_reason: judgeReason,
    })
    .eq("id", entry.id);

  // --- 打診対象（campaign×media）の kind を同期（new/replace の判定は収集時と同じ） ---
  if (campaignId && entry.media_id) {
    const { data: target } = await sb
      .from("outreach_targets")
      .select("id, kind")
      .eq("campaign_id", campaignId)
      .eq("media_id", entry.media_id)
      .maybeSingle();
    if (target) {
      const kind = ownListed ? "replace" : "new";
      if (target.kind !== kind) {
        await sb
          .from("outreach_targets")
          .update({ kind, updated_at: new Date().toISOString() })
          .eq("id", target.id);
      }
    }
  }

  await audit(
    sb,
    profile.tenant_id,
    profile.id,
    profile.full_name,
    "serp_entry",
    entry.id,
    "enriched",
    `本文読取 掲載枠${services.length}件 / own:${ownListed ? "掲載" : "未掲載"}`
  );
  revalidatePath("/board");
  if (campaignId) revalidatePath(`/campaigns/${campaignId}`);

  return { ok: true, found: services.length, own_listed: ownListed };
}

export type EnrichableEntry = { entry_id: string; title: string };

/** スナップショット内の本文読取対象（ランキング/比較記事）を検索順位順に返す */
export async function listEnrichableEntries(
  snapshotId: string
): Promise<{ ok: true; entries: EnrichableEntry[] } | { ok: false; error: string }> {
  const { sb } = await ctx();
  const { data, error } = await sb
    .from("serp_entries")
    .select("id, article_title, article_url, rank, is_ranking_article")
    .eq("snapshot_id", snapshotId)
    .order("rank", { ascending: true, nullsFirst: false });
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    entries: (data ?? [])
      .filter((e) => e.article_url && e.is_ranking_article)
      .map((e) => ({ entry_id: e.id, title: e.article_title || e.article_url })),
  };
}

/** キーワード1件に実行可能なジョブを用意する（既存の pending/error/stale running があればそれを返す） */
export async function createCollectionJob(
  campaignId: string,
  keywordId: string
): Promise<{ ok: true; job: RunnableJob } | { ok: false; error: string }> {
  const { sb, profile } = await ctx();

  const { data: kw } = await sb.from("keywords").select("id, keyword").eq("id", keywordId).maybeSingle();
  if (!kw) return { ok: false, error: "キーワードが見つかりません。" };

  const { data: jobs } = await sb
    .from("collection_jobs")
    .select("id, status, started_at")
    .eq("keyword_id", keywordId)
    .order("created_at", { ascending: false })
    .limit(1);
  const j = jobs?.[0];
  if (j) {
    if (isFreshRunning(j)) return { ok: false, error: "実行中です。しばらく待ってから画面を更新してください。" };
    if (j.status === "pending" || j.status === "error" || j.status === "running") {
      return { ok: true, job: { job_id: j.id, keyword_id: kw.id, keyword: kw.keyword } };
    }
  }

  const { data: newJob } = await sb
    .from("collection_jobs")
    .insert({
      tenant_id: profile.tenant_id,
      campaign_id: campaignId,
      keyword_id: keywordId,
      status: "pending",
      source: "ai_web_search",
    })
    .select("id")
    .single();
  if (!newJob) return { ok: false, error: "収集ジョブの作成に失敗しました。" };
  revalidatePath("/start");
  return { ok: true, job: { job_id: newJob.id, keyword_id: kw.id, keyword: kw.keyword } };
}
