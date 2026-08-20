"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, getSessionProfile } from "@/lib/supabase/server";
import { askJson, askText, hasAnthropic } from "@/lib/anthropic";
import { normalizeDomain, safeUrl, BLOCKING_RESULTS } from "@/lib/domain";
import { hasDataForSeo, fetchSearchVolume, fetchKeywordIdeas } from "@/lib/dataforseo";

type SB = Awaited<ReturnType<typeof createClient>>;

async function ctx() {
  const { sb, user, profile } = await getSessionProfile();
  if (!user || !profile) redirect("/login");
  return { sb, user, profile };
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

/* ============================ auth ============================ */

export async function signIn(_prev: unknown, formData: FormData) {
  const email = String(formData.get("email") || "");
  const password = String(formData.get("password") || "");
  const sb = await createClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { error: "メールアドレスまたはパスワードが違います。" };
  redirect("/start");
}

export async function signOut() {
  const sb = await createClient();
  await sb.auth.signOut();
  redirect("/login");
}

/* ====================== clients / campaigns ====================== */

export async function createCampaign(formData: FormData) {
  const { sb, profile } = await ctx();
  const clientName = String(formData.get("client_name") || "").trim();
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
  const { data: camp } = await sb
    .from("campaigns")
    .insert({
      tenant_id: profile.tenant_id,
      client_id: clientId,
      name: String(formData.get("name") || "無題の案件"),
      product_name: String(formData.get("product_name") || ""),
      lp_url: safeUrl(String(formData.get("lp_url") || "")),
      unit_price: String(formData.get("unit_price") || ""),
      conversion_point: String(formData.get("conversion_point") || ""),
      approval_terms: String(formData.get("approval_terms") || ""),
      selling_points: String(formData.get("selling_points") || ""),
    })
    .select("id")
    .single();

  const kwRaw = String(formData.get("keywords") || "");
  if (camp && kwRaw.trim()) await insertKeywords(sb, profile.tenant_id, camp.id, kwRaw);

  if (camp)
    await audit(sb, profile.tenant_id, profile.id, profile.full_name, "campaign", camp.id, "created");
  revalidatePath("/campaigns");
  if (camp) redirect(`/campaigns/${camp.id}`);
}

/** DataForSEO で検索ボリュームを引き、keywords テーブルに入れる形にして返す（未設定なら空） */
async function volumeMap(keywords: string[]) {
  const m = new Map<
    string,
    { search_volume: number | null; cpc: number | null; competition: string; volume_source: string; volume_updated_at: string }
  >();
  if (!hasDataForSeo() || !keywords.length) return m;
  const res = await fetchSearchVolume(keywords);
  if (!res.ok) return m;
  const now = new Date().toISOString();
  for (const v of res.volumes) {
    m.set(v.keyword.toLowerCase(), {
      search_volume: v.search_volume,
      cpc: v.cpc,
      competition: v.competition,
      volume_source: "dataforseo",
      volume_updated_at: now,
    });
  }
  return m;
}

/**
 * キーワードをまとめて登録する。
 * 件数の上限は設けない（KWの数＝調査の母数そのもので、どこまで広げるかは運用側の判断）。
 * 同一案件内で既に登録済みのKWは無視し、DataForSEO が使えるときは登録と同時に検索ボリュームも引く。
 */
async function insertKeywords(sb: SB, tenantId: string, campaignId: string, raw: string): Promise<number> {
  const input = Array.from(
    new Set(
      raw
        .split(/[\n,、]/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
  if (!input.length) return 0;

  const { data: existing } = await sb.from("keywords").select("keyword").eq("campaign_id", campaignId);
  const known = new Set((existing ?? []).map((k) => String(k.keyword).toLowerCase()));
  const fresh = input.filter((k) => !known.has(k.toLowerCase()));
  if (!fresh.length) return 0;

  const volumes = await volumeMap(fresh);
  await sb.from("keywords").insert(
    fresh.map((keyword) => ({
      tenant_id: tenantId,
      campaign_id: campaignId,
      keyword,
      ...(volumes.get(keyword.toLowerCase()) ?? {}),
    }))
  );
  return fresh.length;
}

export async function addKeywords(formData: FormData) {
  const { sb, profile } = await ctx();
  const campaignId = String(formData.get("campaign_id"));
  const added = await insertKeywords(sb, profile.tenant_id, campaignId, String(formData.get("keywords") || ""));
  if (added)
    await audit(sb, profile.tenant_id, profile.id, profile.full_name, "campaign", campaignId, "keywords_added", `${added}件`);
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function deleteKeyword(formData: FormData) {
  const { sb } = await ctx();
  const id = String(formData.get("id"));
  const campaignId = String(formData.get("campaign_id"));
  await sb.from("keywords").delete().eq("id", id);
  revalidatePath(`/campaigns/${campaignId}`);
}

/* ============================ 検索ボリューム ============================ */

/** 登録済みKWの検索ボリュームをまとめて取り直す（月次で見直す想定） */
export async function refreshKeywordVolumes(formData: FormData) {
  const { sb, profile } = await ctx();
  const campaignId = String(formData.get("campaign_id"));
  if (!hasDataForSeo()) return;

  const { data: kws } = await sb.from("keywords").select("id, keyword").eq("campaign_id", campaignId);
  if (!kws?.length) return;

  const res = await fetchSearchVolume(kws.map((k) => k.keyword));
  if (!res.ok) return;

  const byKw = new Map(res.volumes.map((v) => [v.keyword.toLowerCase(), v]));
  const now = new Date().toISOString();
  let updated = 0;
  for (const k of kws) {
    const v = byKw.get(String(k.keyword).toLowerCase());
    if (!v) continue;
    await sb
      .from("keywords")
      .update({
        search_volume: v.search_volume,
        cpc: v.cpc,
        competition: v.competition,
        volume_source: "dataforseo",
        volume_updated_at: now,
      })
      .eq("id", k.id);
    updated++;
  }
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "campaign", campaignId, "kw_volume_refreshed", `${updated}件`);
  revalidatePath(`/campaigns/${campaignId}`);
}

/* ============================ KW候補の提案 ============================ */

/**
 * KW候補を出す。台帳には入れず keyword_suggestions に「候補」として積み、採用は人が選ぶ
 * （マスタの書き換えは承認制、という原則に合わせている）。
 * 候補は2系統：AI が商材から考えた語＋DataForSEO の関連キーワード（実ボリューム付き）。
 */
export async function suggestKeywordCandidates(formData: FormData) {
  const { sb, profile } = await ctx();
  const campaignId = String(formData.get("campaign_id"));
  const { data: camp } = await sb.from("campaigns").select("*").eq("id", campaignId).single();
  if (!camp) return;

  const { data: kws } = await sb.from("keywords").select("keyword").eq("campaign_id", campaignId);
  const registered = new Set((kws ?? []).map((k) => String(k.keyword).toLowerCase()));

  const candidates = new Map<string, { keyword: string; source: string; reason: string }>();

  // ① AI：商材から検索されそうな語を広めに出す
  if (hasAnthropic()) {
    const out = await askJson<{ keywords: { keyword: string; reason?: string }[] }>(
      "あなたは日本のアフィリエイト広告の運用者です。指定された商材について、ランキング/比較メディアが上位表示されやすい検索キーワードを提案します。",
      `商材: ${camp.product_name || camp.name}
ジャンル: ${camp.genre || "—"}
LP: ${camp.lp_url}
成果地点: ${camp.conversion_point}
訴求: ${camp.selling_points}
すでに登録済みのKW（重複させない）: ${(kws ?? []).map((k) => k.keyword).join(" / ") || "なし"}

この商材の掲載を狙うべき検索キーワードを日本語で30個提案してください。
「おすすめ」「比較」「ランキング」「口コミ」など比較記事が上位に来る語に加えて、地域名・悩み・価格帯などの掛け合わせも含めること。
{"keywords":[{"keyword":"...","reason":"狙う理由を15字程度で"}]} の形式で出力してください。`,
      4000
    );
    for (const k of out?.keywords ?? []) {
      const kw = String(k?.keyword || "").trim();
      if (!kw || registered.has(kw.toLowerCase())) continue;
      candidates.set(kw.toLowerCase(), { keyword: kw, source: "ai", reason: String(k?.reason || "") });
    }
  }

  // ② DataForSEO：登録済みKWをシードにした関連キーワード（検索ボリュームの大きい順）
  if (hasDataForSeo()) {
    const seeds = (kws ?? []).map((k) => k.keyword).slice(0, 20);
    if (seeds.length) {
      const ideas = await fetchKeywordIdeas(seeds, 60);
      if (ideas.ok) {
        for (const idea of ideas.ideas) {
          const key = idea.keyword.toLowerCase();
          if (registered.has(key)) continue;
          candidates.set(key, { keyword: idea.keyword, source: "dataforseo", reason: "関連キーワード" });
        }
      }
    }
  }

  if (!candidates.size) return;

  // 候補の検索ボリュームを引いて、大きい順に並べられるようにする
  const list = [...candidates.values()];
  const volumes = await volumeMap(list.map((c) => c.keyword));

  await sb.from("keyword_suggestions").upsert(
    list.map((c) => {
      const v = volumes.get(c.keyword.toLowerCase());
      return {
        tenant_id: profile.tenant_id,
        campaign_id: campaignId,
        keyword: c.keyword,
        search_volume: v?.search_volume ?? null,
        cpc: v?.cpc ?? null,
        competition: v?.competition ?? "",
        source: c.source,
        reason: c.reason,
        status: "suggested",
      };
    }),
    { onConflict: "campaign_id,keyword", ignoreDuplicates: true }
  );

  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "campaign", campaignId, "kw_suggested", `${list.length}件`);
  revalidatePath(`/campaigns/${campaignId}`);
}

/** 候補から選んだKWを実際の収集対象（keywords）に採用する */
export async function adoptKeywordSuggestions(formData: FormData) {
  const { sb, profile } = await ctx();
  const campaignId = String(formData.get("campaign_id"));
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  if (!ids.length) return;

  const { data: rows } = await sb
    .from("keyword_suggestions")
    .select("id, keyword, search_volume, cpc, competition")
    .eq("campaign_id", campaignId)
    .in("id", ids);
  if (!rows?.length) return;

  const { data: existing } = await sb.from("keywords").select("keyword").eq("campaign_id", campaignId);
  const known = new Set((existing ?? []).map((k) => String(k.keyword).toLowerCase()));
  const fresh = rows.filter((r) => !known.has(String(r.keyword).toLowerCase()));

  if (fresh.length) {
    const now = new Date().toISOString();
    await sb.from("keywords").insert(
      fresh.map((r) => ({
        tenant_id: profile.tenant_id,
        campaign_id: campaignId,
        keyword: r.keyword,
        search_volume: r.search_volume,
        cpc: r.cpc,
        competition: r.competition ?? "",
        volume_source: r.search_volume == null ? "" : "dataforseo",
        volume_updated_at: r.search_volume == null ? null : now,
      }))
    );
  }
  await sb.from("keyword_suggestions").update({ status: "adopted" }).in("id", ids);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "campaign", campaignId, "kw_adopted", `${fresh.length}件`);
  revalidatePath(`/campaigns/${campaignId}`);
}

/** 採用しない候補を伏せる（次回の提案でも再表示しない） */
export async function dismissKeywordSuggestions(formData: FormData) {
  const { sb } = await ctx();
  const campaignId = String(formData.get("campaign_id"));
  const ids = formData.getAll("ids").map(String).filter(Boolean);
  if (!ids.length) return;
  await sb.from("keyword_suggestions").update({ status: "dismissed" }).in("id", ids);
  revalidatePath(`/campaigns/${campaignId}`);
}

export async function duplicateCampaign(formData: FormData) {
  const { sb, profile } = await ctx();
  const id = String(formData.get("id"));
  const { data: c } = await sb.from("campaigns").select("*").eq("id", id).single();
  if (!c) return;
  const { data: kws } = await sb.from("keywords").select("keyword").eq("campaign_id", id);
  const { data: n } = await sb
    .from("campaigns")
    .insert({
      tenant_id: profile.tenant_id,
      client_id: c.client_id,
      name: `${c.name}（複製）`,
      product_name: c.product_name,
      lp_url: c.lp_url,
      unit_price: c.unit_price,
      conversion_point: c.conversion_point,
      approval_terms: c.approval_terms,
      selling_points: c.selling_points,
    })
    .select("id")
    .single();
  if (n && kws?.length)
    await sb.from("keywords").insert(
      kws.map((k) => ({ tenant_id: profile.tenant_id, campaign_id: n.id, keyword: k.keyword }))
    );
  revalidatePath("/campaigns");
  if (n) redirect(`/campaigns/${n.id}`);
}

/* ============================ 収集（F2） ============================ */

type AnalyzedRow = {
  url: string;
  title?: string;
  rank?: number;
  /** paid = スポンサー広告（赤枠） / organic = オーガニック検索（青枠） */
  result_type?: "paid" | "organic";
  is_ranking_article: boolean;
  reason: string;
  media_name?: string;
  own_listed: boolean;
  own_position?: number | null;
  competitors: { position: number; service_name: string }[];
};

export async function ingestCollection(formData: FormData) {
  const { sb, profile } = await ctx();
  const campaignId = String(formData.get("campaign_id"));
  const keywordId = String(formData.get("keyword_id"));
  const pasted = String(formData.get("pasted") || "");

  const { data: camp } = await sb.from("campaigns").select("*").eq("id", campaignId).single();
  const { data: kw } = await sb.from("keywords").select("*").eq("id", keywordId).maybeSingle();
  if (!camp || !kw) return;

  const lines = pasted
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 60);
  if (!lines.length) return;

  let rows: AnalyzedRow[] = [];
  if (hasAnthropic()) {
    const out = await askJson<{ results: AnalyzedRow[] }>(
      `あなたは日本のアフィリエイト広告代理店のリサーチ担当です。検索結果の行（順位・タイトル・URL がタブ/カンマ/スペースで混在した貼り付け）を解析し、各行が「ランキング/比較記事（アフィリエイトメディア）」かどうかを判定します。
判定基準:
- ランキング/比較記事 = 複数のサービスを順位付け・比較して紹介している第三者メディアの記事
- 該当しない例: サービス公式サイト、公式LP、ニュース記事、SNS、ECモール、口コミ投稿単体
自社案件が記事内に掲載されているかどうかは、タイトル等から推測できる範囲で判定し、確証がなければ own_listed=false とする。
competitors はタイトルから読み取れる範囲でよい（不明なら空配列）。
result_type は検索結果の枠の種別で、"スポンサー" "広告" "Sponsored" "Ad" などの表示を伴う行、または「スポンサー広告」ブロックの中にある行を "paid"、通常の検索結果を "organic" とする。判断できなければ "organic"。`,
      `対象案件: ${camp.product_name || camp.name}（${camp.selling_points}）
検索キーワード: ${kw.keyword}

以下の各行を解析してください。
---
${lines.join("\n")}
---

出力形式:
{"results":[{"url":"https://...","title":"...","rank":1,"result_type":"organic","is_ranking_article":true,"reason":"判定理由を20字程度で","media_name":"サイト名","own_listed":false,"own_position":null,"competitors":[{"position":1,"service_name":"..."}]}]}`,
      8000
    );
    rows = out?.results ?? [];
  }

  // AI が使えない/失敗した場合は URL だけ拾ってフォールバック
  if (!rows.length) {
    rows = lines
      .map((l) => {
        const m = l.match(/https?:\/\/\S+/);
        if (!m) return null;
        return {
          url: m[0],
          title: l.replace(m[0], "").trim(),
          is_ranking_article: true,
          reason: "AI未判定（手動確認が必要）",
          own_listed: false,
          competitors: [],
        } as AnalyzedRow;
      })
      .filter(Boolean) as AnalyzedRow[];
  }
  if (!rows.length) return;

  const { data: snap } = await sb
    .from("serp_snapshots")
    .insert({
      tenant_id: profile.tenant_id,
      keyword_id: keywordId,
      source: "manual",
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (!snap) return;

  const { data: aspRows } = await sb
    .from("asp_master")
    .select("domain, asp_name")
    .eq("tenant_id", profile.tenant_id);
  const aspMap = new Map((aspRows ?? []).map((a) => [a.domain, a.asp_name]));

  let created = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const url = safeUrl(r.url || "");
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
          name: r.media_name || domain,
          asp_type: asp ? "asp" : "direct",
          asp_name: asp || "",
        })
        .select("*")
        .single();
      media = inserted;
    }
    if (!media) continue;

    const { data: entry } = await sb
      .from("serp_entries")
      .insert({
        tenant_id: profile.tenant_id,
        snapshot_id: snap.id,
        media_id: media.id,
        rank: r.rank ?? i + 1,
        result_type: r.result_type === "paid" ? "paid" : "organic",
        article_url: url,
        article_title: r.title || "",
        is_ranking_article: !!r.is_ranking_article,
        judge_reason: r.reason || "",
        own_listed: !!r.own_listed,
        own_rank_in_article: r.own_position ?? null,
      })
      .select("id")
      .single();

    if (entry && r.competitors?.length) {
      await sb.from("article_listings").insert(
        r.competitors.slice(0, 20).map((c) => ({
          tenant_id: profile.tenant_id,
          serp_entry_id: entry.id,
          position: c.position ?? null,
          service_name: c.service_name || "",
          is_own: false,
        }))
      );
    }

    if (!r.is_ranking_article) continue;

    // 打診レコード（campaign × media）を作る。既存があれば触らない
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
    `KW:${kw.keyword} / 解析${rows.length}件 / 新規打診${created}件`
  );
  revalidatePath("/board");
  revalidatePath(`/campaigns/${campaignId}`);
  redirect(`/board?campaign=${campaignId}`);
}

/* ============================ 打診の確定 / 除外 ============================ */

export async function setTargetStatus(formData: FormData) {
  const { sb, profile } = await ctx();
  const ids = String(formData.get("ids") || "")
    .split(",")
    .filter(Boolean);
  const status = String(formData.get("status"));
  const reason = String(formData.get("reason") || "");
  if (!ids.length) return;
  await sb
    .from("outreach_targets")
    .update({ status, status_reason: reason, updated_at: new Date().toISOString() })
    .in("id", ids);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "outreach_target", ids[0], `status:${status}`, `${ids.length}件 ${reason}`);
  revalidatePath("/board");
  revalidatePath("/queue");
}

/* ============================ 文面生成（F4） ============================ */

export async function generateDrafts(formData: FormData) {
  const { sb, profile } = await ctx();
  const ids = String(formData.get("ids") || "")
    .split(",")
    .filter(Boolean);
  if (!ids.length) return;

  const { data: targets } = await sb
    .from("outreach_targets")
    .select("*, media:media(*), campaign:campaigns(*)")
    .in("id", ids);
  const { data: templates } = await sb
    .from("templates")
    .select("*")
    .eq("tenant_id", profile.tenant_id);

  for (const t of targets ?? []) {
    const tpl =
      (templates ?? []).find((x) => x.kind === t.kind) ?? (templates ?? [])[0] ?? null;
    const camp = t.campaign as Record<string, string>;
    const media = t.media as Record<string, string>;

    const vars: Record<string, string> = {
      "{{メディア名}}": media?.name || media?.domain || "",
      "{{サービス名}}": camp?.product_name || camp?.name || "",
      "{{単価}}": camp?.unit_price || "",
      "{{成果地点}}": camp?.conversion_point || "",
      "{{承認条件}}": camp?.approval_terms || "",
      "{{信用点}}": camp?.selling_points || "",
      "{{LP}}": camp?.lp_url || "",
      "{{差出人}}": profile.sender_name || profile.full_name,
      "{{署名}}": profile.signature || "",
    };

    let subject = tpl?.subject || `【掲載のご相談】${vars["{{サービス名}}"]}`;
    let body = tpl?.body || "";
    for (const [k, v] of Object.entries(vars)) {
      subject = subject.split(k).join(v);
      body = body.split(k).join(v);
    }

    if (hasAnthropic()) {
      const maxChars = tpl?.max_chars ? `\n本文は${tpl.max_chars}文字以内に収めること。` : "";
      const generated = await askText(
        `あなたは日本の広告代理店の担当者です。ランキング/比較メディアへ掲載を依頼するビジネスメール本文を書きます。
守ること:
- 敬体・簡潔。過度な売り込みや誇張をしない
- 相手メディアの読者にとっての価値を先に述べる
- 条件（成果地点・単価・承認条件）を明示する
- 末尾に差出人と署名を置く
- 件名は書かず、本文のみを出力する${maxChars}`,
        `【打診種別】${t.kind === "replace" ? "既に競合が掲載されている記事へのリプレイス打診" : "新規掲載の打診"}
【メディア】${vars["{{メディア名}}"]}（${media?.domain}）
【掲載記事】${t.article_url}
【商材】${vars["{{サービス名}}"]}
【LP】${vars["{{LP}}"]}
【成果地点】${vars["{{成果地点}}"]}
【単価】${vars["{{単価}}"]}
【承認条件】${vars["{{承認条件}}"]}
【訴求・信用点】${vars["{{信用点}}"]}
【差出人】${vars["{{差出人}}"]}
【署名】${vars["{{署名}}"]}

${body ? `既存テンプレートを土台にしてください:\n---\n${body}\n---` : ""}`,
        1500
      );
      if (generated) body = generated;
    }

    const { data: last } = await sb
      .from("message_drafts")
      .select("version")
      .eq("outreach_target_id", t.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    await sb.from("message_drafts").insert({
      tenant_id: profile.tenant_id,
      outreach_target_id: t.id,
      template_id: tpl?.id ?? null,
      version: (last?.version ?? 0) + 1,
      subject,
      body,
      origin: "ai",
    });

    await sb
      .from("outreach_targets")
      .update({ status: "awaiting_approval", updated_at: new Date().toISOString() })
      .eq("id", t.id);
  }

  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "message_draft", ids[0], "generated", `${ids.length}件`);
  revalidatePath("/queue");
  revalidatePath("/board");
}

export async function saveDraft(formData: FormData) {
  const { sb, profile } = await ctx();
  const targetId = String(formData.get("target_id"));
  const subject = String(formData.get("subject") || "");
  const body = String(formData.get("body") || "");
  const { data: last } = await sb
    .from("message_drafts")
    .select("version, template_id")
    .eq("outreach_target_id", targetId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  await sb.from("message_drafts").insert({
    tenant_id: profile.tenant_id,
    outreach_target_id: targetId,
    template_id: last?.template_id ?? null,
    version: (last?.version ?? 0) + 1,
    subject,
    body,
    origin: "human",
  });
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "message_draft", targetId, "edited");
  revalidatePath("/queue");
}

/* ============================ 承認 → 送信キュー（F5/F6） ============================ */

export async function approveAndQueue(formData: FormData) {
  const { sb, profile } = await ctx();
  const ids = String(formData.get("ids") || "")
    .split(",")
    .filter(Boolean);
  const scheduledFor = String(formData.get("scheduled_for") || "");
  if (!ids.length) return;

  let queued = 0;
  const skipped: string[] = [];

  for (const id of ids) {
    const { data: t } = await sb
      .from("outreach_targets")
      .select("*, media:media(*)")
      .eq("id", id)
      .single();
    if (!t) continue;
    const media = t.media as Record<string, unknown>;

    // 営業お断りは送らない
    if (media?.no_solicitation) {
      await sb
        .from("outreach_targets")
        .update({ status: "excluded", status_reason: "営業お断り" })
        .eq("id", id);
      skipped.push(`${media.domain}: 営業お断り`);
      continue;
    }

    // 二重送信防止
    const { data: past } = await sb
      .from("send_attempts")
      .select("result")
      .eq("outreach_target_id", id);
    if ((past ?? []).some((p) => BLOCKING_RESULTS.includes(p.result))) {
      skipped.push(`${media.domain}: 送信済/不確定のためスキップ`);
      continue;
    }

    const { data: draft } = await sb
      .from("message_drafts")
      .select("id")
      .eq("outreach_target_id", id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: contact } = await sb
      .from("media_contacts")
      .select("id, kind")
      .eq("media_id", t.media_id)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    await sb.from("message_drafts").update({ approved_by: profile.id, approved_at: new Date().toISOString() }).eq("id", draft?.id ?? "");
    await sb.from("send_attempts").insert({
      tenant_id: profile.tenant_id,
      outreach_target_id: id,
      contact_id: contact?.id ?? null,
      draft_id: draft?.id ?? null,
      channel: contact?.kind ?? "form",
      scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      result: "queued",
      approved_by: profile.id,
    });
    await sb
      .from("outreach_targets")
      .update({ status: "queued", updated_at: new Date().toISOString() })
      .eq("id", id);
    queued++;
  }

  await audit(
    sb,
    profile.tenant_id,
    profile.id,
    profile.full_name,
    "send_attempt",
    null,
    "approved",
    `承認${queued}件 / スキップ${skipped.length}件 ${skipped.slice(0, 5).join(" / ")}`
  );
  revalidatePath("/queue");
  revalidatePath("/outbox");
}

export async function recordSendResult(formData: FormData) {
  const { sb, profile } = await ctx();
  const attemptId = String(formData.get("attempt_id"));
  const result = String(formData.get("result"));
  const detail = String(formData.get("detail") || "");
  const { data: a } = await sb
    .from("send_attempts")
    .select("outreach_target_id")
    .eq("id", attemptId)
    .single();
  await sb
    .from("send_attempts")
    .update({ result, error_detail: detail, sent_at: new Date().toISOString() })
    .eq("id", attemptId);

  if (a) {
    const next =
      result === "success" || result === "manual"
        ? "sent"
        : result === "uncertain"
        ? "uncertain"
        : result === "no_solicitation"
        ? "excluded"
        : "exception";
    await sb
      .from("outreach_targets")
      .update({ status: next, status_reason: detail, updated_at: new Date().toISOString() })
      .eq("id", a.outreach_target_id);
    if (result === "no_solicitation") {
      const { data: t } = await sb
        .from("outreach_targets")
        .select("media_id")
        .eq("id", a.outreach_target_id)
        .single();
      if (t)
        await sb
          .from("media")
          .update({ no_solicitation: true, no_solicitation_reason: detail || "送信時に検知" })
          .eq("id", t.media_id);
    }
  }
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "send_attempt", attemptId, `result:${result}`, detail);
  revalidatePath("/outbox");
  revalidatePath("/exceptions");
}

/* ============================ 例外対応（F7） ============================ */

export async function suggestContactFix(formData: FormData) {
  const { sb, profile } = await ctx();
  const mediaId = String(formData.get("media_id"));
  if (!hasAnthropic()) return;
  const { data: m } = await sb.from("media").select("*").eq("id", mediaId).single();
  if (!m) return;
  const out = await askJson<{ candidates: string[]; note: string }>(
    "あなたは日本のWebサイトの問い合わせ導線に詳しいリサーチャーです。到達できないURLについて、一般的な命名規則から問い合わせフォームURLの候補を挙げます。Web検索はできないため、あくまで候補であることを前提に答えます。",
    `メディア名: ${m.name}
ドメイン: ${m.domain}
既知の情報: ${m.note}

このサイトの問い合わせフォームURLとして考えられる候補を最大5件、{"candidates":["https://..."],"note":"確認時の注意"} で出力してください。実在の確証はない前提で、確認が必要である旨を note に書くこと。`
  );
  if (out) {
    await sb
      .from("media")
      .update({
        note:
          `${m.note}\n[AI候補 ${new Date().toISOString().slice(0, 10)}] ` +
          `${(out.candidates || []).join(" / ")} — ${out.note || ""}（未検証。到達確認のうえ人が確定すること）`,
      })
      .eq("id", mediaId);
    await audit(sb, profile.tenant_id, profile.id, profile.full_name, "media", mediaId, "ai_url_candidates");
  }
  revalidatePath("/exceptions");
  revalidatePath(`/media/${mediaId}`);
}

/* ============================ 返信（F8） ============================ */

export async function addReply(formData: FormData) {
  const { sb, profile } = await ctx();
  const targetId = String(formData.get("target_id"));
  const body = String(formData.get("body") || "");
  if (!body.trim()) return;

  let ai = { ai_class: "", ai_summary: "", extracted_terms: "" };
  if (hasAnthropic()) {
    const out = await askJson<{ class: string; summary: string; terms: string }>(
      `メディアからの返信を分類します。class は placeable(掲載可能) / negotiating(条件交渉) / rejected(掲載不可) / irrelevant(自動応答・無関係) のいずれか。`,
      `返信本文:
---
${body.slice(0, 4000)}
---
{"class":"...","summary":"1文の要約","terms":"単価・掲載位置・期間など読み取れた条件。無ければ空文字"} を出力。`
    );
    if (out)
      ai = {
        ai_class: out.class || "",
        ai_summary: out.summary || "",
        extracted_terms: out.terms || "",
      };
  }

  await sb.from("replies").insert({
    tenant_id: profile.tenant_id,
    outreach_target_id: targetId,
    body,
    ...ai,
  });
  await sb
    .from("outreach_targets")
    .update({ status: "replied", updated_at: new Date().toISOString() })
    .eq("id", targetId);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "reply", targetId, "received", ai.ai_class);
  revalidatePath("/queue");
  revalidatePath("/replies");
}

export async function confirmReply(formData: FormData) {
  const { sb, profile } = await ctx();
  const replyId = String(formData.get("reply_id"));
  const targetId = String(formData.get("target_id"));
  const cls = String(formData.get("final_class"));
  await sb
    .from("replies")
    .update({ final_class: cls, confirmed_by: profile.id, confirmed_at: new Date().toISOString() })
    .eq("id", replyId);
  const next =
    cls === "placeable" ? "placeable" : cls === "negotiating" ? "negotiating" : cls === "rejected" ? "rejected" : "sent";
  await sb
    .from("outreach_targets")
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq("id", targetId);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "reply", replyId, `confirmed:${cls}`);
  revalidatePath("/queue");
  revalidatePath("/replies");
}

export async function saveNegotiationNote(formData: FormData) {
  const { sb } = await ctx();
  const targetId = String(formData.get("target_id"));
  await sb
    .from("outreach_targets")
    .update({ negotiation_note: String(formData.get("note") || "") })
    .eq("id", targetId);
  revalidatePath("/replies");
}

/* ============================ 掲載・報告（F9） ============================ */

export async function createPlacement(formData: FormData) {
  const { sb, profile } = await ctx();
  const targetId = String(formData.get("target_id"));
  await sb.from("placements").insert({
    tenant_id: profile.tenant_id,
    outreach_target_id: targetId,
    article_url: safeUrl(String(formData.get("article_url") || "")),
    position_in_article: Number(formData.get("position") || 0) || null,
    unit_price: String(formData.get("unit_price") || ""),
    started_on: String(formData.get("started_on") || "") || null,
    evidence_path: String(formData.get("evidence_path") || ""),
  });
  await sb
    .from("outreach_targets")
    .update({ status: "placed", updated_at: new Date().toISOString() })
    .eq("id", targetId);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "placement", targetId, "created");
  revalidatePath("/placements");
}

export async function markReported(formData: FormData) {
  const { sb, profile } = await ctx();
  const campaignId = String(formData.get("campaign_id"));
  const { data: targets } = await sb
    .from("outreach_targets")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("status", "placed");
  const ids = (targets ?? []).map((t) => t.id);
  if (ids.length) await sb.from("outreach_targets").update({ status: "reported" }).in("id", ids);
  await sb.from("reports").insert({
    tenant_id: profile.tenant_id,
    campaign_id: campaignId,
    generated_at: new Date().toISOString(),
    summary: `掲載${ids.length}件を報告済みに更新`,
  });
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "report", campaignId, "issued", `${ids.length}件`);
  revalidatePath("/placements");
}

/* ============================ メディア台帳（F3） ============================ */

export async function updateMedia(formData: FormData) {
  const { sb, profile } = await ctx();
  const id = String(formData.get("id"));
  await sb
    .from("media")
    .update({
      name: String(formData.get("name") || ""),
      operator: String(formData.get("operator") || ""),
      category: String(formData.get("category") || ""),
      asp_type: String(formData.get("asp_type") || "unknown"),
      asp_name: String(formData.get("asp_name") || ""),
      note: String(formData.get("note") || ""),
    })
    .eq("id", id);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "media", id, "updated");
  revalidatePath(`/media/${id}`);
}

export async function toggleNoSolicitation(formData: FormData) {
  const { sb, profile } = await ctx();
  const id = String(formData.get("id"));
  const to = String(formData.get("to")) === "true";
  if (!to && profile.role !== "admin") return; // 解除は管理者のみ
  await sb
    .from("media")
    .update({ no_solicitation: to, no_solicitation_reason: String(formData.get("reason") || "") })
    .eq("id", id);
  if (to) {
    await sb
      .from("outreach_targets")
      .update({ status: "excluded", status_reason: "営業お断り" })
      .eq("media_id", id)
      .in("status", ["collected", "confirmed", "drafted", "awaiting_approval", "queued"]);
  }
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "media", id, to ? "no_solicitation_on" : "no_solicitation_off");
  revalidatePath(`/media/${id}`);
  revalidatePath("/media");
}

export async function addContact(formData: FormData) {
  const { sb, profile } = await ctx();
  const mediaId = String(formData.get("media_id"));
  await sb.from("media_contacts").insert({
    tenant_id: profile.tenant_id,
    media_id: mediaId,
    kind: String(formData.get("kind") || "form"),
    value: String(formData.get("value") || ""),
  });
  revalidatePath(`/media/${mediaId}`);
}

export async function deleteContact(formData: FormData) {
  const { sb } = await ctx();
  const id = String(formData.get("id"));
  const mediaId = String(formData.get("media_id"));
  await sb.from("media_contacts").delete().eq("id", id);
  revalidatePath(`/media/${mediaId}`);
}

export async function mergeMedia(formData: FormData) {
  const { sb, profile } = await ctx();
  const fromId = String(formData.get("from_id"));
  const intoId = String(formData.get("into_id"));
  if (!fromId || !intoId || fromId === intoId) return;
  await sb.from("media_contacts").update({ media_id: intoId }).eq("media_id", fromId);
  await sb.from("serp_entries").update({ media_id: intoId }).eq("media_id", fromId);
  // 打診は (campaign, media) が一意なので、衝突するものは削除して残りを付け替える
  const { data: fromTargets } = await sb
    .from("outreach_targets")
    .select("id, campaign_id")
    .eq("media_id", fromId);
  for (const t of fromTargets ?? []) {
    const { data: clash } = await sb
      .from("outreach_targets")
      .select("id")
      .eq("campaign_id", t.campaign_id)
      .eq("media_id", intoId)
      .maybeSingle();
    if (clash) await sb.from("outreach_targets").delete().eq("id", t.id);
    else await sb.from("outreach_targets").update({ media_id: intoId }).eq("id", t.id);
  }
  await sb.from("media").delete().eq("id", fromId);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "media", intoId, "merged", `from ${fromId}`);
  revalidatePath("/media");
  redirect(`/media/${intoId}`);
}

/* ============================ テンプレート / 設定 ============================ */

export async function saveTemplate(formData: FormData) {
  const { sb, profile } = await ctx();
  const id = String(formData.get("id") || "");
  const payload = {
    tenant_id: profile.tenant_id,
    name: String(formData.get("name") || "無題"),
    kind: String(formData.get("kind") || "new"),
    subject: String(formData.get("subject") || ""),
    body: String(formData.get("body") || ""),
    max_chars: Number(formData.get("max_chars") || 0) || null,
  };
  if (id) await sb.from("templates").update(payload).eq("id", id);
  else await sb.from("templates").insert(payload);
  revalidatePath("/templates");
}

export async function deleteTemplate(formData: FormData) {
  const { sb } = await ctx();
  await sb.from("templates").delete().eq("id", String(formData.get("id")));
  revalidatePath("/templates");
}

export async function addAsp(formData: FormData) {
  const { sb, profile } = await ctx();
  const domain = normalizeDomain(String(formData.get("domain") || ""));
  if (!domain) return;
  await sb
    .from("asp_master")
    .upsert(
      { tenant_id: profile.tenant_id, domain, asp_name: String(formData.get("asp_name") || "") },
      { onConflict: "tenant_id,domain" }
    );
  revalidatePath("/settings");
}

export async function deleteAsp(formData: FormData) {
  const { sb } = await ctx();
  await sb.from("asp_master").delete().eq("id", String(formData.get("id")));
  revalidatePath("/settings");
}

export async function saveTenantSettings(formData: FormData) {
  const { sb, profile } = await ctx();
  await sb
    .from("tenants")
    .update({
      send_mode: String(formData.get("send_mode") || "approval"),
      rate_limit_per_hour: Number(formData.get("rate_limit_per_hour") || 30),
    })
    .eq("id", profile.tenant_id);
  await audit(sb, profile.tenant_id, profile.id, profile.full_name, "tenant", profile.tenant_id, "settings_updated");
  revalidatePath("/settings");
}

export async function saveProfile(formData: FormData) {
  const { sb, profile } = await ctx();
  await sb
    .from("profiles")
    .update({
      full_name: String(formData.get("full_name") || ""),
      sender_name: String(formData.get("sender_name") || ""),
      signature: String(formData.get("signature") || ""),
    })
    .eq("id", profile.id);
  revalidatePath("/settings");
}
