import { revalidatePath } from "next/cache";
import Anthropic from "@anthropic-ai/sdk";
import type { createClient } from "@/lib/supabase/server";
import { askJson, hasAnthropic, MODEL_FAST, type AiUsage } from "@/lib/anthropic";
import { meterTo } from "@/lib/usage";
import { normalizeDomain, safeUrl } from "@/lib/domain";
import { hasDataForSeo, fetchSerp, type SerpItem } from "@/lib/dataforseo";

/**
 * 収集の中核。ブラウザのセッションに依存させないため、実行者（テナント・ユーザー）を引数で受け取る。
 * 画面から呼ぶサーバーアクション（start-actions.ts）と、cron から呼ぶワーカー（/api/cron/collect）が
 * どちらもここを使う。"use server" のファイルに置くとクライアントから直接呼べてしまうので分離している。
 */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

function anthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

export type SB = Awaited<ReturnType<typeof createClient>>;

/** 実行者。画面からならログイン中のプロフィール、cron からならワーカーアカウント */
export type Actor = { id: string; tenant_id: string; full_name?: string };

/** HTMLをざっくり本文テキストにする（記事本文の読取で使う） */
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

export async function audit(
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

type FoundSite = {
  /** paid = スポンサー広告（赤枠） / organic = オーガニック検索（青枠） */
  result_type: "paid" | "organic";
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
  | { ok: true; job_id: string; snapshot_id: string; found: number; ranking_articles: number; paid: number; media_new: number }
  | { ok: false; error: string };

/**
 * SERP_REQUIRE_GOOGLE=1 のとき、Google以外の経路では収集しない。
 * Claudeの検索とGoogleでは上位に出るサイト自体が変わるため、「順位」の意味が変わってしまう。
 * 誤ったデータが積み上がるより、収集が失敗して気づけるほうがよい運用のための締め切り弁。
 */
const requireGoogle = () => process.env.SERP_REQUIRE_GOOGLE === "1";

/** running のまま3分を超えたジョブは中断とみなして引き継ぐ */
const STALE_RUNNING_MS = 3 * 60 * 1000;

export function isFreshRunning(job: { status: string; started_at: string | null }): boolean {
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

/**
 * DataForSEO の SERP（スポンサー広告＋オーガニック）を、ランキング/比較記事かどうかで仕分ける。
 * 掲載枠（記事内の商品と順位）はタイトル・説明文からは正確に読めないので、ここでは判定だけ行い、
 * 中身は第2段階の本文読取（runEnrichEntry）に任せる。
 * AI の応答を解析できなければ空配列を返し、呼び出し側は Web検索へフォールバックする。
 */
async function judgeSerpItems(
  camp: { product_name?: string; name?: string; selling_points?: string },
  keyword: string,
  items: SerpItem[],
  meter?: (u: AiUsage) => Promise<void> | void
): Promise<FoundSite[]> {
  const productName = camp.product_name || camp.name || "";
  const list = items.slice(0, 30);
  const table = list
    .map(
      (it, i) =>
        `${i}\t${it.result_type === "paid" ? "スポンサー広告" : "オーガニック"}${it.rank}位\t${it.title}\t${it.url}\t${it.description.slice(0, 200)}`
    )
    .join("\n");

  const out = await askJson<{
    results: { index: number; is_ranking_article: boolean; site_name: string; reason: string; own_listed: boolean }[];
  }>(
    `あなたは日本のアフィリエイト広告代理店のリサーチ担当です。Google の検索結果（スポンサー広告枠とオーガニック枠の両方）を1件ずつ見て、「ランキング/比較記事（アフィリエイトメディア）」かどうかを判定します。
判定基準:
- ランキング/比較記事 = 複数のサービス・商品を順位付け・比較して紹介している第三者メディアの記事
- 該当しない例: サービス公式サイト・公式LP、ニュース記事、SNS、ECモール、口コミ投稿単体、予約ポータルの検索結果ページ
- スポンサー広告枠であっても、遷移先がランキング/比較記事なら is_ranking_article = true とする（広告出稿しているランキングサイトは打診対象になる）
- own_listed はタイトル・説明文から読み取れる範囲で判定し、確証がなければ false`,
    `対象商材: ${productName}（訴求: ${camp.selling_points || "—"}）
検索キーワード: ${keyword}

以下は検索結果です（列: 通し番号 / 枠と順位 / タイトル / URL / 説明文）。
---
${table}
---

各行について、通し番号 index を必ず添えて出力してください。
出力形式（STRICT JSON のみ）:
{"results":[{"index":0,"is_ranking_article":true,"site_name":"サイト名","reason":"判定理由を20字程度で","own_listed":false}]}`,
    { maxTokens: 8000, model: MODEL_FAST, meter }
  );

  if (!out?.results?.length) return [];

  const byIndex = new Map(out.results.map((r) => [Number(r?.index), r]));
  return list.map((it, i) => {
    const j = byIndex.get(i);
    return {
      result_type: it.result_type,
      rank: it.rank,
      title: it.title,
      url: it.url,
      site_name: j?.site_name || it.domain,
      is_ranking_article: !!j?.is_ranking_article,
      reason: j?.reason || "AI未判定",
      listed_services: [],
      own_listed: !!j?.own_listed,
      own_position: null,
    };
  });
}

/**
 * フォールバックの収集経路：Claude の Web検索ツールで検索上位のランキング/比較記事を探す。
 * Google の広告枠（スポンサー広告）は返らないため、この経路の結果はすべて organic 扱いになる。
 */
async function searchViaWebSearchTool(
  camp: { selling_points?: string },
  keyword: string,
  productName: string,
  meter?: (u: AiUsage) => Promise<void> | void
): Promise<{ ok: true; sites: FoundSite[] } | { ok: false; error: string }> {
  const prompt = `日本語のWebを検索して、検索キーワード「${keyword}」の検索上位に出てくる「ランキング／比較／おすすめ」形式の記事・サイトを特定してください。
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

  try {
    const anthropic = anthropicClient();
    // ウォッチドッグ：Web検索が長引いてもアクションが黙って死なないよう、約120秒で打ち切って
    // ジョブに error を記録する（Vercel の maxDuration=180 秒より手前で確実に着地させる）。
    const WATCHDOG_MS = 120 * 1000;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error("COLLECT_WATCHDOG_TIMEOUT")), WATCHDOG_MS);
    });
    let res;
    try {
      res = await Promise.race([
        anthropic.messages.create({
          model: MODEL,
          max_tokens: 4000,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 3,
              // サーバーのリージョンに関わらず、日本ロケーションとして検索を安定させる
              user_location: { type: "approximate", country: "JP", city: "Tokyo", timezone: "Asia/Tokyo" },
            },
          ],
          messages: [{ role: "user", content: prompt }],
        }),
        watchdog,
      ]);
    } finally {
      clearTimeout(watchdogTimer);
    }
    // Web検索はトークンとは別に1検索ごとの従量課金があるので、実行回数も数えて記録する
    await meter?.({
      model: MODEL,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      web_searches: res.content.filter((b) => (b as { type: string }).type === "server_tool_use").length,
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const parsed = extractLastJsonBlock<{ sites: Omit<FoundSite, "result_type">[] }>(text, '"sites"');
    const sites = (parsed?.sites ?? [])
      .slice(0, 12)
      .map((x) => ({ ...x, result_type: "organic" as const }));
    return { ok: true, sites };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("COLLECT_WATCHDOG_TIMEOUT")) {
      return { ok: false, error: "検索がタイムアウトしました。再収集してください。" };
    }
    if (/web_search|tool|not[_\s]?(available|enabled|supported)|permission/i.test(msg)) {
      return {
        ok: false,
        error: "このAPIキーではWeb検索ツールが利用できないようです。案件情報・KWタブの貼り付け収集をご利用ください。",
      };
    }
    return {
      ok: false,
      error: `自動検索に失敗しました（${msg.slice(0, 200)}）。再収集で再試行するか、案件情報・KWタブの貼り付け収集をお試しください。`,
    };
  }
}

export async function runCollectJob(
  sb: SB,
  profile: Actor,
  jobId: string
): Promise<CollectAutoResult> {

  if (!hasAnthropic()) {
    return { ok: false, error: "ANTHROPIC_API_KEY が未設定です。案件情報・KWタブの貼り付け収集をご利用ください。" };
  }

  let { data: job } = await sb.from("collection_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "収集ジョブが見つかりません。" };

  // 二重実行ガード：running かつ開始から3分以内なら実行しない（3分超は中断とみなして引き継ぐ）
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
  const scope = { tenantId: profile.tenant_id, campaignId, keywordId } as const;
  const judgeMeter = meterTo(sb, { ...scope, kind: "collect_judge" });
  const searchMeter = meterTo(sb, { ...scope, kind: "collect_search" });

  let sites: FoundSite[] = [];
  // 収集元。DataForSEO が使えるときは Google の実SERP（スポンサー広告つき）、無ければ Claude の Web検索
  let source: "dataforseo" | "ai_web_search" = "ai_web_search";
  let serpNote = "";

  // ① DataForSEO：スポンサー広告（赤枠）とオーガニック（青枠）を分けて取得できるのはこの経路だけ
  if (hasDataForSeo()) {
    const serp = await fetchSerp(kw.keyword, 20);
    if (!serp.ok) {
      serpNote = serp.error;
    } else if (serp.items.length) {
      sites = await judgeSerpItems(camp, kw.keyword, serp.items, judgeMeter);
      if (sites.length) source = "dataforseo";
    }
    // 取得できなければ②へフォールバックする（その回だけ広告枠が拾えない）
  }

  if (!sites.length && requireGoogle()) {
    return fail(
      hasDataForSeo()
        ? `Googleの検索結果を取得できませんでした${serpNote ? `（${serpNote}）` : ""}。SERP_REQUIRE_GOOGLE=1 のため、Google以外の経路では収集しません。`
        : "Google検索の資格情報（DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD）が未設定です。SERP_REQUIRE_GOOGLE=1 のため、Google以外の経路では収集しません。"
    );
  }

  // ② フォールバック：Claude の Web検索ツール。広告枠は返らないので全件オーガニック扱い
  if (!sites.length) {
    const ws = await searchViaWebSearchTool(camp, kw.keyword, productName, searchMeter);
    if (!ws.ok) return fail(serpNote ? `${ws.error}（DataForSEO: ${serpNote}）` : ws.error);
    sites = ws.sites;
  }

  if (!sites.length) {
    return fail(
      serpNote
        ? `検索結果からランキング/比較記事を特定できませんでした（DataForSEO: ${serpNote}）。`
        : "検索結果からランキング/比較記事を特定できませんでした。再収集で再試行するか、案件情報・KWタブの貼り付け収集をお試しください。"
    );
  }

  // ===== 永続化（ingestCollection と同じ流れ）=====
  const { data: snap } = await sb
    .from("serp_snapshots")
    .insert({
      tenant_id: profile.tenant_id,
      keyword_id: keywordId,
      source,
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
  let paidCount = 0;

  for (let i = 0; i < sites.length; i++) {
    const r = sites[i];
    const url = safeUrl(String(r.url || ""));
    const domain = normalizeDomain(url);
    if (!domain) continue;
    const resultType = r.result_type === "paid" ? "paid" : "organic";
    if (resultType === "paid") paidCount++;

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
        result_type: resultType,
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
      source,
      found_count: sites.length,
      ranking_count: rankingArticles,
      paid_count: paidCount,
      media_new: mediaNew,
      snapshot_id: snap.id,
      finished_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  await audit(
    sb,
    profile.tenant_id,
    profile.id,
    profile.full_name ?? "",
    "collection",
    snap.id,
    "ingested",
    `収集（${source === "dataforseo" ? "SERP API" : "AI Web検索"}） KW:${kw.keyword} / 取得${sites.length}件（うちスポンサー広告${paidCount}件） / ランキング記事${rankingArticles}件 / 新規打診${created}件`
  );
  revalidatePath("/board");
  revalidatePath("/media");
  revalidatePath("/start");
  revalidatePath(`/campaigns/${campaignId}`);

  return {
    ok: true,
    job_id: job.id,
    snapshot_id: snap.id,
    found: sites.length,
    ranking_articles: rankingArticles,
    paid: paidCount,
    media_new: mediaNew,
  };
}

export type EnrichResult =
  | { ok: true; found: number; own_listed: boolean; reused?: boolean }
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
/**
 * 同一案件・同一記事URLの読取結果を使い回せる時間の窓。
 * 検索KWが違っても上位に出てくるランキング記事はかなり重複するため、同じ日に同じ記事を
 * 何度も取得・解析していた（実測で読取の約54%が重複）。同じ記事の同じ日なら結果は同じなので引き写す。
 */
const ENRICH_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** judge_reason に付く読取マーカー（通常・再利用の両方）を落とす */
function stripEnrichMarker(reason: string): string {
  return String(reason || "")
    .replace(/／?本文読取済\(\d{4}-\d{2}-\d{2}(?:・再利用)?\)/g, "")
    .trim();
}

/** 打診対象（campaign×media）の kind を own_listed に合わせる。読取後に通る共通処理 */
async function syncOutreachKind(
  sb: SB,
  campaignId: string,
  mediaId: string | null,
  ownListed: boolean
) {
  if (!campaignId || !mediaId) return;
  const { data: target } = await sb
    .from("outreach_targets")
    .select("id, kind")
    .eq("campaign_id", campaignId)
    .eq("media_id", mediaId)
    .maybeSingle();
  if (!target) return;
  const kind = ownListed ? "replace" : "new";
  if (target.kind === kind) return;
  await sb
    .from("outreach_targets")
    .update({ kind, updated_at: new Date().toISOString() })
    .eq("id", target.id);
}

type ReusableEntry = {
  id: string;
  is_ranking_article: boolean;
  own_listed: boolean;
  own_rank_in_article: number | null;
};

/**
 * 同じ案件の中で、同じ記事URLを直近に読み終えたエントリを探す。
 * own_listed は案件の商材名で決まるので、案件をまたいだ使い回しはしない。
 */
async function findReusableExtraction(
  sb: SB,
  campaignId: string,
  articleUrl: string,
  excludeEntryId: string
): Promise<ReusableEntry | null> {
  if (!campaignId || !articleUrl) return null;

  const { data: kws } = await sb.from("keywords").select("id").eq("campaign_id", campaignId);
  const kwIds = (kws ?? []).map((k) => k.id);
  if (!kwIds.length) return null;

  const since = new Date(Date.now() - ENRICH_REUSE_WINDOW_MS).toISOString();
  const { data: snaps } = await sb
    .from("serp_snapshots")
    .select("id")
    .in("keyword_id", kwIds)
    .gte("collected_at", since);
  const snapIds = (snaps ?? []).map((x) => x.id);
  if (!snapIds.length) return null;

  const { data: rows } = await sb
    .from("serp_entries")
    .select("id, is_ranking_article, own_listed, own_rank_in_article")
    .in("snapshot_id", snapIds)
    .eq("article_url", articleUrl)
    .neq("id", excludeEntryId)
    .not("enriched_at", "is", null)
    .order("enriched_at", { ascending: false })
    .limit(1);
  return (rows?.[0] as ReusableEntry | undefined) ?? null;
}

export async function runEnrichEntry(
  sb: SB,
  profile: Actor,
  serpEntryId: string,
  opts?: { force?: boolean }
): Promise<EnrichResult> {

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
      id: string;
      keyword: string;
      campaign_id: string;
      campaign?: { id: string; name: string; product_name: string; selling_points: string } | null;
    } | null;
  } | null;
  const camp = snapObj?.keyword?.campaign;
  const campaignId = snapObj?.keyword?.campaign_id ?? "";
  const productName = camp?.product_name || camp?.name || "";

  // --- 直近に同じ記事を読んでいれば、その結果を引き写して本文取得とAI解析を丸ごと省く ---
  // 「記事本文から読み直す」で明示的に呼ばれた時（force）は必ず読み直す
  if (!opts?.force) {
    const reusable = await findReusableExtraction(sb, campaignId, entry.article_url, entry.id);
    if (reusable) {
      const { data: srcListings } = await sb
        .from("article_listings")
        .select("position, service_name, is_own")
        .eq("serp_entry_id", reusable.id)
        .order("position", { ascending: true, nullsFirst: false });

      await sb.from("article_listings").delete().eq("serp_entry_id", entry.id);
      if (srcListings?.length) {
        await sb.from("article_listings").insert(
          srcListings.map((l) => ({
            tenant_id: profile.tenant_id,
            serp_entry_id: entry.id,
            position: l.position,
            service_name: l.service_name,
            is_own: l.is_own,
          }))
        );
      }

      const today = new Date().toISOString().slice(0, 10);
      const base = stripEnrichMarker(entry.judge_reason);
      await sb
        .from("serp_entries")
        .update({
          is_ranking_article: reusable.is_ranking_article,
          own_listed: reusable.own_listed,
          own_rank_in_article: reusable.own_rank_in_article,
          judge_reason: `${base ? `${base}／` : ""}本文読取済(${today}・再利用)`.slice(0, 500),
          enriched_at: new Date().toISOString(),
        })
        .eq("id", entry.id);

      await syncOutreachKind(sb, campaignId, entry.media_id, reusable.own_listed);
      revalidatePath("/board");
      if (campaignId) revalidatePath(`/campaigns/${campaignId}`);

      return {
        ok: true,
        found: srcListings?.length ?? 0,
        own_listed: reusable.own_listed,
        reused: true,
      };
    }
  }

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
    {
      maxTokens: 4000,
      model: MODEL_FAST,
      meter: meterTo(sb, {
        tenantId: profile.tenant_id,
        campaignId,
        keywordId: snapObj?.keyword?.id ?? null,
        kind: "enrich",
      }),
    }
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
  const baseReason = stripEnrichMarker(entry.judge_reason);
  const judgeReason = `${baseReason ? `${baseReason}／` : ""}本文読取済(${today})`.slice(0, 500);

  await sb
    .from("serp_entries")
    .update({
      is_ranking_article: !!out.is_ranking_article,
      own_listed: ownListed,
      own_rank_in_article: out.own_position ?? null,
      judge_reason: judgeReason,
      enriched_at: new Date().toISOString(),
    })
    .eq("id", entry.id);

  // --- 打診対象（campaign×media）の kind を同期（new/replace の判定は収集時と同じ） ---
  await syncOutreachKind(sb, campaignId, entry.media_id, ownListed);

  await audit(
    sb,
    profile.tenant_id,
    profile.id,
    profile.full_name ?? "",
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
export async function listEnrichable(
  sb: SB,
  snapshotId: string
): Promise<{ ok: true; entries: EnrichableEntry[] } | { ok: false; error: string }> {
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
