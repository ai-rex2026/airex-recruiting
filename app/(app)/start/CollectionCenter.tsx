"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Empty, btnAccent, btnGhost, btnSmall } from "@/components/ui";
import StartWizard from "./StartWizard";
import {
  collectKeywordAuto,
  startCollectionForCampaign,
  createCollectionJob,
  type RunnableJob,
} from "@/app/start-actions";

export type JobInfo = {
  job_id: string;
  status: "pending" | "running" | "done" | "error";
  found: number;
  ranking: number;
  error: string;
  started_at: string | null;
  finished_at: string | null;
};

export type KwRow = { keyword_id: string; keyword: string; job: JobInfo | null };

export type CampaignGroup = {
  id: string;
  name: string;
  client: string;
  last_collected: string | null;
  kws: KwRow[];
};

type Overlay = { state: "queued" | "running" | "done" | "error"; found?: number; ranking?: number; error?: string };

const STALE_MS = 5 * 60 * 1000;

function effectiveStatus(row: KwRow, ov: Overlay | undefined) {
  if (ov) return ov.state === "queued" ? "pending" : ov.state;
  const j = row.job;
  if (!j) return "none";
  if (j.status === "running") {
    const fresh = j.started_at && Date.now() - new Date(j.started_at).getTime() < STALE_MS;
    return fresh ? "running" : "error"; // 中断（stale）は失敗扱いで再実行を促す
  }
  return j.status;
}

function fmt(dt: string | null): string {
  return dt ? new Date(dt).toLocaleString("ja-JP") : "—";
}

export default function CollectionCenter({ groups }: { groups: CampaignGroup[] }) {
  const router = useRouter();
  const [wizardOpen, setWizardOpen] = useState(groups.length === 0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // keyword_id → 実行中の楽観的表示（DBの実状態はリロード/refresh で反映される）
  const [overlay, setOverlay] = useState<Record<string, Overlay>>({});

  const setOv = (keywordId: string, ov: Overlay | null) =>
    setOverlay((prev) => {
      const n = { ...prev };
      if (ov) n[keywordId] = ov;
      else delete n[keywordId];
      return n;
    });

  const runJobs = async (jobs: RunnableJob[]) => {
    if (!jobs.length) {
      setNotice("実行できるジョブがありません（すべて完了済みか実行中です）。");
      return;
    }
    setBusy(true);
    setNotice(null);
    for (const j of jobs) setOv(j.keyword_id, { state: "queued" });
    try {
      for (const j of jobs) {
        setOv(j.keyword_id, { state: "running" });
        try {
          const r = await collectKeywordAuto(j.job_id);
          if (r.ok) setOv(j.keyword_id, { state: "done", found: r.found, ranking: r.ranking_articles });
          else setOv(j.keyword_id, { state: "error", error: r.error });
        } catch (e) {
          setOv(j.keyword_id, { state: "error", error: e instanceof Error ? e.message : "収集に失敗しました" });
        }
      }
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  const onWizardCreated = (campaignId: string, jobs: RunnableJob[]) => {
    setWizardOpen(false);
    router.refresh(); // 新しい案件とジョブを一覧に出す
    void runJobs(jobs);
  };

  const resume = async (campaignId: string) => {
    setBusy(true);
    try {
      const r = await startCollectionForCampaign(campaignId, "resume");
      if (!r.ok) {
        setNotice(r.error);
        return;
      }
      await runJobs(r.jobs);
    } finally {
      setBusy(false);
    }
  };

  const recollectAll = async (campaignId: string) => {
    setBusy(true);
    try {
      const r = await startCollectionForCampaign(campaignId, "all");
      if (!r.ok) {
        setNotice(r.error);
        return;
      }
      await runJobs(r.jobs);
    } finally {
      setBusy(false);
    }
  };

  const runOne = async (g: CampaignGroup, row: KwRow) => {
    if (row.job) {
      await runJobs([{ job_id: row.job.job_id, keyword_id: row.keyword_id, keyword: row.keyword }]);
      return;
    }
    setBusy(true);
    try {
      const r = await createCollectionJob(g.id, row.keyword_id);
      if (!r.ok) {
        setNotice(r.error);
        return;
      }
      await runJobs([r.job]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 新規開始（ウィザード） */}
      {wizardOpen ? (
        <Card
          title="新しく収集を開始"
          desc="商品URL／テキストから、AIが案件とキーワードを提案して自動収集します"
          action={
            groups.length > 0 ? (
              <button type="button" onClick={() => setWizardOpen(false)} className={btnSmall}>
                閉じる
              </button>
            ) : undefined
          }
        >
          <StartWizard onCreated={onWizardCreated} />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setWizardOpen(true)} className={btnAccent}>
              ＋ 新しく収集を開始
            </button>
            <span className="text-xs text-slate-500">
              商品URL／テキストから、AIが案件とキーワードを提案して自動収集します。
            </span>
          </div>
        </Card>
      )}

      {notice && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{notice}</p>}

      {/* 収集状況の一覧 */}
      {groups.length === 0 ? (
        <Empty>まだ案件がありません。上のウィザードから始めてください。</Empty>
      ) : (
        groups.map((g) => {
          const st = g.kws.map((row) => effectiveStatus(row, overlay[row.keyword_id]));
          const nDone = st.filter((s) => s === "done").length;
          const nRun = st.filter((s) => s === "running").length;
          const nPend = st.filter((s) => s === "pending" || s === "none").length;
          const nErr = st.filter((s) => s === "error").length;
          const hasResumable = nPend + nErr > 0;

          return (
            <Card
              key={g.id}
              title={g.name}
              desc={`${g.client || "クライアント未設定"} ／ 最終収集：${fmt(g.last_collected)}`}
              action={
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                    完了{nDone}
                  </span>
                  {nRun > 0 && (
                    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800">
                      実行中{nRun}
                    </span>
                  )}
                  {nPend > 0 && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                      未実行{nPend}
                    </span>
                  )}
                  {nErr > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
                      失敗{nErr}
                    </span>
                  )}
                </div>
              }
            >
              <div className="mb-3 flex flex-wrap gap-2">
                <Link href={`/board?campaign=${g.id}`} className={btnGhost}>
                  結果を見る（陣取りボード）
                </Link>
                {hasResumable && (
                  <button type="button" onClick={() => resume(g.id)} disabled={busy} className={btnAccent}>
                    未実行を再開（{nPend + nErr}件）
                  </button>
                )}
                <button type="button" onClick={() => recollectAll(g.id)} disabled={busy} className={btnGhost}>
                  全KWを再収集
                </button>
              </div>

              <table className="tbl w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] text-slate-500">
                    <th className="pb-2">キーワード</th>
                    <th className="pb-2">状態</th>
                    <th className="pb-2">最終収集</th>
                    <th className="pb-2 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {g.kws.map((row) => {
                    const ov = overlay[row.keyword_id];
                    const s = effectiveStatus(row, ov);
                    const found = ov?.found ?? row.job?.found ?? 0;
                    const ranking = ov?.ranking ?? row.job?.ranking ?? 0;
                    const errText = ov?.error ?? row.job?.error ?? "";
                    return (
                      <tr key={row.keyword_id}>
                        <td className="py-2 font-medium text-slate-800">{row.keyword}</td>
                        <td className="py-2">
                          {s === "running" && (
                            <span className="text-xs text-sky-700">
                              <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-300 border-t-sky-700 align-[-2px]" />
                              ⏳実行中
                            </span>
                          )}
                          {s === "done" && (
                            <span className="text-xs text-emerald-700">
                              ✅完了 {found}件（うちランキング{ranking}件）
                            </span>
                          )}
                          {s === "error" && (
                            <span className="text-xs text-red-700" title={errText}>
                              ❌失敗{errText ? `：${errText.slice(0, 40)}${errText.length > 40 ? "…" : ""}` : ""}
                            </span>
                          )}
                          {s === "pending" && <span className="text-xs text-slate-500">◻未実行</span>}
                          {s === "none" && (
                            <span className="text-xs text-slate-400">◻未実行（収集履歴なし）</span>
                          )}
                        </td>
                        <td className="py-2 text-[11px] text-slate-500">{fmt(row.job?.finished_at ?? null)}</td>
                        <td className="py-2 text-right">
                          {s !== "running" && (
                            <button
                              type="button"
                              onClick={() => runOne(g, row)}
                              disabled={busy}
                              className={btnSmall}
                            >
                              {s === "done" ? "再収集" : "収集"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          );
        })
      )}
    </div>
  );
}
