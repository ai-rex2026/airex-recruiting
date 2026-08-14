import { NextResponse, type NextRequest } from "next/server";
import { createWorkerClient } from "@/lib/supabase/server";
import { hasAnthropic } from "@/lib/anthropic";
import {
  runCollectJob,
  runEnrichEntry,
  listEnrichable,
  isFreshRunning,
  type Actor,
} from "@/lib/collect-core";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** 実行を打ち切る目安。maxDuration に当たって途中で切られないよう手前で返す */
const TIME_BUDGET_MS = 150_000;
/** 1回の起動で扱うジョブ数の上限（残りは次の起動が拾う） */
const MAX_JOBS_PER_RUN = 3;

type JobRow = {
  id: string;
  campaign_id: string;
  keyword_id: string;
  status: string;
  started_at: string | null;
};

/**
 * 収集ワーカー（cron から定期実行）。
 * これまで収集ループはブラウザ側で回っていたため、画面を閉じると止まっていた。
 * ここでは pending のジョブを拾って最後まで走らせるので、画面を開いていなくても進む。
 *
 * 認証は Vercel Cron の CRON_SECRET か、手動実行用の WORKER_TOKEN。
 */
async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const workerToken = process.env.WORKER_TOKEN;
  const auth = req.headers.get("authorization") ?? "";
  const byCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
  const byWorker = !!workerToken && req.headers.get("x-worker-token") === workerToken;
  if (!byCron && !byWorker) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!hasAnthropic()) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  // ワーカー専用アカウントでサインインする（RLS はそのアカウントのテナントに閉じる）
  const sb = await createWorkerClient();
  if (!sb) {
    return NextResponse.json({ error: "worker account not configured" }, { status: 503 });
  }
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "worker sign-in failed" }, { status: 503 });

  const { data: prof } = await sb
    .from("profiles")
    .select("id, tenant_id, full_name")
    .eq("id", user.id)
    .maybeSingle();
  if (!prof) return NextResponse.json({ error: "worker profile not found" }, { status: 503 });
  const actor: Actor = { id: prof.id, tenant_id: prof.tenant_id, full_name: prof.full_name ?? "" };

  const startedAt = Date.now();
  const left = () => TIME_BUDGET_MS - (Date.now() - startedAt);
  const done: { job_id: string; keyword_id: string; ok: boolean; detail: string }[] = [];

  for (let i = 0; i < MAX_JOBS_PER_RUN && left() > 60_000; i++) {
    // pending と、3分以上 running のまま放置されたジョブ（＝ブラウザが閉じられた等）を拾う
    const { data: rows } = await sb
      .from("collection_jobs")
      .select("id, campaign_id, keyword_id, status, started_at")
      .in("status", ["pending", "running"])
      .order("created_at", { ascending: true })
      .limit(20);

    const job = ((rows ?? []) as JobRow[]).find((j) => !isFreshRunning(j));
    if (!job) break;

    try {
      const r = await runCollectJob(sb, actor, job.id);
      if (!r.ok) {
        done.push({ job_id: job.id, keyword_id: job.keyword_id, ok: false, detail: r.error });
        continue;
      }

      // 第2段階：記事本文から掲載枠を抽出する。時間が尽きたら残りは次の起動へ
      let enriched = 0;
      const le = await listEnrichable(sb, r.snapshot_id);
      if (le.ok) {
        for (const e of le.entries) {
          if (left() < 45_000) break;
          try {
            const er = await runEnrichEntry(sb, actor, e.entry_id);
            if (er.ok) enriched++;
          } catch {
            // 個別記事の失敗はジョブ全体を失敗にしない
          }
        }
      }
      done.push({
        job_id: job.id,
        keyword_id: job.keyword_id,
        ok: true,
        detail: `found=${r.found} ranking=${r.ranking_articles} enriched=${enriched}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      await sb
        .from("collection_jobs")
        .update({ status: "error", error_detail: msg.slice(0, 500), finished_at: new Date().toISOString() })
        .eq("id", job.id);
      done.push({ job_id: job.id, keyword_id: job.keyword_id, ok: false, detail: msg });
    }
  }

  // 残件を返しておくと、cron のログだけで滞留に気づける
  const { count } = await sb
    .from("collection_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return NextResponse.json({
    ok: true,
    processed: done.length,
    pending_left: count ?? 0,
    elapsed_ms: Date.now() - startedAt,
    jobs: done,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
