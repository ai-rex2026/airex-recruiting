import type { createClient } from "@/lib/supabase/server";
import { OUTREACH_STATUS } from "@/lib/domain";

type Sb = Awaited<ReturnType<typeof createClient>>;

export type BoardListing = { position: number | null; service_name: string; is_own: boolean };

/** 記事の種類。ランキング/比較記事かどうかは収集時のAI判定（serp_entries.is_ranking_article） */
export type ArticleKind = "ランキング/比較" | "非該当" | "";

/**
 * 記事内の掲載枠の付き方。
 * 順位あり＝1位2位…と順序が付いている／順位なし＝掲載リストだけで順序が無い／枠なし＝枠を抽出できていない
 */
export type SlotKind = "順位あり" | "順位なし" | "枠なし" | "";

/**
 * 検索結果の枠。paid = スポンサー広告（お金を払って出している枠）／organic = 通常の検索結果。
 * 打診の意味が変わる（広告枠に出しているランキングサイトは自前で集客している）ので必ず区別する。
 */
export type ResultType = "paid" | "organic" | "";

export const RESULT_TYPE_LABEL: Record<string, string> = {
  paid: "スポンサー広告",
  organic: "オーガニック",
};

/** 出力先グループ。xlsx ではシート、画面では表のセクションに対応する */
export type BoardGroup = "ranking" | "sponsored" | "other" | "candidate";

/** 陣取りボード1行 ＝ 運用エクセルの1行（KW × 記事） */
export type BoardRow = {
  no: number;
  date: string; // 日付（収集日）
  keyword: string; // KW
  rank: number | null; // 検索順位（スポンサー広告なら広告枠内の順番）
  resultType: ResultType; // 検索枠（スポンサー広告／オーガニック）
  resultTypeLabel: string;
  entryId: string;
  mediaId: string | null;
  mediaName: string; // サイト名
  mediaDomain: string;
  articleUrl: string; // サイトURL
  articleTitle: string;
  listed: boolean; // 掲載有無
  ownRankInArticle: number | null;
  articleKind: ArticleKind; // 記事種別
  slotKind: SlotKind; // 枠種別
  asp: string; // ASP・経路
  status: string; // ステータス（内部キー。未登録は ""）
  statusLabel: string;
  services: string; // 備考：記事に掲載されているサービスを全件カンマ区切り
  mediaNote: string; // 媒体メモ：営業お断り・媒体メモ・交渉メモ
  /** 記事内の掲載枠 1位〜10位。順位が付いている枠だけを入れる（空きは null） */
  top: (BoardListing | null)[];
  /** 1位〜10位に載せきれなかった枠の件数（11位以降・重複） */
  overflow: number;
  group: BoardGroup;
};

export type BoardKeyword = {
  id: string;
  keyword: string;
  snapshotId: string | null;
  collectedAt: string | null;
  count: number;
};

/** ダウンロード（xlsx/CSV）の列定義。画面のヘッダーもこれを使う */
export const EXCEL_COLUMNS: { key: string; label: string; width: number }[] = [
  { key: "no", label: "No.", width: 6 },
  { key: "date", label: "日付", width: 12 },
  { key: "keyword", label: "KW", width: 22 },
  { key: "rank", label: "順位", width: 6 },
  { key: "resultType", label: "検索枠", width: 14 },
  { key: "site", label: "サイト名", width: 20 },
  { key: "url", label: "サイトURL", width: 42 },
  { key: "listed", label: "掲載有無", width: 10 },
  { key: "articleKind", label: "記事種別", width: 14 },
  { key: "slotKind", label: "枠種別", width: 10 },
  { key: "asp", label: "ASP・経路", width: 18 },
  { key: "status", label: "ステータス", width: 14 },
  { key: "services", label: "備考", width: 44 },
  { key: "mediaNote", label: "媒体メモ", width: 26 },
  ...Array.from({ length: 10 }, (_, i) => ({
    key: `p${i + 1}`,
    label: `${i + 1}位`,
    width: 16,
  })),
];

/** 1位〜10位が始まる列インデックス（書式適用と行の組み立てで共有する） */
export const SLOT_COL_START = EXCEL_COLUMNS.findIndex((c) => c.key === "p1");

/** グループごとの出力先シート名と説明 */
export const BOARD_GROUPS: { id: BoardGroup; sheet: string; desc: string }[] = [
  {
    id: "ranking",
    sheet: "ランキング記事",
    desc: "順位が付いているランキング/比較記事。1位〜10位が陣取りの本命",
  },
  {
    id: "sponsored",
    sheet: "スポンサー広告",
    desc: "検索結果の広告枠（スポンサー広告）に出ていたサイト。オーガニックとは別枠で、広告費をかけて露出している",
  },
  {
    id: "other",
    sheet: "順位なし・非該当",
    desc: "順位の付かない掲載リストや、ランキング記事と判定されなかった記事。掲載サービスは備考に全件",
  },
  {
    id: "candidate",
    sheet: "紐づかない候補",
    desc: "最新の収集結果には出ていないが、打診候補として登録されている媒体",
  },
];

/** 陣取り表のヘッダーに出す案件カルテ。エクセル1枚目とボード画面で共有する */
export type CampaignBrief = {
  name: string;
  clientName: string;
  genre: string;
  productName: string;
  lpUrl: string;
  referenceUrl: string;
  draftUrl: string;
  unitPrice: string;
  conversionPoint: string;
  approvalTerms: string;
  sellingPoints: string;
  /** 案件固有の長文（理想のユーザー像・NG層・検索意図・推奨KW 等） */
  brief: string;
  /** 交渉サマリ（打診/返答/掲載の件数。手で数えず既存データから出す） */
  summary: {
    total: number;
    contacted: number;
    replied: number;
    placeable: number;
    placed: number;
  };
  summaryText: string;
};

/** 打診済みとみなすステータス（送信を試みた以降） */
const CONTACTED_STATUSES = [
  "sent",
  "uncertain",
  "exception",
  "replied",
  "negotiating",
  "placeable",
  "placed",
  "reported",
  "rejected",
  "no_reply",
];

/**
 * 案件カルテを読む。件数は outreach_targets / replies から算出するので、
 * 「問い合わせ23件：返答あり3件」のような数字を手で数える必要がない。
 */
export async function loadCampaignBrief(
  sb: Sb,
  campaignId: string
): Promise<CampaignBrief | null> {
  const { data: c } = await sb
    .from("campaigns")
    .select(
      "name, product_name, lp_url, unit_price, conversion_point, approval_terms, selling_points, genre, reference_url, draft_url, brief, client:clients(name)"
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (!c) return null;

  const { data: targets } = await sb
    .from("outreach_targets")
    .select("id, status")
    .eq("campaign_id", campaignId);
  const list = (targets ?? []) as { id: string; status: string }[];

  let replied = 0;
  if (list.length) {
    const { data: reps } = await sb
      .from("replies")
      .select("outreach_target_id")
      .in(
        "outreach_target_id",
        list.map((t) => t.id)
      );
    replied = new Set((reps ?? []).map((r) => r.outreach_target_id)).size;
  }

  const summary = {
    total: list.length,
    contacted: list.filter((t) => CONTACTED_STATUSES.includes(t.status)).length,
    replied,
    placeable: list.filter((t) => t.status === "placeable").length,
    placed: list.filter((t) => ["placed", "reported"].includes(t.status)).length,
  };

  return {
    name: c.name ?? "",
    clientName: (c.client as unknown as { name: string } | null)?.name ?? "",
    genre: c.genre ?? "",
    productName: c.product_name ?? "",
    lpUrl: c.lp_url ?? "",
    referenceUrl: c.reference_url ?? "",
    draftUrl: c.draft_url ?? "",
    unitPrice: c.unit_price ?? "",
    conversionPoint: c.conversion_point ?? "",
    approvalTerms: c.approval_terms ?? "",
    sellingPoints: c.selling_points ?? "",
    brief: c.brief ?? "",
    summary,
    summaryText:
      `打診対象 ${summary.total}件／打診済み ${summary.contacted}件／返答あり ${summary.replied}件` +
      `／掲載可能 ${summary.placeable}件／掲載中 ${summary.placed}件`,
  };
}

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
  result_type: string | null;
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

function mediaNoteOf(m: MediaRow | null, negotiationNote?: string): string {
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

/**
 * 記事内の掲載枠を 1位〜10位のスロットへ割り当てる。
 * 順位が付いていない枠はスロットに入れない（順位を捏造しないため）。順位なしの分は備考に全件載る。
 */
function toSlots(listings: BoardListing[]): {
  top: (BoardListing | null)[];
  overflow: number;
  slotKind: SlotKind;
} {
  const top: (BoardListing | null)[] = Array(10).fill(null);
  if (!listings.length) return { top, overflow: 0, slotKind: "枠なし" };

  const ranked = listings.filter((l) => l.position != null);
  if (!ranked.length) return { top, overflow: 0, slotKind: "順位なし" };

  let placed = 0;
  for (const l of ranked) {
    const p = l.position as number;
    if (p >= 1 && p <= 10 && !top[p - 1]) {
      top[p - 1] = l;
      placed++;
    }
  }
  return { top, overflow: listings.length - placed, slotKind: "順位あり" };
}

/** 記事に載っているサービス名を、順位が分かるものは「n位 名前」として全件カンマ区切りにする */
function servicesOf(listings: BoardListing[]): string {
  return listings
    .slice()
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
    .map((l) => (l.position != null ? `${l.position}位 ${l.service_name}` : l.service_name))
    .join(", ");
}

/**
 * 陣取りボードの表データを組み立てる（BoardView とエクスポートで共有）。
 * KWごとの最新スナップショットの記事を「1行＝1記事」に平たくし、順位の付いた掲載枠だけを
 * 1位〜10位の列へ展開する。行はグループ（ランキング／順位なし・非該当／紐づかない候補）に振り分ける。
 */
export async function buildBoardData(sb: Sb, campaignId: string) {
  const MEDIA_COLS =
    "id, name, domain, asp_name, asp_type, note, no_solicitation, no_solicitation_reason";

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
          `id, snapshot_id, media_id, rank, article_url, article_title, is_ranking_article, result_type, own_listed, own_rank_in_article, media:media(${MEDIA_COLS})`
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
    const mine = snap ? entries.filter((e) => e.snapshot_id === snap.id) : [];
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
      const listings = listByEntry.get(e.id) ?? [];
      const { top, overflow, slotKind } = toSlots(listings);
      const articleKind: ArticleKind = e.is_ranking_article ? "ランキング/比較" : "非該当";
      const resultType: ResultType = e.result_type === "paid" ? "paid" : "organic";
      rows.push({
        no: 0, // グループごとに採番するので後で振り直す
        date: fmtDate(snap?.collected_at),
        keyword: k.keyword,
        rank: e.rank,
        resultType,
        resultTypeLabel: RESULT_TYPE_LABEL[resultType] ?? "",
        entryId: e.id,
        mediaId: m?.id ?? null,
        mediaName: m?.name || m?.domain || "",
        mediaDomain: m?.domain ?? "",
        articleUrl: e.article_url,
        articleTitle: e.article_title,
        listed: e.own_listed,
        ownRankInArticle: e.own_rank_in_article,
        articleKind,
        slotKind,
        asp: aspOf(m),
        status: t?.status ?? "",
        statusLabel: statusLabel(t?.status),
        services: servicesOf(listings),
        mediaNote: mediaNoteOf(m, t?.negotiation_note),
        top,
        overflow,
        // スポンサー広告は「お金で買った枠」なのでオーガニックと混ぜず必ず別シートに分ける。
        // 残りは、順位が付いたランキング記事だけが陣取りの本命で、それ以外は別シートへ回す
        group:
          resultType === "paid"
            ? "sponsored"
            : articleKind === "ランキング/比較" && slotKind === "順位あり"
              ? "ranking"
              : "other",
      });
    }
  }

  // --- 検索結果に紐づかない候補メディア（掲載候補シート由来など） ---
  const serpMediaIds = new Set(entries.map((e) => e.media_id).filter(Boolean) as string[]);
  for (const t of targets.filter((x) => x.media_id && !serpMediaIds.has(x.media_id))) {
    const m = t.media;
    rows.push({
      no: 0,
      date: "",
      keyword: "",
      rank: null,
      resultType: "",
      resultTypeLabel: "",
      entryId: `candidate-${t.media_id}`,
      mediaId: t.media_id,
      mediaName: m?.name || m?.domain || "",
      mediaDomain: m?.domain ?? "",
      articleUrl: "",
      articleTitle: "",
      listed: false,
      ownRankInArticle: null,
      articleKind: "",
      slotKind: "",
      asp: aspOf(m),
      status: t.status,
      statusLabel: statusLabel(t.status),
      services: "",
      mediaNote: mediaNoteOf(m, t.negotiation_note),
      top: Array(10).fill(null),
      overflow: 0,
      group: "candidate",
    });
  }

  // グループごとに No. を 1 から振る（シート＝画面セクションと番号を一致させる）
  const grouped = BOARD_GROUPS.map((g) => {
    const list = rows.filter((r) => r.group === g.id);
    list.forEach((r, i) => (r.no = i + 1));
    return { ...g, rows: list };
  });

  return { grouped, keywords, total: rows.length };
}

/** 1行を EXCEL_COLUMNS の順に並べる（xlsx / CSV 共通） */
export function rowToCells(r: BoardRow): (string | number | null)[] {
  return [
    r.no,
    r.date,
    r.keyword,
    r.rank,
    r.resultTypeLabel,
    r.mediaName,
    r.articleUrl,
    r.group === "candidate" ? "" : r.listed ? "あり" : "なし",
    r.articleKind,
    r.slotKind,
    r.asp,
    r.statusLabel,
    r.services,
    r.mediaNote,
    ...r.top.map((l) => (l ? l.service_name : "")),
  ];
}
