import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { setTargetStatus, generateDrafts } from "@/app/actions";
import { addOutreachTarget } from "@/app/start-actions";
import BulkTable, { type Row } from "@/components/BulkTable";
import { Card, Empty, Badge, btnSmall } from "@/components/ui";
import { OUTREACH_STATUS, statusTone } from "@/lib/domain";
import SubmitButton from "@/components/SubmitButton";

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

/** 記事内の掲載枠（上位サービス）をコンパクトに表示。自社はブランド色で強調 */
function ListingInline({ listings }: { listings: Listing[] }) {
  if (!listings.length) return <span className="text-[11px] text-slate-400">—</span>;
  const shown = listings.slice(0, 8);
  return (
    <span className="text-[11px] leading-relaxed text-slate-600">
      {shown.map((l, i) => (
        <span key={i}>
          {i > 0 && <span className="text-slate-300"> ｜ </span>}
          <span className={l.is_own ? "font-bold text-[#C1553B]" : ""}>
            {l.position ?? "?"} {l.service_name}
          </span>
        </span>
      ))}
      {listings.length > 8 && <span className="text-slate-400">（他{listings.length - 8}）</span>}
    </span>
  );
}

/**
 * 陣取りボード本体（サーバーコンポーネント）：KW軸のマトリクス表示。
 * KWごとに最新スナップショットのランキング/比較記事を「検索順位 × 記事内の掲載枠 × 自社掲載 × 打診状況」で並べる。
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

  // --- この案件の打診対象（チップ表示＋検索結果に紐づかない候補の抽出に使う） ---
  const { data: targets } = await sb
    .from("outreach_targets")
    .select("*, media:media(*), campaign:campaigns(name)")
    .eq("campaign_id", campaignId)
    .order("rank", { ascending: true, nullsFirst: false });
  const targetByMedia = new Map((targets ?? []).map((t) => [t.media_id, t]));

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
  const unmatchedMediaIds = [...new Set(unmatched.map((t) => t.media_id))];

  const contacted = new Map<string, number>();
  if (unmatchedMediaIds.length) {
    const { data: past } = await sb
      .from("outreach_targets")
      .select("media_id, status")
      .in("media_id", unmatchedMediaIds);
    for (const p of past ?? [])
      if (!["collected", "confirmed"].includes(p.status))
        contacted.set(p.media_id, (contacted.get(p.media_id) ?? 0) + 1);
  }
  const competitors = new Map<string, string[]>();
  if (unmatchedMediaIds.length) {
    const { data: pastEntries } = await sb
      .from("serp_entries")
      .select("media_id, listings:article_listings(position, service_name)")
      .in("media_id", unmatchedMediaIds)
      .order("id", { ascending: false })
      .limit(400);
    for (const e of pastEntries ?? []) {
      if (!e.media_id) continue;
      if (competitors.has(e.media_id)) continue;
      const list = (e.listings as unknown as { position: number; service_name: string }[]) ?? [];
      if (list.length)
        competitors.set(
          e.media_id,
          list
            .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
            .map((l) => `${l.position ?? "?"}位 ${l.service_name}`)
        );
    }
  }

  const unmatchedRows: Row[] = unmatched.map((t) => {
    const m = t.media as unknown as Record<string, string | boolean>;
    return {
      id: t.id,
      status: t.status,
      kind: t.kind,
      rank: t.rank,
      article_url: t.article_url,
      media_id: t.media_id,
      media_name: (m?.name as string) ?? "",
      media_domain: (m?.domain as string) ?? "",
      asp_type: (m?.asp_type as string) ?? "unknown",
      asp_name: (m?.asp_name as string) ?? "",
      no_solicitation: !!m?.no_solicitation,
      campaign_name: (t.campaign as unknown as { name: string } | null)?.name ?? "",
      competitors: competitors.get(t.media_id) ?? [],
      contacted: contacted.get(t.media_id) ?? 0,
    };
  });
  const uOpen = unmatchedRows.filter((r) => ["collected", "confirmed"].includes(r.status));
  const uMoving = unmatchedRows.filter((r) => !["collected", "confirmed", "excluded"].includes(r.status));
  const uExcluded = unmatchedRows.filter((r) => r.status === "excluded");

  return (
    <>
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
              <Link href={`/campaigns/${campaignId}?tab=collect`} className={btnSmall}>
                再収集
              </Link>
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
                <table className="tbl w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-slate-500">
                      <th className="w-14 pb-2 text-right">検索順位</th>
                      <th className="pb-2">メディア</th>
                      <th className="pb-2">記事</th>
                      <th className="pb-2">記事内の掲載枠</th>
                      <th className="pb-2">自社掲載</th>
                      <th className="pb-2">打診</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => {
                      const t = e.media ? targetByMedia.get(e.media.id) : undefined;
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
                          <td className="py-2">
                            <ListingInline listings={listByEntry.get(e.id) ?? []} />
                          </td>
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
                          <td className="py-2">
                            {t ? (
                              <div className="space-y-1">
                                <Badge tone={statusTone(t.status)}>
                                  {OUTREACH_STATUS[t.status as keyof typeof OUTREACH_STATUS] ?? t.status}
                                </Badge>
                                {["collected", "confirmed"].includes(t.status) && (
                                  <form className="flex flex-wrap gap-1">
                                    <input type="hidden" name="ids" value={t.id} />
                                    {t.status === "collected" && (
                                      <SubmitButton
                                        variant="small"
                                        formAction={setTargetStatus}
                                        name="status"
                                        value="confirmed"
                                      >
                                        対象確定
                                      </SubmitButton>
                                    )}
                                    <SubmitButton
                                      variant="small"
                                      formAction={generateDrafts}
                                      pendingLabel="生成中…"
                                    >
                                      文面生成
                                    </SubmitButton>
                                    <SubmitButton
                                      variant="small"
                                      formAction={setTargetStatus}
                                      name="status"
                                      value="excluded"
                                    >
                                      対象外
                                    </SubmitButton>
                                  </form>
                                )}
                              </div>
                            ) : e.media ? (
                              <form action={addOutreachTarget}>
                                <input type="hidden" name="campaign_id" value={campaignId} />
                                <input type="hidden" name="media_id" value={e.media.id} />
                                <input type="hidden" name="article_url" value={e.article_url} />
                                <input type="hidden" name="rank" value={e.rank ?? ""} />
                                <input type="hidden" name="own_listed" value={e.own_listed ? "true" : "false"} />
                                <SubmitButton variant="small">対象に追加</SubmitButton>
                              </form>
                            ) : (
                              <span className="text-[11px] text-slate-400">—</span>
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

      {/* ===== 検索結果に紐づかない候補メディア（掲載候補シート由来など） ===== */}
      {unmatched.length > 0 && (
        <>
          <div>
            <h2 className="text-sm font-bold text-[#1B2A4A]">
              検索結果に紐づかない候補メディア（{unmatched.length}件）
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              最新の収集結果には現れていないが、打診対象として登録されているメディア（掲載候補シート由来など）。
            </p>
          </div>

          <Card
            title="未処理（収集済・対象確定）"
            desc="ここが人の最終チェック。取りこぼし・誤検出を直してから文面生成へ回します"
          >
            {uOpen.length === 0 ? (
              <Empty>未処理はありません。</Empty>
            ) : (
              <BulkTable rows={uOpen} setStatus={setTargetStatus} generateDrafts={generateDrafts} />
            )}
          </Card>

          <Card title="進行中" desc="文面生成済み以降">
            {uMoving.length === 0 ? (
              <Empty>進行中の打診はありません。</Empty>
            ) : (
              <BulkTable rows={uMoving} setStatus={setTargetStatus} generateDrafts={generateDrafts} />
            )}
          </Card>

          {uExcluded.length > 0 && (
            <Card title={`対象外（${uExcluded.length}件）`} desc="営業お断り・非該当・重複">
              <ul className="space-y-1 text-xs text-slate-600">
                {uExcluded.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <Badge tone="bg-zinc-200 text-zinc-600">除外</Badge>
                    <Link href={`/media/${r.media_id}`} className="hover:underline">
                      {r.media_name || r.media_domain}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}
