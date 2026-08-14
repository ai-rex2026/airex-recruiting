"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { hasAnthropic, askJsonWithContent, fileContentBlock } from "@/lib/anthropic";
import { extractOoxmlText, ooxmlKindOf } from "@/lib/ooxml-read";

async function ctx() {
  const { sb, user, profile } = await getSessionProfile();
  if (!user || !profile) redirect("/login");
  return { sb, user: user!, profile: profile! };
}

export type DocKind = "campaign_brief" | "media_kit";

/** 案件資料から読み取る内容（案件カルテの各項目） */
export type BriefExtract = {
  client_name: string;
  campaign_name: string;
  product_name: string;
  genre: string;
  lp_url: string;
  reference_url: string;
  draft_url: string;
  unit_price: string;
  conversion_point: string;
  approval_terms: string;
  selling_points: string;
  brief: string;
  keywords: { keyword: string; priority: 1 | 2 | 3 }[];
};

/** 媒体資料から読み取る掲載条件。媒体台帳（media.note）に入れる */
export type MediaKitExtract = {
  media_name: string;
  initial_fee: string;
  monthly_fee: string;
  performance_fee: string;
  placement_position: string;
  top_placement_option: string;
  placement_period: string;
  tracking_link: string;
  conversion_point: string;
  placeable: string;
  other_terms: string;
};

export type DocumentRow = {
  id: string;
  kind: DocKind;
  campaign_id: string | null;
  media_id: string | null;
  file_name: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  status: string;
  extracted: BriefExtract | MediaKitExtract | null;
  extract_error: string;
  created_at: string;
};

/** ブラウザから Storage に直接置いたファイルを documents に登録する（サーバー経由でないのはサイズ制限のため） */
export async function registerDocument(input: {
  kind: DocKind;
  campaign_id?: string | null;
  media_id?: string | null;
  file_name: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { sb, profile } = await ctx();

  // 別テナントのパスを登録されないよう、保存先の先頭セグメントを検証する
  if (!input.storage_path.startsWith(`${profile.tenant_id}/`)) {
    return { ok: false, error: "保存先が不正です。" };
  }

  const { data, error } = await sb
    .from("documents")
    .insert({
      tenant_id: profile.tenant_id,
      kind: input.kind,
      campaign_id: input.campaign_id ?? null,
      media_id: input.media_id ?? null,
      file_name: input.file_name,
      storage_path: input.storage_path,
      mime_type: input.mime_type,
      byte_size: input.byte_size,
      uploaded_by: profile.id,
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? "登録に失敗しました。" };
  return { ok: true, id: data.id };
}

const BRIEF_SYSTEM = `あなたは日本のアフィリエイト広告代理店のプランナーです。クライアントから受け取った案件資料を読み、広告リクルーティング（ランキング/比較メディアへの掲載打診）用の案件情報を抜き出します。
- 資料に書かれていない項目は空文字にする。推測で埋めない。ただし conversion_point と keywords だけは、書かれていなければ資料の内容から妥当に推定してよい。
- unit_price: 報酬条件。ネット（メディアへ）とグロス（クライアント）の区別が資料にあれば「ネット：〇〇／グロス：〇〇」の形で両方書く。
- brief: 理想のユーザー像・NGユーザー層・検索意図・SEO推奨キーワードなど、案件固有の考え方を資料の見出し構成のまま残す。要約しすぎない。
- keywords: 見込み客が検索しそうな日本語キーワードを8〜12個。資料に推奨KWの記載があればそれを最優先で含める。「〇〇 おすすめ」「〇〇 比較」型も必ず入れる。priority は 1（最優先）〜3。`;

const MEDIA_KIT_SYSTEM = `あなたは日本のアフィリエイト広告代理店の担当者です。メディアから受け取った営業資料・媒体資料を読み、掲載条件を抜き出します。
- 資料に書かれていない項目は空文字にする。推測で埋めない。
- 金額は税抜/税込の区別を資料のとおりに残す（例「10万円（税抜）」）。
- placeable: 掲載可否や審査条件の記載（例「掲載可能」「要審査」「同業他社は不可」）。
- tracking_link: 計測リンクの設置可否。
- other_terms: 上記に収まらない条件（最低出稿期間・入稿規定・締切など）。`;

/** Storage から読んで Claude に渡す形にする。PDF は document ブロック、OOXML はテキスト化 */
async function buildContent(sb: Awaited<ReturnType<typeof ctx>>["sb"], doc: DocumentRow) {
  const { data: blob, error } = await sb.storage.from("documents").download(doc.storage_path);
  if (error || !blob) throw new Error("ファイルを読み込めませんでした。");
  const buf = new Uint8Array(await blob.arrayBuffer());

  const isPdf =
    doc.mime_type === "application/pdf" || doc.file_name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    return fileContentBlock(doc.file_name, doc.mime_type, Buffer.from(buf).toString("base64"), true);
  }

  const kind = ooxmlKindOf(doc.file_name);
  if (!kind) throw new Error("対応していない形式です（PDF / Word / Excel / PowerPoint）。");
  const text = extractOoxmlText(buf, kind);
  if (!text.trim()) {
    throw new Error(
      "テキストを取り出せませんでした。図や画像の中の文字は読めないため、PDF に書き出してからお試しください。"
    );
  }
  return fileContentBlock(doc.file_name, doc.mime_type, text, false);
}

export type ExtractResult =
  | { ok: true; kind: DocKind; extracted: BriefExtract | MediaKitExtract }
  | { ok: false; error: string };

/**
 * 資料を読み取って抽出結果を documents.extracted に保存する。
 * ここでは確定せず、人が確認してから apply* で本体へ反映する。
 */
export async function extractDocument(documentId: string): Promise<ExtractResult> {
  const { sb } = await ctx();
  if (!hasAnthropic()) {
    return { ok: false, error: "ANTHROPIC_API_KEY が未設定のため、資料の読み取りを実行できません。" };
  }

  const { data: doc } = await sb.from("documents").select("*").eq("id", documentId).maybeSingle();
  if (!doc) return { ok: false, error: "資料が見つかりません。" };
  const row = doc as DocumentRow;

  await sb.from("documents").update({ status: "extracting", extract_error: "" }).eq("id", documentId);

  try {
    const block = await buildContent(sb, row);
    const isBrief = row.kind === "campaign_brief";

    const shape = isBrief
      ? `{"client_name":"","campaign_name":"","product_name":"","genre":"","lp_url":"","reference_url":"","draft_url":"","unit_price":"","conversion_point":"","approval_terms":"","selling_points":"","brief":"","keywords":[{"keyword":"","priority":1}]}`
      : `{"media_name":"","initial_fee":"","monthly_fee":"","performance_fee":"","placement_position":"","top_placement_option":"","placement_period":"","tracking_link":"","conversion_point":"","placeable":"","other_terms":""}`;

    const out = await askJsonWithContent<BriefExtract | MediaKitExtract>(
      isBrief ? BRIEF_SYSTEM : MEDIA_KIT_SYSTEM,
      [block, { type: "text", text: `この資料から読み取ってください。\n\n出力形式（STRICT JSON のみ）:\n${shape}` }],
      isBrief ? 8000 : 4000
    );
    if (!out) throw new Error("AIの読み取り結果を解析できませんでした。もう一度お試しください。");

    await sb
      .from("documents")
      .update({ status: "extracted", extracted: out, extract_error: "" })
      .eq("id", documentId);

    if (row.campaign_id) revalidatePath(`/campaigns/${row.campaign_id}`);
    if (row.media_id) revalidatePath(`/media/${row.media_id}`);
    return { ok: true, kind: row.kind, extracted: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "読み取りに失敗しました。";
    await sb.from("documents").update({ status: "error", extract_error: msg }).eq("id", documentId);
    return { ok: false, error: msg };
  }
}

/** 媒体資料の抽出結果を媒体台帳（media.note）へ反映する。案件をまたいで使う情報なのでここに入れる */
export async function applyMediaKit(formData: FormData): Promise<void> {
  const { sb } = await ctx();
  const documentId = String(formData.get("document_id") || "");
  const note = String(formData.get("note") || "").trim();
  if (!documentId) return;

  const { data: doc } = await sb
    .from("documents")
    .select("media_id, file_name")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc?.media_id) return;

  // 出典が後で分かるようファイル名を残す（元の運用エクセルも備考にPDF名を書いていた）
  const body = note ? `${note}\n（出典：${doc.file_name}）` : "";
  await sb.from("media").update({ note: body }).eq("id", doc.media_id);
  revalidatePath(`/media/${doc.media_id}`);
}

/**
 * 案件資料の抽出結果を既存案件へ反映する。
 * 空欄の項目だけを埋め、人が既に書いた内容は上書きしない（brief は明示チェック時のみ差し替え）。
 */
export async function applyCampaignBrief(formData: FormData): Promise<void> {
  const { sb } = await ctx();
  const documentId = String(formData.get("document_id") || "");
  if (!documentId) return;

  const { data: doc } = await sb
    .from("documents")
    .select("campaign_id, extracted")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc?.campaign_id || !doc.extracted) return;
  const x = doc.extracted as BriefExtract;

  const { data: c } = await sb
    .from("campaigns")
    .select("genre, lp_url, reference_url, draft_url, unit_price, conversion_point, approval_terms, selling_points, brief")
    .eq("id", doc.campaign_id)
    .maybeSingle();
  if (!c) return;

  const keep = (current: string, next: string) => (current?.trim() ? current : next || "");
  const overwriteBrief = String(formData.get("overwrite_brief")) === "on";

  await sb
    .from("campaigns")
    .update({
      genre: keep(c.genre, x.genre),
      lp_url: keep(c.lp_url, x.lp_url),
      reference_url: keep(c.reference_url, x.reference_url),
      draft_url: keep(c.draft_url, x.draft_url),
      unit_price: keep(c.unit_price, x.unit_price),
      conversion_point: keep(c.conversion_point, x.conversion_point),
      approval_terms: keep(c.approval_terms, x.approval_terms),
      selling_points: keep(c.selling_points, x.selling_points),
      brief: overwriteBrief ? x.brief || "" : keep(c.brief, x.brief),
    })
    .eq("id", doc.campaign_id);

  revalidatePath(`/campaigns/${doc.campaign_id}`);
  revalidatePath("/board");
}

export async function deleteDocument(formData: FormData): Promise<void> {
  const { sb } = await ctx();
  const id = String(formData.get("id") || "");
  if (!id) return;

  const { data: doc } = await sb
    .from("documents")
    .select("storage_path, campaign_id, media_id")
    .eq("id", id)
    .maybeSingle();
  if (!doc) return;

  await sb.storage.from("documents").remove([doc.storage_path]);
  await sb.from("documents").delete().eq("id", id);
  if (doc.campaign_id) revalidatePath(`/campaigns/${doc.campaign_id}`);
  if (doc.media_id) revalidatePath(`/media/${doc.media_id}`);
}

/** 資料のダウンロード用の署名URL（非公開バケットなので都度発行する） */
export async function signedDocumentUrl(storagePath: string): Promise<string | null> {
  const { sb } = await ctx();
  const { data } = await sb.storage.from("documents").createSignedUrl(storagePath, 300);
  return data?.signedUrl ?? null;
}
