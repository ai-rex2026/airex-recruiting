import type { createClient } from "@/lib/supabase/server";
import { OUTREACH_STATUS } from "@/lib/domain";

type Sb = Awaited<ReturnType<typeof createClient>>;

export type BoardListing = { position: number | null; service_name: string; is_own: boolean };

/** 陣取りボード1行 ＝ 運用エクセルの1行（KW × 記事）。列順は EXCEL_COLUMNS と対応する */
export type BoardRow = {
  no: number;
  date: string; // 日付（収集日）
  keyword: string; // KW
  rank: number | null; // 検索順位
  entryId: string;
  mediaId: string | null;
  mediaName: string; // サイト名
  mediaDomain: string;
  articleUrl: string; // サイトURL
  articleTitle: string;
  listed: boolean; // 掲載有無
  ownRankInArticle: number | null;
  asp: string; // ASP・経路
  status: string; // ステータス（内部キー。未登録は ""）
  statusLabel: string;
  note: string; // 備考
  /** 記事内の掲載枠 1位〜10位。空き枠は null */
  top: (BoardListing | null)[];
  /** 11位以降の件数（10位セルに「他n件」として出す） */
  overflow: number;
  /** 検索結果に紐づかない候補メディアの行（末尾セクション） */
  unmatched: boolean;
};

export type BoardKeyword = {
  id: string;
  keyword: string;
  snapshotId: string | null;
  collectedAt: string | null;
  count: number;
};

/** ダウンロード（エクセル/CSV）の列定義。UI のヘッダーもこれを使う */
export const EXCEL_COLUMNS: { key: string; label: string; width: number }[] = [
  { key: "no", label: "No.", width: 6 },
  { key: "date", label: "日付", width: 12 },
  { key: "keyword", label: "KW", width: 22 },
  { key: "rank", label: "順位", width: 6 },
  { key: "site", label: "サイト名", width: 20 },
  { key: "url", label: "サイトURL", width: 42 },
  { key: "listed", label: "掲載有無", width: 10 },
  { key: "asp", label: "ASP・経路", width: 18 },
  { key: "status", label: "ステータス", width: 14 },
  { key: "note", label: "備考", width: 28 },
  ...Array.from({ length: 10 }, (_, i) => ({
    key: `p${i + 1}`,
    label: `${i + 1}位`,
    width: 16,
  })),
];

type MediaRow = {
  id: string;
  name: string;
  domain: string;
  asp_name: string;
  asp_type: string;
  note: string;
  no_solicitation: boolean;
  no_solicitation_reason: string;
};

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
  media: MediaRow | null;
};

type TargetRow = {
  media_id: string;
  kind: string;
  status: string;
  negotiation_note: string;
  media: MediaRow | null;
};

function fmtDate(dt: string | null | undefined): string {
  if (!dt) return "";
  const d = new Date(dt);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function aspOf(m: MediaRow | null): string {
  return m?.asp_name || (m?.asp_type === "direct" ? "直" : "");
}

function noteOf(m: MediaRow | null, negotiationNote?: string): string {
  return [
    m?.no_solicitation
      ? `営業お断り${m.no_solicitation_reason ? `：${m.no_solicitation_reason}` : ""}`
      : "",
    negotiationNote ?? "",
    m?.note ?? "",
  ]
    .filter(Boolean)
    .join(" / ");
}

/** 記事内の掲載枠を 1位〜10位の固定スロットに割り当てる。position が無いものは空きスロットへ詰める */
function toSlots(listings: BoardListing[]): { top: (BoardListing | null)[]; overflow: number } {
  const top: (BoardListing | null)[] = Array(10).fill(null);
  const rest: BoardListing[] = [];
  for (const l of listings) {
    const p = l.position;
    if (p && p >= 1 && p <= 10 && !top[p - 1]) top[p - 1] = l;
    else rest.push(l);
  }
  let overflow = 0;
  for (const l of rest) {
    const free = top.indexOf(null);
    // position 不明・重複は空きスロットへ。11位以降と、埋まりきった分は「他n件」に回す
    if (free >= 0 && !(l.position && l.position > 10)) top[free] = l;
    else overflow++;
  }
  return { top, overflow };
}

/**
 * 陣取りボードの表データを組み立てる（BoardView とエクスポートで共有）。
 * KWごとの最新スナップショットにある記事を、運用エクセルと同じ「1行＝1記事」の形に平たくし、
 * 記事内の掲載枠を 1位〜10位の列へ展開する。末尾に検索結果と紐づかない候補メディアを足す。
 */
export async function buildBoardData(sb: Sb, campaignId: string) {
  const MEDIA_COLS = "id, name, domain, asp_name, asp_type, note, no_solicitation, no_solicitation_reason";

  const { data: kwsRaw } = await sb
    .from("keywords")
    .select("id, keyword")
    .eq("campaign_id", campaignId)
    .order("created_at");
  const kws = (kwsRaw ?? []) as { id: string; keyword: string }[];
  const kwIds = kws.map((k) => k.id);

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
          `id, snapshot_id, media_id, rank, article_url, article_title, is_ranking_article, own_listed, own_rank_in_article, media:media(${MEDIA_COLS})`
        )
        .in("snapshot_id", snapIds)
        .order("rank", { ascending: true, nullsFirst: false })
    : { data: [] };
  const entries = (entriesRaw ?? []) as unknown as EntryRow[];

  const entryIds = entries.map((e) => e.id);
  const { data: listingsRaw } = entryIds.length
    ? await sb
        .from("article_listings")
        .select("serp_entry_id, position, service_name, is_own")
        .in("serp_entry_id", entryIds)
        .order("position", { ascending: true, nullsFirst: false })
    : { data: [] };
  const listByEntry = new Map<string, BoardListing[]>();
  for (const l of (listingsRaw ?? []) as (BoardListing & { serp_entry_id: string })[]) {
    const arr = listByEntry.get(l.serp_entry_id) ?? [];
    arr.push(l);
    listByEntry.set(l.serp_entry_id, arr);
  }

  const { data: targetsRaw } = await sb
    .from("outreach_targets")
    .select(`media_id, kind, status, negotiation_note, media:media(${MEDIA_COLS})`)
    .eq("campaign_id", campaignId)
    .order("rank", { ascending: true, nullsFirst: false });
  const targets = (targetsRaw ?? []) as unknown as TargetRow[];
  const targetByMedia = new Map(targets.map((t) => [t.media_id, t]));

  const statusLabel = (s: string | undefined) =>
    s ? (OUTREACH_STATUS[s as keyof typeof OUTREACH_STATUS] ?? s) : "未登録";

  const rows: BoardRow[] = [];
  const keywords: BoardKeyword[] = [];

  for (const k of kws) {
    const snap = latestSnap.get(k.id);
    const mine = snap
      ? entries.filter((e) => e.snapshot_id === snap.id && e.is_ranking_article)
      : [];
    keywords.push({
      id: k.id,
      keyword: k.keyword,
      snapshotId: snap?.id ?? null,
      collectedAt: snap?.collected_at ?? null,
      count: mine.length,
    });

    for (const e of mine) {
      const m = e.media;
      const t = m ? targetByMedia.get(m.id) : undefined;
      const { top, overflow } = toSlots(listByEntry.get(e.id) ?? []);
      rows.push({
        no: rows.length + 1,
        date: fmtDate(snap?.collected_at),
        keyword: k.keyword,
        rank: e.rank,
        entryId: e.id,
        mediaId: m?.id ?? null,
        mediaName: m?.name || m?.domain || "",
        mediaDomain: m?.domain ?? "",
        articleUrl: e.article_url,
        articleTitle: e.article_title,
        listed: e.own_listed,
        ownRankInArticle: e.own_rank_in_article,
        asp: aspOf(m),
        status: t?.status ?? "",
        statusLabel: statusLabel(t?.status),
        note: noteOf(m, t?.negotiation_note),
        top,
        overflow,
        unmatched: false,
      });
    }
  }

  // --- 検索結果に紐づかない候補メディア（掲載候補シート由来など）を同じ表の末尾に足す ---
  const serpMediaIds = new Set(entries.map((e) => e.media_id).filter(Boolean) as string[]);
  const unmatchedTargets = targets.filter((t) => t.media_id && !serpMediaIds.has(t.media_id));
  for (const t of unmatchedTargets) {
    const m = t.media;
    rows.push({
      no: rows.length + 1,
      date: "",
      keyword: "（検索結果に紐づかない候補）",
      rank: null,
      entryId: `unmatched-${t.media_id}`,
      mediaId: t.media_id,
      mediaName: m?.name || m?.domain || "",
      mediaDomain: m?.domain ?? "",
      articleUrl: "",
      articleTitle: "",
      listed: false,
      ownRankInArticle: null,
      asp: aspOf(m),
      status: t.status,
      statusLabel: statusLabel(t.status),
      note: noteOf(m, t.negotiation_note),
      top: Array(10).fill(null),
      overflow: 0,
      unmatched: true,
    });
  }

  return { rows, keywords, unmatchedCount: unmatchedTargets.length };
}

/** 1行を EXCEL_COLUMNS の順に並べる（xlsx / CSV 共通） */
export function rowToCells(r: BoardRow): (string | number | null)[] {
  return [
    r.no,
    r.date,
    r.keyword,
    r.rank,
    r.mediaName,
    r.articleUrl,
    r.unmatched ? "" : r.listed ? "あり" : "なし",
    r.asp,
    r.statusLabel,
    r.note,
    ...r.top.map((l) => (l ? l.service_name : "")),
  ];
}
