import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/supabase/server";
import { buildBoardData, rowToCells, EXCEL_COLUMNS } from "@/lib/board-data";
import { buildXlsx, buildCsv, XS, type XlsxCell } from "@/lib/xlsx";

export const dynamic = "force-dynamic";

/**
 * 陣取り表のエクスポート。
 * GET /api/export/board?campaign={id}&format=xlsx|csv
 * 運用エクセルと同じ列並び（1行＝1記事、記事内の掲載枠を 1位〜10位に横展開）で出力する。
 * 末尾に「検索結果に紐づかない候補メディア」の行が続く。
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

  const { rows } = await buildBoardData(sb, campaignId);

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const ext = format === "csv" ? "csv" : "xlsx";
  const niceName = `jindori_${String(camp.name).replace(/[\\/:*?"<>|\s]+/g, "_")}_${date}.${ext}`;
  const asciiName = `jindori_${campaignId.slice(0, 8)}_${date}.${ext}`;
  const contentDisposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
    niceName
  )}`;

  if (format === "csv") {
    const body = buildCsv([EXCEL_COLUMNS.map((c) => c.label), ...rows.map(rowToCells)]);
    return new NextResponse(body as BodyInit, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": contentDisposition,
        "cache-control": "no-store",
      },
    });
  }

  const header: XlsxCell[] = EXCEL_COLUMNS.map((c) => ({ v: c.label, s: XS.header }));
  const body: XlsxCell[][] = rows.map((r) =>
    rowToCells(r).map((v, i) => {
      // 1位〜10位（11列目以降）は自社の枠だけ色を変える
      if (i >= 10) return { v, s: r.top[i - 10]?.is_own ? XS.own : XS.text };
      if (i === 0 || i === 3) return { v, s: XS.num };
      if (i === 5) return { v, s: v ? XS.link : XS.text };
      if (i === 6) return { v, s: r.listed ? XS.own : XS.muted };
      return { v, s: XS.text };
    })
  );

  const file = buildXlsx({
    name: "陣取り表",
    cols: EXCEL_COLUMNS.map((c) => c.width),
    rows: [header, ...body],
  });

  return new NextResponse(file as BodyInit, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": contentDisposition,
      "cache-control": "no-store",
    },
  });
}
