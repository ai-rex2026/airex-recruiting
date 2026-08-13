import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import EnrichButton from "@/components/EnrichButton";
import { Card, Empty, Badge, btnSmall } from "@/components/ui";
import { statusTone } from "@/lib/domain";
import { buildBoardData, EXCEL_COLUMNS } from "@/lib/board-data";

function fmt(dt: string | null | undefined): string {
  return dt ? new Date(dt).toLocaleString("ja-JP") : "—";
}

/** セル共通。sticky と border-collapse は相性が悪いので境界線はセル側に持たせる */
const cell = "border-b border-r border-slate-200 px-2 py-1.5 align-top";
const head =
  "sticky top-0 z-20 border-b border-r border-[#2b3f68] bg-[#1B2A4A] px-2 py-2 text-[11px] font-semibold text-white whitespace-nowrap";

/**
 * 陣取りボード本体（サーバーコンポーネント）：運用エクセルと同じ列並びの1枚表。
 * 1行＝「KW × 検索結果の記事」で、記事内の掲載枠を 1位〜10位の列に展開する。
 * 末尾に検索結果と紐づかない候補メディアが続く。/board と /campaigns/[id]?tab=board の両方から使う。
 */
export default async function BoardView({ campaignId }: { campaignId: string }) {
  const { sb } = await getSessionProfile();
  const { rows, keywords, unmatchedCount } = await buildBoardData(sb, campaignId);

  if (!keywords.length && !rows.length) {
    return (
      <Empty>
        この案件にはまだキーワードも収集結果もありません。
        <Link href={`/campaigns/${campaignId}?tab=collect`} className="ml-1 underline">
          収集状況
        </Link>
        から始めてください。
      </Empty>
    );
  }

  const placedCount = rows.filter((r) => r.listed).length;
  const exportBase = `/api/export/board?campaign=${campaignId}`;

  return (
    <Card
      title="陣取り表"
      desc={`全 ${rows.length} 行（自社掲載 ${placedCount} 件${
        unmatchedCount ? ` ／ 検索結果に紐づかない候補 ${unmatchedCount} 件を末尾に収録` : ""
      }）／運用エクセルと同じ列並び`}
      action={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <a href={`${exportBase}&format=xlsx`} className={btnSmall}>
            Excel（.xlsx）
          </a>
          <a href={`${exportBase}&format=csv`} className={btnSmall}>
            CSV
          </a>
          <Link href={`/campaigns/${campaignId}?tab=collect`} className={btnSmall}>
            再収集
          </Link>
        </div>
      }
    >
      {/* KWごとの取得状況と掲載枠の再抽出 */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {keywords.map((k) => (
          <span
            key={k.id}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
          >
            <span className="font-semibold text-[#1B2A4A]">{k.keyword}</span>
            <span className="text-slate-400">
              {k.collectedAt ? `${fmt(k.collectedAt)}／${k.count}件` : "未収集"}
            </span>
            {k.snapshotId && <EnrichButton snapshotId={k.snapshotId} />}
          </span>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty>
          ランキング/比較記事がまだありません。
          <Link href={`/campaigns/${campaignId}?tab=collect`} className="ml-1 underline">
            収集状況
          </Link>
          から収集してください。
        </Empty>
      ) : (
        <>
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200">
            <table className="w-max border-separate border-spacing-0 text-[11px]">
              <thead>
                <tr>
                  <th className={`${head} left-0 z-30 w-12 text-right`}>No.</th>
                  {EXCEL_COLUMNS.slice(1).map((c) => (
                    <th key={c.key} className={head}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  // KWが切り替わる行に太い区切りを入れて、エクセルの塊を目で追えるようにする
                  const top =
                    i > 0 && rows[i - 1].keyword !== r.keyword
                      ? "border-t-2 border-t-[#1B2A4A]"
                      : "";
                  return (
                    <tr key={r.entryId} className="group bg-white hover:bg-sky-50/60">
                      <td
                        className={`${cell} ${top} sticky left-0 z-10 bg-white text-right tabular-nums text-slate-400 group-hover:bg-sky-50`}
                      >
                        {r.no}
                      </td>
                      <td className={`${cell} ${top} whitespace-nowrap text-slate-500`}>
                        {r.date || "—"}
                      </td>
                      <td
                        className={`${cell} ${top} whitespace-nowrap font-medium ${
                          r.unmatched ? "text-slate-400" : "text-[#1B2A4A]"
                        }`}
                      >
                        {r.keyword}
                      </td>
                      <td className={`${cell} ${top} text-right tabular-nums font-bold text-[#1B2A4A]`}>
                        {r.rank ?? "—"}
                      </td>
                      <td className={`${cell} ${top} max-w-44`}>
                        {r.mediaId ? (
                          <Link
                            href={`/media/${r.mediaId}`}
                            className="font-medium text-slate-800 hover:underline"
                          >
                            {r.mediaName}
                          </Link>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                        {r.mediaDomain && (
                          <div className="truncate text-[10px] text-slate-400">{r.mediaDomain}</div>
                        )}
                      </td>
                      <td className={`${cell} ${top} max-w-64`}>
                        {r.articleUrl ? (
                          <a
                            href={r.articleUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-sky-700 underline"
                            title={r.articleTitle || r.articleUrl}
                          >
                            {r.articleUrl}
                          </a>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className={`${cell} ${top} whitespace-nowrap`}>
                        {r.unmatched ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <span
                            className={`inline-flex items-center rounded border px-1.5 py-0.5 ${
                              r.listed
                                ? "border-emerald-200 bg-emerald-50 font-semibold text-emerald-800"
                                : "border-slate-200 bg-slate-50 text-slate-500"
                            }`}
                          >
                            {r.listed ? "あり" : "なし"}
                            {r.listed && r.ownRankInArticle ? `（${r.ownRankInArticle}位）` : ""}
                          </span>
                        )}
                      </td>
                      <td className={`${cell} ${top} whitespace-nowrap text-slate-600`}>
                        {r.asp || "—"}
                      </td>
                      <td className={`${cell} ${top} whitespace-nowrap`}>
                        <Badge tone={r.status ? statusTone(r.status) : "bg-white text-slate-400"}>
                          {r.statusLabel}
                        </Badge>
                      </td>
                      <td className={`${cell} ${top} max-w-56 text-slate-600`}>
                        {r.note ? (
                          <span className="line-clamp-2" title={r.note}>
                            {r.note}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      {r.top.map((l, j) => (
                        <td
                          key={j}
                          className={`${cell} ${top} max-w-40 truncate ${
                            l?.is_own ? "bg-[#FDECE8] font-bold text-[#C1553B]" : "text-slate-700"
                          }`}
                          title={l?.service_name ?? ""}
                        >
                          {l?.service_name || (j === 9 && r.overflow > 0 ? `他${r.overflow}件` : "")}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            1位〜10位は記事内の掲載枠。
            <span className="mx-1 rounded bg-[#FDECE8] px-1 font-bold text-[#C1553B]">この色</span>
            が自社サービスです。ダウンロードは同じ列並びで出力されます。
          </p>
        </>
      )}
    </Card>
  );
}
