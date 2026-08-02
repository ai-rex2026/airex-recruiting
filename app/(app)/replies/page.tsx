import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { saveNegotiationNote, setTargetStatus } from "@/app/actions";
import { Card, Empty, Badge, btnSmall, inputCls } from "@/components/ui";
import { OUTREACH_STATUS, REPLY_CLASS, statusTone } from "@/lib/domain";
import SubmitButton from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function RepliesPage() {
  const { sb } = await getSessionProfile();

  const { data: targets } = await sb
    .from("outreach_targets")
    .select("*, media:media(id, name, domain), campaign:campaigns(name), replies:replies(*)")
    .in("status", ["replied", "negotiating", "placeable", "rejected", "sent", "uncertain"])
    .order("updated_at", { ascending: false })
    .limit(200);

  const rows = targets ?? [];
  const negotiating = rows.filter((t) => ["replied", "negotiating", "placeable"].includes(t.status));
  const silent = rows.filter((t) => ["sent", "uncertain"].includes(t.status));

  // 返答なし候補：送信から14日以上経過
  // eslint-disable-next-line react-hooks/purity -- Server Component。描画のたびに現在時刻で判定してよい
  const now = Date.now();
  const stale = silent.filter(
    (t) => now - new Date(t.updated_at).getTime() > 14 * 24 * 3600 * 1000
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">返信・交渉</h1>
        <p className="mt-1 text-xs text-slate-500">
          返信の取り込みと分類は承認キューで行います。ここでは交渉の経過を残します。
        </p>
      </header>

      <Card title={`交渉中・返信あり（${negotiating.length}件）`}>
        {negotiating.length === 0 ? (
          <Empty>該当なし。</Empty>
        ) : (
          <div className="space-y-3">
            {negotiating.map((t) => {
              const m = t.media as unknown as { id: string; name: string; domain: string };
              const reps = ((t.replies as unknown as Record<string, string>[]) ?? []).sort((a, b) =>
                a.received_at < b.received_at ? 1 : -1
              );
              return (
                <div key={t.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/media/${m?.id}`} className="font-medium hover:underline">
                      {m?.name || m?.domain}
                    </Link>
                    <span className="text-xs text-slate-500">
                      {(t.campaign as unknown as { name: string } | null)?.name}
                    </span>
                    <Badge tone={statusTone(t.status)}>
                      {OUTREACH_STATUS[t.status as keyof typeof OUTREACH_STATUS] ?? t.status}
                    </Badge>
                    {reps[0]?.final_class && (
                      <Badge tone="bg-sky-100 text-sky-800">
                        {REPLY_CLASS[reps[0].final_class as keyof typeof REPLY_CLASS]}
                      </Badge>
                    )}
                  </div>
                  {reps[0]?.extracted_terms && (
                    <p className="mt-1 text-xs text-amber-800">条件：{reps[0].extracted_terms}</p>
                  )}
                  <form action={saveNegotiationNote} className="mt-2 flex gap-2">
                    <input type="hidden" name="target_id" value={t.id} />
                    <input
                      name="note"
                      defaultValue={t.negotiation_note}
                      placeholder="交渉メモ（単価・承認率・掲載位置の経過）"
                      className={`${inputCls} py-1 text-xs`}
                    />
                    <SubmitButton variant="small">保存</SubmitButton>
                  </form>
                  <div className="mt-2 flex gap-2">
                    {(["placeable", "rejected"] as const).map((s) => (
                      <form action={setTargetStatus} key={s}>
                        <input type="hidden" name="ids" value={t.id} />
                        <input type="hidden" name="status" value={s} />
                        <SubmitButton variant="ghost">
                          {s === "placeable" ? "掲載可能にする" : "掲載不可にする"}
                        </SubmitButton>
                      </form>
                    ))}
                    {t.status === "placeable" && (
                      <Link href="/placements" className={btnSmall}>
                        掲載を登録する
                      </Link>
                    )}
                  </div>
                  <div className="mt-2 space-y-1">
                    {reps.slice(0, 2).map((r) => (
                      <pre
                        key={r.id}
                        className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-600"
                      >
                        {r.body}
                      </pre>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title={`返答なしの候補（${stale.length}件）`}
        desc="送信から14日以上返信がない件。再打診は承認制です"
      >
        {stale.length === 0 ? (
          <Empty>該当なし。</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {stale.map((t) => {
              const m = t.media as unknown as { id: string; name: string; domain: string };
              return (
                <li key={t.id} className="flex items-center gap-2">
                  <Link href={`/media/${m?.id}`} className="hover:underline">
                    {m?.name || m?.domain}
                  </Link>
                  <span className="text-[11px] text-slate-400">
                    最終更新 {new Date(t.updated_at).toLocaleDateString("ja-JP")}
                  </span>
                  <form action={setTargetStatus} className="ml-auto">
                    <input type="hidden" name="ids" value={t.id} />
                    <input type="hidden" name="status" value="no_reply" />
                    <SubmitButton variant="small">返答なしにする</SubmitButton>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
