"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Empty, btnAccent, btnSmall } from "@/components/ui";
import StartWizard from "./StartWizard";
import type { CampaignGroup } from "./CampaignJobs";

export type { CampaignGroup, JobInfo, KwRow } from "./CampaignJobs";

function fmt(dt: string | null): string {
  return dt ? new Date(dt).toLocaleString("ja-JP") : "—";
}

/** 収集状況の集計チップ（クリック不可・表示専用） */
function CountChip({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${
        count > 0 ? tone : "bg-slate-50 text-slate-300"
      }`}
    >
      {label} {count}
    </span>
  );
}

/**
 * 案件のサマリーカード（閲覧専用）。
 * カード全体が案件詳細へのリンク。収集の実行・再開などの操作は案件詳細の「収集状況」タブで行う。
 */
function CampaignSummaryCard({ group }: { group: CampaignGroup }) {
  let done = 0;
  let running = 0;
  let idle = 0;
  let failed = 0;
  for (const k of group.kws) {
    const s = k.job?.status;
    if (s === "done") done += 1;
    else if (s === "running") running += 1;
    else if (s === "error") failed += 1;
    else idle += 1; // pending または ジョブ未作成
  }

  return (
    <Link
      href={`/campaigns/${group.id}`}
      className="block rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:border-[#1B2A4A]/40 hover:shadow"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="truncate text-sm font-bold text-[#1B2A4A]">{group.name}</span>
            {group.client && <span className="text-xs text-slate-500">{group.client}</span>}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            最終収集：{fmt(group.last_collected)} ／ KW数：{group.kws.length}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <CountChip label="✅完了" count={done} tone="bg-emerald-100 text-emerald-800" />
          <CountChip label="⏳実行中" count={running} tone="bg-sky-100 text-sky-800" />
          <CountChip label="◻未実行" count={idle} tone="bg-slate-100 text-slate-600" />
          <CountChip label="❌失敗" count={failed} tone="bg-rose-100 text-rose-800" />
          <span className="ml-1 text-slate-300">›</span>
        </div>
      </div>
    </Link>
  );
}

export default function CollectionCenter({ groups }: { groups: CampaignGroup[] }) {
  const router = useRouter();
  const [wizardOpen, setWizardOpen] = useState(groups.length === 0);

  // ウィザードで案件を作成したら、案件詳細の「収集状況」タブへ遷移し、
  // そこで未実行ジョブを自動再開する（一覧側ではジョブを実行しない）。
  const onWizardCreated = (campaignId: string) => {
    router.push(`/campaigns/${campaignId}?tab=collect&autorun=1`);
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

      {/* 案件一覧（サマリー専用・クリックで案件詳細へ） */}
      {groups.length === 0 ? (
        <Empty>まだ案件がありません。上のウィザードから始めてください。</Empty>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <CampaignSummaryCard key={g.id} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}
