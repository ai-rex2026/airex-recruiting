import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** CSVフィールドのエスケープ（カンマ・引用符・改行を含む場合は引用し、引用符は二重化） */
function csvField(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type EntryRow = {
  id: string;
  snapshot_id: string;
  media_id: string | null;
  rank: number | null;
  article_url: string;
  article_title: string;
  is_ranking_article: boolean;
  own_listed: boolean;
  own_rank_in_article: number | null;
  media: { id: string; name: string; domain: string } | null;
};

const HEADER = [
  "キーワード",
  "取得日時",
  "検索順位",
  "メディア名",
  "ドメイン",
  "記事タイトル",
  "記事URL",
  "ランキング記事判定",
  "記事内順位",
  "掲載サービス名",
  "自社商材",
  "自社掲載",
  "自社記事内順位",
  "打診種別",
  "打診ステータス",
  "交渉メモ",
];

/**
 * 陣取り表のCSVエクスポート。
 * GET /api/export/board?campaign={id}
 * KWごとの最新スナップショット × 記事 × 掲載枠（article_listing）を1行ずつ出力し、
 * 末尾に「検索結果に紐づかない候補メディア」のセクションを付ける。
 */
export async function GET(req: NextRequest) {
  const { sb, user } = await getSessionProfile();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const campaignId = req.nextUrl.searchParams.get("campaign") ?? "";
  if (!campaignId) return NextResponse.json({ error: "campaign is required" }, { status: 400 });

  const { data: camp } = await sb
    .from("campaigns")
    .select("id, name, product_name")
    .eq("id", campaignId)
    .maybeSingle();
  if (!camp) return NextResponse.json({ error: "campaign not found" }, { status: 404 });
  const productName = camp.product_name || camp.name || "";

  // --- KW → 最新スナップショット → 記事 → 掲載枠（BoardView と同じ束ね方） ---
  const { data: kws } = await sb
    .from("keywords")
    .select("id, keyword")
    .eq("campaign_id", campaignId)
    .order("created_at");
  const kwIds = (kws ?? []).map((k) => k.id);

  const { data: snaps } = kwIds.length
    ? await sb
        .from("serp_snapshots")
        .select("id, keyword_id, collected_at")
        .in("keyword_id", kwIds)
        .order("collected_at", { ascending: false })
    : { data: [] as { id: string; keyword_id: string; collected_at: string }[] };
  const latestSnap = new Map<string, { id: string; collected_at: string }>();
  for (const s of snaps ?? []) if (!latestSnap.has(s.keyword_id)) latestSnap.set(s.keyword_id, s);
  const snapIds = [...latestSnap.values()].map((s) => s.id);

  const { data: entriesRaw } = snapIds.length
    ? await sb
        .from("serp_entries")
        .select(
          "id, snapshot_id, media_id, rank, article_url, article_title, is_ranking_article, own_listed, own_rank_in_article, media:media(id, name, domain)"
        )
        .in("snapshot_id", snapIds)
        .order("rank", { ascending: true, nullsFirst: false })
    : { data: [] };
  const entries = (entriesRaw ?? []) as unknown as EntryRow[];
  const entriesBySnap = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const arr = entriesBySnap.get(e.snapshot_id) ?? [];
    arr.push(e);
    entriesBySnap.set(e.snapshot_id, arr);
  }

  const entryIds = entries.map((e) => e.id);
  const { data: listingsRaw } = entryIds.length
    ? await sb
        .from("article_listings")
        .select("serp_entry_id, position, service_name, is_own")
        .in("serp_entry_id", entryIds)
        .order("position", { ascending: true, nullsFirst: false })
    : { data: [] };
  const listByEntry = new Map<string, { position: number | null; service_name: string }[]>();
  for (const l of (listingsRaw ?? []) as { serp_entry_id: string; position: number | null; service_name: string }[]) {
    const arr = listByEntry.get(l.serp_entry_id) ?? [];
    arr.push({ position: l.position, service_name: l.service_name });
    listByEntry.set(l.serp_entry_id, arr);
  }

  const { data: targets } = await sb
    .from("outreach_targets")
    .select("media_id, kind, status, negotiation_note, media:media(id, name, domain)")
    .eq("campaign_id", campaignId);
  const targetByMedia = new Map((targets ?? []).map((t) => [t.media_id, t]));
  const snapMediaIds = new Set(entries.map((e) => e.media_id).filter(Boolean) as string[]);

  // --- 行の組み立て ---
  const rows: string[][] = [HEADER];

  for (const k of kws ?? []) {
    const snap = latestSnap.get(k.id);
    if (!snap) continue;
    const kwEntries = entriesBySnap.get(snap.id) ?? [];
    for (const e of kwEntries) {
      const t = e.media_id ? targetByMedia.get(e.media_id) : undefined;
      const base = [
        k.keyword,
        snap.collected_at ?? "",
        e.rank ?? "",
        e.media?.name ?? "",
        e.media?.domain ?? "",
        e.article_title ?? "",
        e.article_url ?? "",
        e.is_ranking_article ? "ランキング/比較記事" : "非該当",
      ];
      const tail = [
        productName,
        e.own_listed ? "掲載中" : "未掲載",
        e.own_rank_in_article ?? "",
        t ? (t.kind === "replace" ? "リプレイス" : "新規") : "",
        t?.status ?? "",
        t?.negotiation_note ?? "",
      ];
      const listings = listByEntry.get(e.id) ?? [];
      if (!listings.length) {
        rows.push([...base, "", "", ...tail].map(String));
      } else {
        for (const l of listings) {
          rows.push([...base, l.position ?? "", l.service_name ?? "", ...tail].map(String));
        }
      }
    }
  }

  // --- 検索結果に紐づかない候補メディア ---
  const unmatched = (targets ?? []).filter((t) => t.media_id && !snapMediaIds.has(t.media_id));
  if (unmatched.length) {
    rows.push([]); // 空行でセクションを分ける
    for (const t of unmatched) {
      const m = t.media as unknown as { name: string; domain: string } | null;
      rows.push(
        [
          "検索結果に紐づかない候補メディア",
          "",
          "",
          m?.name ?? "",
          m?.domain ?? "",
          "",
          "",
          "",
          "",
          "",
          productName,
          "",
          "",
          t.kind === "replace" ? "リプレイス" : "新規",
          t.status ?? "",
          t.negotiation_note ?? "",
        ].map(String)
      );
    }
  }

  // Excel が日本語を正しく開けるよう UTF-8 BOM を付ける
  const body = String.fromCharCode(0xfeff) + rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const niceName = `jindori_${String(camp.name).replace(/[\\/:*?"<>|\s]+/g, "_")}_${date}.csv`;
  const asciiName = `jindori_${campaignId.slice(0, 8)}_${date}.csv`;

  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(niceName)}`,
      "cache-control": "no-store",
    },
  });
}
