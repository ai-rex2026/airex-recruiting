import { getSessionProfile } from "@/lib/supabase/server";
import CollectionCenter, { type CampaignGroup, type JobInfo } from "./CollectionCenter";

export const dynamic = "force-dynamic";
// サーバーアクション（AI分析・Web検索収集）はこのページのセグメント設定で実行されるため、
// タイムアウトを 60 秒に引き上げておく（vercel.json でも全関数 60s を指定済み）。
export const maxDuration = 60;

type JobRow = {
  id: string;
  keyword_id: string;
  campaign_id: string;
  status: "pending" | "running" | "done" | "error";
  found_count: number;
  ranking_count: number;
  error_detail: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export default async function StartPage() {
  const { sb } = await getSessionProfile();

  const [{ data: campaigns }, { data: keywords }, { data: jobs }] = await Promise.all([
    sb
      .from("campaigns")
      .select("id, name, created_at, client:clients(name)")
      .order("created_at", { ascending: false }),
    sb.from("keywords").select("id, campaign_id, keyword, created_at").order("created_at"),
    sb
      .from("collection_jobs")
      .select("id, keyword_id, campaign_id, status, found_count, ranking_count, error_detail, started_at, finished_at, created_at")
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  // キーワードごとの最新ジョブ（jobs は created_at 降順）
  const latestByKw = new Map<string, JobRow>();
  for (const j of (jobs ?? []) as JobRow[]) if (!latestByKw.has(j.keyword_id)) latestByKw.set(j.keyword_id, j);

  const groups: CampaignGroup[] = (campaigns ?? []).map((c) => {
    const kws = (keywords ?? [])
      .filter((k) => k.campaign_id === c.id)
      .map((k) => {
        const j = latestByKw.get(k.id);
        const job: JobInfo | null = j
          ? {
              job_id: j.id,
              status: j.status,
              found: j.found_count ?? 0,
              ranking: j.ranking_count ?? 0,
              error: j.error_detail ?? "",
              started_at: j.started_at,
              finished_at: j.finished_at,
            }
          : null;
        return { keyword_id: k.id, keyword: k.keyword, job };
      });
    const last =
      kws
        .map((x) => x.job?.finished_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
    return {
      id: c.id,
      name: c.name,
      client: (c.client as unknown as { name: string } | null)?.name ?? "",
      last_collected: last as string | null,
      kws,
    };
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">収集センター</h1>
        <p className="mt-1 text-xs text-slate-500">
          商品のURLやテキストから自動収集を開始し、案件×キーワードごとの収集状況をここで管理します。
        </p>
        <p className="mt-1 text-xs text-slate-500">
          収集中にこの画面を閉じても、状態はここに残ります。未実行のKWは「再開」から続けられます。
        </p>
      </header>

      <CollectionCenter groups={groups} />
    </div>
  );
}
