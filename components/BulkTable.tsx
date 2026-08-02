"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, btnAccent, btnGhost, btnSmall } from "@/components/ui";
import { OUTREACH_STATUS, statusTone } from "@/lib/domain";

export type Row = {
  id: string;
  status: string;
  kind: string;
  rank: number | null;
  article_url: string;
  media_id: string;
  media_name: string;
  media_domain: string;
  asp_type: string;
  asp_name: string;
  no_solicitation: boolean;
  campaign_name: string;
  keyword?: string;
  competitors?: string[];
  contacted: number;
};

type Act = (formData: FormData) => void | Promise<void>;

export default function BulkTable({
  rows,
  setStatus,
  generateDrafts,
  showCampaign = false,
}: {
  rows: Row[];
  setStatus: Act;
  generateDrafts: Act;
  showCampaign?: boolean;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const allOn = rows.length > 0 && sel.size === rows.length;

  const toggle = (id: string) =>
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const ids = [...sel].join(",");

  return (
    <form>
      <input type="hidden" name="ids" value={ids} />

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
        <span className="text-xs text-slate-600">選択 {sel.size} 件</span>
        <button
          type="submit"
          formAction={setStatus}
          name="status"
          value="confirmed"
          disabled={!sel.size}
          className={btnGhost}
        >
          対象確定
        </button>
        <button
          type="submit"
          formAction={generateDrafts}
          disabled={!sel.size}
          className={btnAccent}
        >
          AIで文面を生成 → 承認キューへ
        </button>
        <button
          type="submit"
          formAction={setStatus}
          name="status"
          value="excluded"
          disabled={!sel.size}
          className={btnGhost}
        >
          対象外にする
        </button>
        <span className="ml-auto text-[11px] text-slate-400">
          営業お断りのメディアは自動で除外されます
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="grid w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-slate-500">
              <th className="w-8 pb-2">
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))}
                />
              </th>
              <th className="pb-2">メディア</th>
              {showCampaign && <th className="pb-2">案件</th>}
              <th className="pb-2">KW</th>
              <th className="w-12 pb-2 text-right">順位</th>
              <th className="pb-2">打診種別</th>
              <th className="pb-2">区分</th>
              <th className="pb-2">競合</th>
              <th className="pb-2">状態</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={sel.has(r.id) ? "bg-orange-50/60" : ""}>
                <td className="py-2 align-top">
                  <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                </td>
                <td className="py-2 align-top">
                  <Link href={`/media/${r.media_id}`} className="font-medium hover:underline">
                    {r.media_name || r.media_domain}
                  </Link>
                  <div className="text-[11px] text-slate-400">{r.media_domain}</div>
                  {r.no_solicitation && (
                    <Badge tone="bg-red-100 text-red-700">営業お断り</Badge>
                  )}
                  {r.contacted > 0 && (
                    <div className="text-[11px] text-slate-400">過去接触 {r.contacted}回</div>
                  )}
                  {r.article_url && (
                    <a
                      href={r.article_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-sky-700 underline"
                    >
                      記事を開く
                    </a>
                  )}
                </td>
                {showCampaign && (
                  <td className="py-2 align-top text-slate-600">{r.campaign_name}</td>
                )}
                <td className="py-2 align-top text-slate-600">{r.keyword ?? "—"}</td>
                <td className="py-2 text-right align-top">{r.rank ?? "—"}</td>
                <td className="py-2 align-top">
                  <Badge
                    tone={
                      r.kind === "replace"
                        ? "bg-purple-100 text-purple-800"
                        : "bg-slate-100 text-slate-700"
                    }
                  >
                    {r.kind === "replace" ? "リプレイス" : "新規"}
                  </Badge>
                </td>
                <td className="py-2 align-top text-xs text-slate-600">
                  {r.asp_type === "asp" ? `ASP経由${r.asp_name ? `（${r.asp_name}）` : ""}` : "直接"}
                </td>
                <td className="py-2 align-top text-[11px] text-slate-500">
                  {(r.competitors ?? []).slice(0, 3).join(" / ") || "—"}
                </td>
                <td className="py-2 align-top">
                  <Badge tone={statusTone(r.status)}>
                    {OUTREACH_STATUS[r.status as keyof typeof OUTREACH_STATUS] ?? r.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </form>
  );
}
