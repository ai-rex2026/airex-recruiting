"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { askJson, hasAnthropic } from "@/lib/anthropic";
import {
  runCollectJob,
  runEnrichEntry,
  listEnrichable,
  isFreshRunning,
  audit,
  type CollectAutoResult,
  type EnrichResult,
  type EnrichableEntry,
} from "@/lib/collect-core";
import { safeUrl } from "@/lib/domain";

/**
 * 「かんたん開始」ウィザード用のサーバーアクション。
 * 商品URL / 商品テキスト → AIが案件・KWを提案 → 案件作成 → Claude の Web検索ツールで自動収集。
 * 収集まで（打診対象の確定・送信は人の承認が必要。自動送信はしない）。
 */

async function ctx() {
  const { sb, user, profile } = await getSessionProfile();
  if (!user || !profile) redirect("/login");
  return { sb, user: user!, profile: profile! };
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
      genre: String(formData.get("genre") || ""),
      reference_url: safeUrl(String(formData.get("reference_url") || "")),
      draft_url: safeUrl(String(formData.get("draft_url") || "")),
      brief: String(formData.get("brief") || ""),
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
  /** 資料から作った場合のみ埋まる（LPからは読み取れない取引条件・ターゲット定義） */
  genre?: string;
  lp_url?: string;
  reference_url?: string;
  draft_url?: string;
  unit_price?: string;
  approval_terms?: string;
  brief?: string;
  document_id?: string;
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
  genre?: string;
  lp_url?: string;
  reference_url?: string;
  draft_url?: string;
  unit_price?: string;
  approval_terms?: string;
  brief?: string;
  /** 資料から作った場合、その資料をこの案件に紐づける */
  document_id?: string;
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
      lp_url: safeUrl(String(payload.lp_url || payload.input_url || "")),
      unit_price: String(payload.unit_price || ""),
      conversion_point: String(payload.conversion_point || ""),
      approval_terms: String(payload.approval_terms || ""),
      selling_points: String(payload.selling_points || ""),
      genre: String(payload.genre || ""),
      reference_url: safeUrl(String(payload.reference_url || "")),
      draft_url: safeUrl(String(payload.draft_url || "")),
      brief: String(payload.brief || ""),
    })
    .select("id")
    .single();
  if (campErr || !camp) return { ok: false, error: `案件の作成に失敗しました：${campErr?.message ?? "不明なエラー"}` };

  // 資料から作った場合、その資料をこの案件に紐づけて証跡として残す
  if (payload.document_id) {
    await sb.from("documents").update({ campaign_id: camp.id }).eq("id", payload.document_id);
  }

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
/* 中核は lib/collect-core.ts。画面（ここ）と cron ワーカーで同じ処理を共有する */

export async function collectKeywordAuto(jobId: string): Promise<CollectAutoResult> {
  const { sb, profile } = await ctx();
  return runCollectJob(sb, profile, jobId);
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
      // 3分超の running は中断とみなして引き継ぐ（実行時ガードは collectKeywordAuto 側にもある）
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

export async function enrichArticleListings(serpEntryId: string): Promise<EnrichResult> {
  const { sb, profile } = await ctx();
  return runEnrichEntry(sb, profile, serpEntryId);
}

export async function listEnrichableEntries(
  snapshotId: string
): Promise<{ ok: true; entries: EnrichableEntry[] } | { ok: false; error: string }> {
  const { sb } = await ctx();
  return listEnrichable(sb, snapshotId);
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
