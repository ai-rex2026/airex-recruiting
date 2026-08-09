import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import BoardView from "@/components/BoardView";
import { Empty, btnSmall } from "@/components/ui";

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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1B2A4A]">陣取りボード</h1>
          <p className="mt-1 text-xs text-slate-500">
            どこを取りに行くかを決める盤面。ここで打診対象を確定すると、AIが文面を下書きします。
          </p>
          {campaignId && (
            <p className="mt-1 text-xs">
              <Link href={`/campaigns/${campaignId}?tab=board`} className={btnSmall}>
                案件詳細で見る
              </Link>
            </p>
          )}
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
          案件がありません。<Link href="/start" className="underline">案件・収集</Link>から登録してください。
        </Empty>
      ) : (
        <BoardView campaignId={campaignId} />
      )}
    </div>
  );
}
