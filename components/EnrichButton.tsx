"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnSmall } from "@/components/ui";
import { enrichArticleListings, listEnrichableEntries } from "@/app/start-actions";

/**
 * 既存スナップショットの記事本文を読み直して掲載枠を再抽出するボタン（陣取り表のKWヘッダ用）。
 * 1件ずつ順番に実行し、進捗をインライン表示。完了後に router.refresh() で表を更新する。
 */
export default function EnrichButton({ snapshotId }: { snapshotId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setLabel(null);
    try {
      const le = await listEnrichableEntries(snapshotId);
      if (!le.ok) {
        setLabel(le.error);
        return;
      }
      if (!le.entries.length) {
        setLabel("対象記事がありません");
        return;
      }
      let ok = 0;
      for (let i = 0; i < le.entries.length; i++) {
        setLabel(`読取中 ${i + 1}/${le.entries.length}`);
        try {
          const r = await enrichArticleListings(le.entries[i].entry_id, true);
          if (r.ok) ok++;
        } catch {
          // 個別記事の失敗はスキップして続行
        }
      }
      setLabel(`本文読取: ${ok}/${le.entries.length}件`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      {label && <span className="whitespace-nowrap text-[10px] text-slate-400">{label}</span>}
      <button type="button" onClick={run} disabled={busy} className={btnSmall}>
        {busy ? "読取中…" : "記事本文から読み直す"}
      </button>
      <span className="whitespace-nowrap text-[10px] text-slate-400">1記事あたり数円のAPI利用料</span>
    </span>
  );
}
