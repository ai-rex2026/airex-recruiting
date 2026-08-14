import { Card, Empty, Badge, inputCls, labelCls } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import DocumentUpload from "@/components/DocumentUpload";
import { applyMediaKit, deleteDocument, type MediaKitExtract } from "@/app/document-actions";
import { getSessionProfile } from "@/lib/supabase/server";

type Doc = {
  id: string;
  file_name: string;
  byte_size: number;
  status: string;
  extracted: MediaKitExtract | null;
  extract_error: string;
  created_at: string;
};

/** 抽出結果を media.note に入れる1本のテキストに整形する。空項目は落とす */
function toNote(x: MediaKitExtract): string {
  const rows: [string, string][] = [
    ["初期費用", x.initial_fee],
    ["月額掲載費用", x.monthly_fee],
    ["成果報酬", x.performance_fee],
    ["掲載位置", x.placement_position],
    ["上位掲載オプション", x.top_placement_option],
    ["掲載期間", x.placement_period],
    ["計測リンク", x.tracking_link],
    ["成果地点", x.conversion_point],
    ["掲載可否", x.placeable],
    ["その他条件", x.other_terms],
  ];
  return rows
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}：${v.trim()}`)
    .join("\n");
}

function kb(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/**
 * 媒体資料（営業資料）の取り込み。
 * 掲載条件は案件をまたいで使う情報なので、確定先は媒体台帳（media.note）。
 */
export default async function MediaKitCard({ mediaId }: { mediaId: string }) {
  const { sb, profile } = await getSessionProfile();
  const { data } = await sb
    .from("documents")
    .select("id, file_name, byte_size, status, extracted, extract_error, created_at")
    .eq("media_id", mediaId)
    .eq("kind", "media_kit")
    .order("created_at", { ascending: false });
  const docs = (data ?? []) as unknown as Doc[];

  return (
    <Card
      title="媒体資料"
      desc="営業資料・媒体資料を読み取って掲載条件を取り出します。反映先は媒体台帳のメモ（案件をまたいで使えます）"
    >
      <DocumentUpload kind="media_kit" tenantId={profile?.tenant_id ?? ""} mediaId={mediaId} />

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
                <form action={applyMediaKit} className="mt-2 space-y-2">
                  <input type="hidden" name="document_id" value={d.id} />
                  <label className={labelCls}>
                    読み取った掲載条件
                    <span className="ml-1 font-normal text-slate-400">
                      内容を確認・修正してから反映してください
                    </span>
                  </label>
                  <textarea
                    name="note"
                    defaultValue={toNote(d.extracted)}
                    rows={8}
                    className={`${inputCls} font-mono text-xs`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <SubmitButton variant="accent">媒体台帳のメモに反映</SubmitButton>
                    <span className="text-[11px] text-slate-400">
                      既存のメモは上書きされます。出典としてファイル名が付きます
                    </span>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        反映した内容は陣取り表の<strong>媒体メモ</strong>列に出て、Excel にもそのまま書き出されます。
      </p>
    </Card>
  );
}
