import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import EnrichButton from "@/components/EnrichButton";
import { Card, Empty, Badge, btnSmall } from "@/components/ui";

type Listing = { serp_entry_id: string; position: number | null; service_name: string; is_own: boolean };

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

function fmt(dt: string | null | undefined): string {
  return dt ? new Date(dt).toLocaleString("ja-JP") : "—";
}

function trunc(s: string, n = 10): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 記事内の掲載枠：1位〜5位の固定枠グリッド（Excelの陣取り表と同じ形）。
 * - 順位付きランキング記事 → 各順位セルに占有サービス名。競合＝グレー背景、自社＝ブランド色の背景（取った陣）
 * - 6位〜 → 「+他n」。自社が6位以下なら「自社n位」をブランド色で表示
 * - 順位のない掲載リスト → 5枠ぶち抜きでラベル＋全サービス名のカンマ列挙
 */
function RankCells({ listings }: { listings: Listing[] }) {
  const ranked = listings.some((l) => l.position != null);

  // 順位なし（掲載リストのみ）／掲載枠情報なし → 5枠ぶち抜き
  if (!ranked) {
    return (
      <>
        <td className="px-1 py-2" colSpan={5}>
          {listings.length === 0 ? (
            <span className="text-[11px] text-slate-400">—</span>
          ) : (
            <span className="text-[11px] leading-relaxed text-slate-600">
              <span className="mr-1.5 inline-block whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                掲載リスト（順位なし）
              </span>
              {listings.map((l, i) => (
                <span key={i}>
                  {i > 0 && "、"}
                  <span className={l.is_own ? "font-bold text-[#C1553B]" : ""}>{l.service_name}</span>
                </span>
              ))}
            </span>
          )}
        </td>
        <td className="px-1 py-2"></td>
      </>
    );
  }

  const byPos = new Map<number, Listing>();
  for (const l of listings)
    if (l.position != null && l.position >= 1 && l.position <= 5 && !byPos.has(l.position))
      byPos.set(l.position, l);
  const shown = new Set([...byPos.values()]);
  const rest = listings.filter((l) => !shown.has(l));
  const ownBeyond = rest.find((l) => l.is_own && l.position != null);
  const otherCount = ownBeyond ? rest.length - 1 : rest.length;

  return (
    <>
      {[1, 2, 3, 4, 5].map((p) => {
        const l = byPos.get(p);
        return (
          <td key={p} className="px-1 py-1.5 align-middle">
            {l ? (
              <div
                title={l.service_name}
                className={`truncate rounded px-1.5 py-1 text-center text-[11px] ${
                  l.is_own ? "bg-[#C1553B] font-bold text-white" : "bg-slate-100 font-medium text-slate-700"
                }`}
              >
                {trunc(l.service_name)}
              </div>
            ) : (
              <div className="rounded border border-dashed border-slate-200 px-1.5 py-1 text-center text-[11px] text-slate-300">
                &nbsp;
              </div>
            )}
          </td>
        );
      })}
      <td className="px-1 py-1.5 text-center align-middle">
        {ownBeyond && (
          <div className="whitespace-nowrap text-[11px] font-bold text-[#C1553B]">
            自社{ownBeyond.position}位
          </div>
        )}
        {otherCount > 0 && <div className="whitespace-nowrap text-[10px] text-slate-400">+他{otherCount}</div>}
      </td>
    </>
  );
}

/**
 * 陣取りボード本体（サーバーコンポーネント）：KW軸のマトリクス表示。
 * KWごとに最新スナップショットのランキング/比較記事を「検索順位 × 記事内の掲載枠 × 自社掲載」で並べる。
 * /board と /campaigns/[id]?tab=board の両方から使う。
 */
export default async function BoardView({ campaignId }: { campaignId: string }) {
  const { sb } = await getSessionProfile();

  // --- KW と 最新スナップショット ---
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

  // --- 最新スナップショットの記事（メディア込み）と記事内掲載枠 ---
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

  const entryIds = entries.map((e) => e.id);
  const { data: listingsRaw } = entryIds.length
    ? await sb
        .from("article_listings")
        .select("serp_entry_id, position, service_name, is_own")
        .in("serp_entry_id", entryIds)
        .order("position", { ascending: true, nullsFirst: false })
    : { data: [] };
  const listByEntry = new Map<string, Listing[]>();
  for (const l of (listingsRaw ?? []) as Listing[]) {
    const arr = listByEntry.get(l.serp_entry_id) ?? [];
    arr.push(l);
    listByEntry.set(l.serp_entry_id, arr);
  }

  const entriesBySnap = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const arr = entriesBySnap.get(e.snapshot_id) ?? [];
    arr.push(e);
    entriesBySnap.set(e.snapshot_id, arr);
  }
  const snapMediaIds = new Set(entries.map((e) => e.media_id).filter(Boolean) as string[]);

  // --- この案件の打診対象（検索結果に紐づかない候補メディアの抽出に使う） ---
  const { data: targets } = await sb
    .from("outreach_targets")
    .select("*, media:media(*), campaign:campaigns(name)")
    .eq("campaign_id", campaignId)
    .order("rank", { ascending: true, nullsFirst: false });

  if (!(kws ?? []).length && !(targets ?? []).length) {
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

  // --- 検索結果に紐づかない候補メディア（掲載候補シート由来など） ---
  const unmatched = (targets ?? []).filter((t) => !snapMediaIds.has(t.media_id));

  return (
    <>
      {/* ===== エクスポート ===== */}
      <div className="flex justify-end">
        <a href={`/api/export/board?campaign=${campaignId}`} className={btnSmall}>
          CSVダウンロード
        </a>
      </div>

      {/* ===== KW軸の陣取り表 ===== */}
      {(kws ?? []).map((k) => {
        const snap = latestSnap.get(k.id);
        const rows = snap ? (entriesBySnap.get(snap.id) ?? []).filter((e) => e.is_ranking_article) : [];
        return (
          <Card
            key={k.id}
            title={`KW：${k.keyword}`}
            desc={
              snap
                ? `取得日時：${fmt(snap.collected_at)} ／ ランキング・比較記事 ${rows.length}件`
                : "未収集"
            }
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                {snap && <EnrichButton snapshotId={snap.id} />}
                <Link href={`/campaigns/${campaignId}?tab=collect`} className={btnSmall}>
                  再収集
                </Link>
              </div>
            }
          >
            {!snap ? (
              <Empty>
                まだ収集していません。
                <Link href={`/campaigns/${campaignId}?tab=collect`} className="ml-1 underline">
                  収集状況
                </Link>
                から実行してください。
              </Empty>
            ) : rows.length === 0 ? (
              <Empty>このキーワードではランキング/比較記事が見つかりませんでした。</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl w-full min-w-[1200px] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-slate-500">
                      <th className="w-12 pb-2 text-right">検索順位</th>
                      <th className="w-40 pb-2">メディア</th>
                      <th className="w-48 pb-2">記事</th>
                      {[1, 2, 3, 4, 5].map((p) => (
                        <th key={p} className="w-28 pb-2 text-center">
                          {p}位
                        </th>
                      ))}
                      <th className="w-16 pb-2 text-center">6位〜</th>
                      <th className="w-28 pb-2">自社掲載</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => {
                      return (
                        <tr key={e.id}>
                          <td className="py-2 text-right font-semibold text-[#1B2A4A]">
                            {e.rank ?? "—"}
                          </td>
                          <td className="py-2">
                            {e.media ? (
                              <>
                                <Link href={`/media/${e.media.id}`} className="font-medium hover:underline">
                                  {e.media.name || e.media.domain}
                                </Link>
                                <div className="text-[11px] text-slate-400">{e.media.domain}</div>
                              </>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="py-2 text-xs text-slate-700">
                            <div className="max-w-56 truncate" title={e.article_title}>
                              {e.article_title || "—"}
                            </div>
                            {e.article_url && (
                              <a
                                href={e.article_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-sky-700 underline"
                              >
                                記事を開く
                              </a>
                            )}
                          </td>
                          <RankCells listings={listByEntry.get(e.id) ?? []} />
                          <td className="py-2">
                            {e.own_listed ? (
                              <div>
                                <Badge tone="bg-emerald-100 text-emerald-800">
                                  掲載中{e.own_rank_in_article ? `（${e.own_rank_in_article}位）` : ""}
                                </Badge>
                                <div className="text-[10px] text-slate-400">リプレイス打診対象</div>
                              </div>
                            ) : (
                              <div>
                                <Badge tone="bg-slate-100 text-slate-600">未掲載</Badge>
                                <div className="text-[10px] text-slate-400">新規打診対象</div>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}

      {/* ===== 検索結果に紐づかない候補メディア（閲覧専用） ===== */}
      {unmatched.length > 0 && (
        <Card
          title={`検索結果に紐づかない候補メディア（${unmatched.length}件）`}
          desc="最新の収集結果には現れていないが、候補として登録されているメディア（掲載候補シート由来など）"
        >
          <table className="tbl w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">メディア</th>
                <th className="pb-2">備考</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((t) => {
                const m = t.media as unknown as Record<string, string | boolean> | null;
                const name = (m?.name as string) || (m?.domain as string) || "—";
                return (
                  <tr key={t.id}>
                    <td className="py-2">
                      <Link href={`/media/${t.media_id}`} className="font-medium hover:underline">
                        {name}
                      </Link>
                      {m?.domain ? (
                        <div className="text-[11px] text-slate-400">{m.domain as string}</div>
                      ) : null}
                    </td>
                    <td className="py-2 text-xs text-slate-500">
                      {t.kind === "replace" ? "リプレイス" : "新規"}
                      {m?.no_solicitation ? "／営業お断り（台帳フラグ）" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
