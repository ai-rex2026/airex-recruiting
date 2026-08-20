import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import EnrichButton from "@/components/EnrichButton";
import { Card, Empty, Badge, btnSmall } from "@/components/ui";
import { statusTone } from "@/lib/domain";
import {
  buildBoardData,
  loadCampaignBrief,
  EXCEL_COLUMNS,
  type BoardRow,
  type CampaignBrief,
} from "@/lib/board-data";

function fmt(dt: string | null | undefined): string {
  return dt ? new Date(dt).toLocaleString("ja-JP") : "—";
}

/** セル共通。sticky と border-collapse は相性が悪いので境界線はセル側に持たせる */
const cell = "overflow-hidden border-b border-r border-slate-200 px-2 py-1.5 align-top";
const head =
  "sticky top-0 z-20 border-b border-r border-[#2b3f68] bg-[#1B2A4A] px-2 py-2 text-[11px] font-semibold text-white whitespace-nowrap";

/**
 * 陣取りボード本体（サーバーコンポーネント）：運用エクセルと同じ列並びの表。
 * 1行＝「KW × 検索結果の記事」で、順位の付いた掲載枠だけを 1位〜10位の列に展開する。
 * 表はダウンロードの3シートと同じ区分（ランキング／順位なし・非該当／紐づかない候補）で並べる。
 * /board と /campaigns/[id]?tab=board の両方から使う。
 */
export default async function BoardView({ campaignId }: { campaignId: string }) {
  const { sb } = await getSessionProfile();
  const [{ grouped, keywords, total }, brief] = await Promise.all([
    buildBoardData(sb, campaignId),
    loadCampaignBrief(sb, campaignId),
  ]);

  if (!keywords.length && !total) {
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

  const placedCount = grouped.flatMap((g) => g.rows).filter((r) => r.listed).length;
  const exportBase = `/api/export/board?campaign=${campaignId}`;

  return (
    <Card
      title="陣取り表"
      desc={`全 ${total} 行（自社掲載 ${placedCount} 件）／運用エクセルと同じ列並び。ダウンロードは下の区分がそのままシートになります`}
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
      {brief && <BriefPanel brief={brief} campaignId={campaignId} />}

      {/* KWごとの取得状況と掲載枠の再抽出 */}
      <div className="mb-4 flex flex-wrap gap-1.5">
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

      {total === 0 ? (
        <Empty>
          収集結果がまだありません。
          <Link href={`/campaigns/${campaignId}?tab=collect`} className="ml-1 underline">
            収集状況
          </Link>
          から収集してください。
        </Empty>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => (
            <section key={g.id}>
              <h3 className="text-xs font-bold text-[#1B2A4A]">
                {g.sheet}
                <span className="ml-1.5 font-normal text-slate-400">{g.rows.length}件</span>
              </h3>
              <p className="mt-0.5 mb-1.5 text-[11px] text-slate-500">{g.desc}</p>
              {g.rows.length === 0 ? (
                <Empty>該当なし。</Empty>
              ) : (
                <BoardTable rows={g.rows} />
              )}
            </section>
          ))}
          <p className="text-[11px] text-slate-400">
            1位〜10位は<strong>順位が付いている掲載枠だけ</strong>を入れています。
            <span className="mx-1 rounded bg-[#FDECE8] px-1 font-bold text-[#C1553B]">この色</span>
            が自社サービス。順位の付かない掲載は
            <span className="mx-1 rounded bg-slate-100 px-1 italic text-slate-500">グレーの行</span>
            として区別し、掲載サービスは備考に全件カンマ区切りで載せています。
          </p>
        </div>
      )}
    </Card>
  );
}

/**
 * 案件カルテ。エクセル1枚目の表の上に出るヘッダーブロックと同じ内容を画面にも置く。
 * 本文は長くなるので details で畳んでおく。
 */
function BriefPanel({ brief, campaignId }: { brief: CampaignBrief; campaignId: string }) {
  const fields: { label: string; value: string; link?: boolean }[] = [
    { label: "案件名", value: [brief.name, brief.clientName && `（${brief.clientName}）`].filter(Boolean).join("") },
    { label: "ジャンル", value: brief.genre || brief.productName },
    { label: "報酬条件", value: brief.unitPrice },
    { label: "成果地点", value: brief.conversionPoint },
    { label: "承認条件", value: brief.approvalTerms },
    { label: "LP", value: brief.lpUrl, link: true },
    { label: "入稿URL", value: brief.draftUrl, link: true },
    { label: "参考URL", value: brief.referenceUrl, link: true },
  ];

  return (
    <div className="mb-4 rounded-lg border border-[#F0D9C8] bg-[#FDF7F2]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F0D9C8] px-3 py-2">
        <h3 className="text-xs font-bold text-[#1B2A4A]">案件カルテ</h3>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-600">{brief.summaryText}</span>
          <Link href={`/campaigns/${campaignId}?tab=info`} className={btnSmall}>
            編集
          </Link>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2.5 text-[11px] md:grid-cols-4">
        {fields.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[10px] font-semibold text-slate-500">{f.label}</dt>
            <dd className="truncate text-slate-800" title={f.value}>
              {f.value ? (
                f.link ? (
                  <a href={f.value} target="_blank" rel="noreferrer" className="text-sky-700 underline">
                    {f.value}
                  </a>
                ) : (
                  f.value
                )
              ) : (
                <span className="text-slate-300">—</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {(brief.sellingPoints || brief.brief) && (
        <details className="border-t border-[#F0D9C8] px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">
            訴求ポイント・ターゲット定義を開く
          </summary>
          {brief.sellingPoints && (
            <p className="mt-2 text-[11px] whitespace-pre-wrap text-slate-700">{brief.sellingPoints}</p>
          )}
          {brief.brief && (
            <pre className="mt-2 max-h-80 overflow-auto rounded border border-slate-200 bg-white p-2 text-[11px] whitespace-pre-wrap text-slate-700">
              {brief.brief}
            </pre>
          )}
        </details>
      )}
    </div>
  );
}

/** エクセルの列幅（文字数）を画面の px に写す。3つの表で列位置を揃えるために固定幅で引く */
const colPx = (w: number) => Math.round(w * 7.5) + 16;
const TABLE_PX = EXCEL_COLUMNS.reduce((a, c) => a + colPx(c.width), 0);

/** エクセルと同じ列並びの表。ヘッダー固定＋No.列を左固定して横スクロールでも位置を見失わないようにする */
function BoardTable({ rows }: { rows: BoardRow[] }) {
  return (
    <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-200">
      <table
        className="table-fixed border-separate border-spacing-0 text-[11px]"
        style={{ width: TABLE_PX }}
      >
        <colgroup>
          {EXCEL_COLUMNS.map((c) => (
            <col key={c.key} style={{ width: colPx(c.width) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className={`${head} left-0 z-30 text-right`}>No.</th>
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
              i > 0 && rows[i - 1].keyword !== r.keyword ? "border-t-2 border-t-[#1B2A4A]" : "";
            // 順位なし・枠なしはグレー地＋斜体（xlsx の書式と揃える）
            const dim = r.slotKind === "順位なし" || r.slotKind === "枠なし";
            const rowBg = dim ? "bg-slate-50 italic" : "bg-white";
            const stickyBg = dim ? "bg-slate-50" : "bg-white";
            return (
              <tr key={r.entryId} className={`group ${rowBg} hover:bg-sky-50/60`}>
                <td
                  className={`${cell} ${top} sticky left-0 z-10 ${stickyBg} text-right tabular-nums not-italic text-slate-400 group-hover:bg-sky-50`}
                >
                  {r.no}
                </td>
                <td className={`${cell} ${top} whitespace-nowrap text-slate-500`}>
                  {r.date || "—"}
                </td>
                <td className={`${cell} ${top} whitespace-nowrap font-medium text-[#1B2A4A]`}>
                  {r.keyword || "—"}
                </td>
                <td className={`${cell} ${top} text-right tabular-nums font-bold text-[#1B2A4A]`}>
                  {r.rank ?? "—"}
                </td>
                <td className={`${cell} ${top} whitespace-nowrap`}>
                  {r.resultType ? (
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 not-italic ${
                        r.resultType === "paid"
                          ? "border-orange-300 bg-orange-50 font-semibold text-orange-800"
                          : "border-sky-200 bg-sky-50 text-sky-800"
                      }`}
                    >
                      {r.resultTypeLabel}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className={`${cell} ${top}`}>
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
                <td className={`${cell} ${top}`}>
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
                  {r.group === "candidate" ? (
                    <span className="text-slate-300">—</span>
                  ) : (
                    <span
                      className={`inline-flex items-center rounded border px-1.5 py-0.5 not-italic ${
                        r.listed
                          ? "border-emerald-200 bg-emerald-50 font-semibold text-emerald-800"
                          : "border-slate-200 bg-white text-slate-500"
                      }`}
                    >
                      {r.listed ? "あり" : "なし"}
                      {r.listed && r.ownRankInArticle ? `（${r.ownRankInArticle}位）` : ""}
                    </span>
                  )}
                </td>
                <td className={`${cell} ${top} whitespace-nowrap text-slate-600`}>
                  {r.articleKind || "—"}
                </td>
                <td className={`${cell} ${top} whitespace-nowrap`}>
                  {r.slotKind ? (
                    <span
                      className={`not-italic ${
                        r.slotKind === "順位あり" ? "text-slate-600" : "font-semibold text-amber-700"
                      }`}
                    >
                      {r.slotKind}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className={`${cell} ${top} whitespace-nowrap text-slate-600`}>
                  {r.asp || "—"}
                </td>
                <td className={`${cell} ${top} whitespace-nowrap not-italic`}>
                  <Badge tone={r.status ? statusTone(r.status) : "bg-white text-slate-400"}>
                    {r.statusLabel}
                  </Badge>
                </td>
                <td className={`${cell} ${top} text-slate-600`}>
                  {r.services ? (
                    <span className="line-clamp-2" title={r.services}>
                      {r.services}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={`${cell} ${top} text-slate-600`}>
                  {r.mediaNote ? (
                    <span className="line-clamp-2" title={r.mediaNote}>
                      {r.mediaNote}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                {r.top.map((l, j) => (
                  <td
                    key={j}
                    className={`${cell} ${top} truncate ${
                      l?.is_own ? "bg-[#FDECE8] font-bold not-italic text-[#C1553B]" : "text-slate-700"
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
  );
}
