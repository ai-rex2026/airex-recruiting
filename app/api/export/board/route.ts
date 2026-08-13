import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import {
  buildBoardData,
  loadCampaignBrief,
  rowToCells,
  EXCEL_COLUMNS,
  SLOT_COL_START,
  type BoardRow,
  type CampaignBrief,
} from "@/lib/board-data";
import { buildXlsx, buildCsv, colName, XS, type XlsxCell, type XlsxSheet } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

const COL = {
  no: 0,
  rank: 3,
  url: 5,
  listed: 6,
} as const;

/** 案件カルテの1項目を、表の何列ぶんに割り当てるか（列幅が表と共通なので結合で調整する） */
const BRIEF_FIELDS: { label: string; span: number; get: (b: CampaignBrief) => string }[] = [
  { label: "案件名", span: 3, get: (b) => [b.name, b.clientName && `（${b.clientName}）`].filter(Boolean).join("") },
  { label: "ジャンル", span: 2, get: (b) => b.genre || b.productName },
  { label: "報酬条件", span: 1, get: (b) => b.unitPrice },
  { label: "成果地点", span: 2, get: (b) => b.conversionPoint },
  { label: "承認条件", span: 2, get: (b) => b.approvalTerms },
  { label: "LP", span: 2, get: (b) => b.lpUrl },
  { label: "入稿URL", span: 1, get: (b) => b.draftUrl },
  { label: "参考URL", span: 2, get: (b) => b.referenceUrl },
  { label: "交渉サマリ", span: 4, get: (b) => b.summaryText },
  { label: "訴求ポイント", span: 4, get: (b) => b.sellingPoints },
];

/**
 * 1枚目の表の上に置く案件カルテ。元の運用エクセルと同じく「見出し行 → 値行」の形にし、
 * 列幅が表と共通なため各項目を結合セルで必要な幅に広げる。
 * 返す rows は表本体の前に差し込む（headerRow はその行数ぶんずれる）。
 */
function briefBlock(
  b: CampaignBrief,
  nCols: number
): { rows: XlsxCell[][]; merges: string[]; rowHeights: Record<number, number> } {
  const blank = (): XlsxCell[] => Array.from({ length: nCols }, () => ({ v: null }));
  const last = colName(nCols - 1);

  // 1行目：タイトル
  const title = blank();
  title[0] = { v: `案件カルテ｜${b.name}`, s: XS.briefTitle };

  // 2行目：項目名／3行目：値。span ぶん結合する
  const labels = blank();
  const values = blank();
  const merges = [`A1:${last}1`];
  let c = 0;
  for (const f of BRIEF_FIELDS) {
    if (c >= nCols) break;
    const span = Math.min(f.span, nCols - c);
    labels[c] = { v: f.label, s: XS.briefLabel };
    values[c] = { v: f.get(b) || "—", s: XS.briefValue };
    for (let k = 1; k < span; k++) {
      labels[c + k] = { v: null, s: XS.briefLabel };
      values[c + k] = { v: null, s: XS.briefValue };
    }
    if (span > 1) {
      merges.push(`${colName(c)}2:${colName(c + span - 1)}2`);
      merges.push(`${colName(c)}3:${colName(c + span - 1)}3`);
    }
    c += span;
  }

  // 4行目：案件カルテ本文（全幅ぶち抜き）。行数に応じて高さを取る
  const body = blank();
  body[0] = { v: b.brief || "（案件カルテ未入力）", s: XS.brief };
  merges.push(`A4:${last}4`);
  const lines = (b.brief || "").split("\n").length;
  const bodyHeight = Math.min(600, Math.max(60, lines * 14));

  return {
    rows: [title, labels, values, body, blank()], // 末尾は表との間の空行
    merges,
    rowHeights: { 0: 24, 2: 60, 3: bodyHeight },
  };
}

/** 1行ぶんのセルに書式を当てる。順位なしの行はグレー地＋斜体にして順位ありと見分けられるようにする */
function styleRow(r: BoardRow): XlsxCell[] {
  const dimmed = r.slotKind === "順位なし" || r.slotKind === "枠なし";
  const text = dimmed ? XS.dim : XS.text;
  const num = dimmed ? XS.dimNum : XS.num;

  return rowToCells(r).map((v, i) => {
    // 1位〜10位は自社の枠だけブランド色で強調（順位なし行ではそもそも空）
    if (i >= SLOT_COL_START) {
      return { v, s: r.top[i - SLOT_COL_START]?.is_own ? XS.own : text };
    }
    if (i === COL.no || i === COL.rank) return { v, s: num };
    if (i === COL.url) return { v, s: v ? XS.link : text };
    if (i === COL.listed) return { v, s: r.listed ? XS.own : dimmed ? XS.dim : XS.muted };
    return { v, s: text };
  });
}

/**
 * 陣取り表のエクスポート。
 * GET /api/export/board?campaign={id}&format=xlsx|csv
 *
 * 列は運用エクセル準拠（1行＝1記事、順位の付いた掲載枠を 1位〜10位に横展開）。
 * xlsx は「ランキング記事／順位なし・非該当／紐づかない候補」の3シートに分ける。
 * CSV はシートを持てないので、同じ列で全グループを続けて出力する（記事種別・枠種別で絞り込める）。
 */
export async function GET(req: NextRequest) {
  const { sb, user } = await getSessionProfile();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const campaignId = req.nextUrl.searchParams.get("campaign") ?? "";
  if (!campaignId) return NextResponse.json({ error: "campaign is required" }, { status: 400 });
  const format = req.nextUrl.searchParams.get("format") === "csv" ? "csv" : "xlsx";

  // RLS 越しに読むので、他テナントの案件を指定しても取得できない
  const { data: camp } = await sb
    .from("campaigns")
    .select("id, name")
    .eq("id", campaignId)
    .maybeSingle();
  if (!camp) return NextResponse.json({ error: "campaign not found" }, { status: 404 });

  const [{ grouped }, brief] = await Promise.all([
    buildBoardData(sb, campaignId),
    loadCampaignBrief(sb, campaignId),
  ]);

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const ext = format === "csv" ? "csv" : "xlsx";
  const niceName = `jindori_${String(camp.name).replace(/[\\/:*?"<>|\s]+/g, "_")}_${date}.${ext}`;
  const asciiName = `jindori_${campaignId.slice(0, 8)}_${date}.${ext}`;
  const contentDisposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
    niceName
  )}`;

  const labels = EXCEL_COLUMNS.map((c) => c.label);

  if (format === "csv") {
    const rows: (string | number | null)[][] = [];
    if (brief) {
      rows.push([`案件カルテ｜${brief.name}`]);
      for (const f of BRIEF_FIELDS) rows.push([f.label, f.get(brief)]);
      rows.push(["案件カルテ", brief.brief]);
      rows.push([]);
    }
    rows.push(labels);
    for (const g of grouped) {
      if (!g.rows.length) continue;
      rows.push([]); // 空行でグループを分ける
      rows.push([`【${g.sheet}】${g.desc}`]);
      for (const r of g.rows) rows.push(rowToCells(r));
    }
    return new NextResponse(buildCsv(rows) as BodyInit, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": contentDisposition,
        "cache-control": "no-store",
      },
    });
  }

  const header: XlsxCell[] = labels.map((v) => ({ v, s: XS.header }));
  const sheets: XlsxSheet[] = grouped.map((g, i) => {
    // 案件カルテは1枚目だけ。2枚目以降に同じ内容を重複させない
    const block = i === 0 && brief ? briefBlock(brief, EXCEL_COLUMNS.length) : null;
    const lead = block?.rows ?? [];
    return {
      name: g.sheet,
      cols: EXCEL_COLUMNS.map((c) => c.width),
      rows: [...lead, header, ...g.rows.map(styleRow)],
      headerRow: lead.length,
      merges: block?.merges,
      rowHeights: block?.rowHeights,
    };
  });

  return new NextResponse(buildXlsx(sheets) as BodyInit, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": contentDisposition,
      "cache-control": "no-store",
    },
  });
}
