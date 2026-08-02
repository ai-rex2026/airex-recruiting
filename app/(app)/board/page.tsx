import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { setTargetStatus, generateDrafts } from "@/app/actions";
import BulkTable, { type Row } from "@/components/BulkTable";
import { Card, Empty, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const sp = await searchParams;
  const { sb } = await getSessionProfile();

  const { data: campaigns } = await sb
    .from("campaigns")
    .select("id, name")
    .order("created_at", { ascending: false });
  const campaignId = sp.campaign ?? campaigns?.[0]?.id ?? "";

  const { data: targets } = campaignId
    ? await sb
        .from("outreach_targets")
        .select("*, media:media(*), campaign:campaigns(name)")
        .eq("campaign_id", campaignId)
        .order("rank", { ascending: true, nullsFirst: false })
    : { data: [] };

  // 各メディアの過去接触回数
  const mediaIds = [...new Set((targets ?? []).map((t) => t.media_id))];
  const contacted = new Map<string, number>();
  if (mediaIds.length) {
    const { data: past } = await sb
      .from("outreach_targets")
      .select("media_id, status")
      .in("media_id", mediaIds);
    for (const p of past ?? [])
      if (!["collected", "confirmed"].includes(p.status))
        contacted.set(p.media_id, (contacted.get(p.media_id) ?? 0) + 1);
  }

  // 記事内競合（最新スナップショットのもの）
  const competitors = new Map<string, string[]>();
  if (mediaIds.length) {
    const { data: entries } = await sb
      .from("serp_entries")
      .select("media_id, listings:article_listings(position, service_name), snapshot:serp_snapshots(keyword:keywords(keyword))")
      .in("media_id", mediaIds)
      .order("id", { ascending: false })
      .limit(400);
    for (const e of entries ?? []) {
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

  const rows: Row[] = (targets ?? []).map((t) => {
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

  const open = rows.filter((r) => ["collected", "confirmed"].includes(r.status));
  const moving = rows.filter((r) => !["collected", "confirmed", "excluded"].includes(r.status));
  const excluded = rows.filter((r) => r.status === "excluded");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1B2A4A]">陣取りボード</h1>
          <p className="mt-1 text-xs text-slate-500">
            どこを取りに行くかを決める盤面。ここで打診対象を確定すると、AIが文面を下書きします。
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(campaigns ?? []).map((c) => (
            <Link
              key={c.id}
              href={`/board?campaign=${c.id}`}
              className={`rounded-lg border px-3 py-1.5 text-xs ${
                c.id === campaignId
                  ? "border-[#1B2A4A] bg-[#1B2A4A] text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {c.name}
            </Link>
          ))}
        </div>
      </header>

      {!campaignId ? (
        <Empty>
          案件がありません。<Link href="/campaigns" className="underline">案件を登録</Link>してください。
        </Empty>
      ) : rows.length === 0 ? (
        <Empty>
          この案件にはまだ収集結果がありません。
          <Link href={`/collect?campaign=${campaignId}`} className="ml-1 underline">
            収集を実行
          </Link>
        </Empty>
      ) : (
        <>
          <Card
            title="未処理（収集済・対象確定）"
            desc="ここが人の最終チェック。取りこぼし・誤検出を直してから文面生成へ回します"
          >
            {open.length === 0 ? (
              <Empty>未処理はありません。</Empty>
            ) : (
              <BulkTable rows={open} setStatus={setTargetStatus} generateDrafts={generateDrafts} />
            )}
          </Card>

          <Card title="進行中" desc="文面生成済み以降">
            {moving.length === 0 ? (
              <Empty>進行中の打診はありません。</Empty>
            ) : (
              <BulkTable rows={moving} setStatus={setTargetStatus} generateDrafts={generateDrafts} />
            )}
          </Card>

          {excluded.length > 0 && (
            <Card title={`対象外（${excluded.length}件）`} desc="営業お断り・非該当・重複">
              <ul className="space-y-1 text-xs text-slate-600">
                {excluded.map((r) => (
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
    </div>
  );
}
