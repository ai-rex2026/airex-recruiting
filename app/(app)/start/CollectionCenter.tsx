"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Empty, btnAccent, btnSmall } from "@/components/ui";
import StartWizard from "./StartWizard";
import CampaignJobs, { type CampaignGroup } from "./CampaignJobs";

export type { CampaignGroup, JobInfo, KwRow } from "./CampaignJobs";

export default function CollectionCenter({ groups }: { groups: CampaignGroup[] }) {
  const router = useRouter();
  const [wizardOpen, setWizardOpen] = useState(groups.length === 0);
  // ウィザードで作成した直後の案件は、一覧に現れたら未実行ジョブを自動で再開する
  const [autoRunCampaign, setAutoRunCampaign] = useState<string | null>(null);

  const onWizardCreated = (campaignId: string) => {
    setWizardOpen(false);
    setAutoRunCampaign(campaignId);
    router.refresh(); // 新しい案件とジョブを一覧に出す（表示後に自動再開）
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

      {/* 収集状況の一覧（案件ごと） */}
      {groups.length === 0 ? (
        <Empty>まだ案件がありません。上のウィザードから始めてください。</Empty>
      ) : (
        groups.map((g) => (
          <CampaignJobs
            key={g.id}
            group={g}
            headerHref={`/campaigns/${g.id}`}
            boardHref={`/campaigns/${g.id}?tab=board`}
            autoResume={autoRunCampaign === g.id}
          />
        ))
      )}
    </div>
  );
}
