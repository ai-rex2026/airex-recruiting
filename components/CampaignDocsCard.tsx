import { Card, Empty, Badge } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import DocumentUpload from "@/components/DocumentUpload";
import { applyCampaignBrief, deleteDocument, type BriefExtract } from "@/app/document-actions";
import { getSessionProfile } from "@/lib/supabase/server";

type Doc = {
  id: string;
  file_name: string;
  byte_size: number;
  status: string;
  extracted: BriefExtract | null;
  extract_error: string;
  created_at: string;
};

const FIELDS: { label: string; get: (x: BriefExtract) => string }[] = [
  { label: "ジャンル", get: (x) => x.genre },
  { label: "報酬条件", get: (x) => x.unit_price },
  { label: "成果地点", get: (x) => x.conversion_point },
  { label: "承認条件", get: (x) => x.approval_terms },
  { label: "LP", get: (x) => x.lp_url },
  { label: "入稿URL", get: (x) => x.draft_url },
  { label: "参考URL", get: (x) => x.reference_url },
  { label: "訴求ポイント", get: (x) => x.selling_points },
];

function kb(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/**
 * 案件資料の取り込み（既存案件向け）。読み取り結果を確認してから案件情報・案件カルテへ反映する。
 * 新規案件は「かんたん開始」のウィザードから資料で作れる。
 */
export default async function CampaignDocsCard({ campaignId }: { campaignId: string }) {
  const { sb, profile } = await getSessionProfile();
  const { data } = await sb
    .from("documents")
    .select("id, file_name, byte_size, status, extracted, extract_error, created_at")
    .eq("campaign_id", campaignId)
    .eq("kind", "campaign_brief")
    .order("created_at", { ascending: false });
  const docs = (data ?? []) as unknown as Doc[];

  return (
    <Card
      title="案件資料"
      desc="クライアントからの案件資料を読み取り、案件情報と案件カルテを埋めます。ファイルは証跡として保管されます"
    >
      <DocumentUpload
        kind="campaign_brief"
        tenantId={profile?.tenant_id ?? ""}
        campaignId={campaignId}
      />

      {docs.length === 0 ? (
        <div className="mt-3">
          <Empty>まだ資料がありません。</Empty>
        </div>
      ) : (
        <ul className="mt-3 space-y-3">
          {docs.map((d) => (
            <li key={d.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-slate-800">{d.file_name}</div>
                  <div className="text-[10px] text-slate-400">
                    {kb(d.byte_size)}／{new Date(d.created_at).toLocaleString("ja-JP")}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {d.status === "extracted" ? (
                    <Badge tone="bg-emerald-100 text-emerald-800">読み取り済</Badge>
                  ) : d.status === "error" ? (
                    <Badge tone="bg-red-100 text-red-800">読み取り失敗</Badge>
                  ) : (
                    <Badge tone="bg-slate-100 text-slate-600">{d.status}</Badge>
                  )}
                  <form action={deleteDocument}>
                    <input type="hidden" name="id" value={d.id} />
                    <SubmitButton variant="small">削除</SubmitButton>
                  </form>
                </div>
              </div>

              {d.extract_error && (
                <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
                  {d.extract_error}
                </p>
              )}

              {d.status === "extracted" && d.extracted && (
                <>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] md:grid-cols-4">
                    {FIELDS.map((f) => {
                      const v = f.get(d.extracted as BriefExtract);
                      return (
                        <div key={f.label} className="min-w-0">
                          <dt className="text-[10px] font-semibold text-slate-500">{f.label}</dt>
                          <dd className="truncate text-slate-800" title={v}>
                            {v || <span className="text-slate-300">読み取れず</span>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>

                  {d.extracted.brief && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">
                        読み取った案件カルテを見る
                      </summary>
                      <pre className="mt-1.5 max-h-64 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 text-[11px] whitespace-pre-wrap text-slate-700">
                        {d.extracted.brief}
                      </pre>
                    </details>
                  )}

                  <form action={applyCampaignBrief} className="mt-2 flex flex-wrap items-center gap-3">
                    <input type="hidden" name="document_id" value={d.id} />
                    <SubmitButton variant="accent">案件情報に反映</SubmitButton>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                      <input type="checkbox" name="overwrite_brief" />
                      案件カルテを上書きする
                    </label>
                    <span className="text-[11px] text-slate-400">
                      既に入力済みの項目は変更しません
                    </span>
                  </form>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
