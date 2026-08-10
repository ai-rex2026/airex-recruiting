import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { approveAndQueue, saveDraft, setTargetStatus, confirmReply, addReply } from "@/app/actions";
import ApproveCard, { type QueueItem } from "@/components/ApproveCard";
import ExceptionsView from "@/components/ExceptionsView";
import OutboxView from "@/components/OutboxView";
import { Card, Empty, Badge, btnGhost, inputCls } from "@/components/ui";
import { REPLY_CLASS } from "@/lib/domain";
import SubmitButton from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const top = sp.tab === "exceptions" ? "exceptions" : sp.tab === "outbox" ? "outbox" : "approve";
  const { sb } = await getSessionProfile();

  // タブ見出し用の軽いカウント
  const [{ count: waitN }, { count: excN }] = await Promise.all([
    sb
      .from("outreach_targets")
      .select("id", { count: "exact", head: true })
      .in("status", ["awaiting_approval", "replied"]),
    sb
      .from("outreach_targets")
      .select("id", { count: "exact", head: true })
      .in("status", ["exception", "uncertain"]),
  ]);

  const TOP = [
    { id: "approve", label: `承認待ち（${waitN ?? 0}）`, href: "/queue" },
    { id: "exceptions", label: `例外対応（${excN ?? 0}）`, href: "/queue?tab=exceptions" },
    { id: "outbox", label: "送信ログ", href: "/queue?tab=outbox" },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">承認キュー</h1>
        <p className="mt-1 text-xs text-slate-500">
          判断を待っている件だけが積まれています。上から捌けば業務が進みます。例外対応と送信ログもここから確認できます。
        </p>
      </header>

      {/* トップレベルタブ：承認待ち／例外対応／送信ログ */}
      <nav className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        {TOP.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              top === t.id ? "bg-[#1B2A4A] text-white" : "bg-white text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {top === "approve" && <ApproveQueue tab={sp.tab === "reply" ? "reply" : "send"} />}
      {top === "exceptions" && <ExceptionsView />}
      {top === "outbox" && <OutboxView />}
    </div>
  );
}

/** 承認待ちタブの本体（送信承認待ち／返信の分類待ち） */
async function ApproveQueue({ tab }: { tab: "send" | "reply" }) {
  const { sb } = await getSessionProfile();

  const { data: sendTargets } = await sb
    .from("outreach_targets")
    .select("*, media:media(*), campaign:campaigns(name)")
    .eq("status", "awaiting_approval")
    .order("rank", { ascending: true, nullsFirst: false })
    .limit(50);

  const ids = (sendTargets ?? []).map((t) => t.id);
  const mediaIds = [...new Set((sendTargets ?? []).map((t) => t.media_id))];

  const [{ data: drafts }, { data: contacts }, { data: history }] = await Promise.all([
    ids.length
      ? sb.from("message_drafts").select("*").in("outreach_target_id", ids).order("version", { ascending: false })
      : Promise.resolve({ data: [] as Record<string, string>[] }),
    mediaIds.length
      ? sb.from("media_contacts").select("*").in("media_id", mediaIds).eq("active", true)
      : Promise.resolve({ data: [] as Record<string, string>[] }),
    mediaIds.length
      ? sb
          .from("send_attempts")
          .select("sent_at, queued_at, result, outreach_target_id, target:outreach_targets(media_id, campaign:campaigns(name))")
          .limit(300)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const draftByTarget = new Map<string, Record<string, string>>();
  for (const d of (drafts ?? []) as Record<string, string>[])
    if (!draftByTarget.has(d.outreach_target_id)) draftByTarget.set(d.outreach_target_id, d);

  const contactByMedia = new Map<string, Record<string, string>>();
  for (const c of (contacts ?? []) as Record<string, string>[])
    if (!contactByMedia.has(c.media_id)) contactByMedia.set(c.media_id, c);

  const histByMedia = new Map<string, { at: string; label: string }[]>();
  for (const h of (history ?? []) as Record<string, unknown>[]) {
    const t = h.target as { media_id?: string; campaign?: { name?: string } } | null;
    const mid = t?.media_id;
    if (!mid) continue;
    const arr = histByMedia.get(mid) ?? [];
    arr.push({
      at: new Date(String(h.sent_at || h.queued_at)).toLocaleDateString("ja-JP"),
      label: `${t?.campaign?.name ?? ""} ${String(h.result)}`,
    });
    histByMedia.set(mid, arr);
  }

  const items: QueueItem[] = (sendTargets ?? []).map((t) => {
    const m = t.media as unknown as Record<string, string | boolean>;
    const d = draftByTarget.get(t.id);
    const c = contactByMedia.get(t.media_id);
    return {
      id: t.id,
      kind: t.kind,
      rank: t.rank,
      article_url: t.article_url,
      campaign_name: (t.campaign as unknown as { name: string } | null)?.name ?? "",
      media_id: t.media_id,
      media_name: (m?.name as string) ?? "",
      media_domain: (m?.domain as string) ?? "",
      asp_type: (m?.asp_type as string) ?? "unknown",
      asp_name: (m?.asp_name as string) ?? "",
      no_solicitation: !!m?.no_solicitation,
      contact: c?.value ?? null,
      contactKind: c?.kind ?? null,
      history: histByMedia.get(t.media_id) ?? [],
      subject: d?.subject ?? "(文面が未生成です)",
      body: d?.body ?? "陣取りボードで「AIで文面を生成」を実行してください。",
    };
  });

  // 返信分類待ち
  const { data: replyTargets } = await sb
    .from("outreach_targets")
    .select("*, media:media(name, domain), campaign:campaigns(name), replies:replies(*)")
    .eq("status", "replied")
    .limit(50);

  const { data: sentTargets } = await sb
    .from("outreach_targets")
    .select("id, media:media(name, domain), campaign:campaigns(name)")
    .in("status", ["sent", "uncertain", "negotiating"])
    .limit(200);

  return (
    <>
      <div className="flex gap-2">
        <Link
          href="/queue"
          className={`rounded-lg border px-3 py-1.5 text-xs ${
            tab === "send" ? "border-[#1B2A4A] bg-[#1B2A4A] text-white" : "border-slate-300 bg-white"
          }`}
        >
          送信承認待ち（{items.length}）
        </Link>
        <Link
          href="/queue?tab=reply"
          className={`rounded-lg border px-3 py-1.5 text-xs ${
            tab === "reply" ? "border-[#1B2A4A] bg-[#1B2A4A] text-white" : "border-slate-300 bg-white"
          }`}
        >
          返信の分類待ち（{(replyTargets ?? []).length}）
        </Link>
      </div>

      {tab === "send" ? (
        items.length === 0 ? (
          <Empty>
            承認待ちはありません。
            <Link href="/board" className="ml-1 underline">
              陣取りボード
            </Link>
            で打診対象を確定してください。
          </Empty>
        ) : (
          <>
            <Card title="一括承認" desc="表示中の全件をまとめて送信キューへ入れます">
              <form action={approveAndQueue} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="ids" value={items.map((i) => i.id).join(",")} />
                <div>
                  <label className="mb-1 block text-[11px] text-slate-500">送信予約（任意）</label>
                  <input type="datetime-local" name="scheduled_for" className={inputCls} />
                </div>
                <SubmitButton variant="accent" pendingLabel="承認中…">表示中の {items.length} 件を承認</SubmitButton>
                <p className="text-[11px] text-slate-400">
                  営業お断り・送信済／不確定のメディアは自動でスキップされます（二重送信防止）。
                </p>
              </form>
            </Card>

            <div className="space-y-4">
              {items.map((i) => (
                <ApproveCard
                  key={i.id}
                  item={i}
                  approve={approveAndQueue}
                  save={saveDraft}
                  exclude={setTargetStatus}
                />
              ))}
            </div>
          </>
        )
      ) : (
        <div className="space-y-4">
          <Card title="返信を取り込む" desc="メールやフォーム経由の返信を貼り付けると、AIが分類します">
            <form action={addReply} className="space-y-3">
              <select name="target_id" className={inputCls} required>
                <option value="">— 打診先を選択 —</option>
                {(sentTargets ?? []).map((t) => {
                  const m = t.media as unknown as { name: string; domain: string } | null;
                  const c = t.campaign as unknown as { name: string } | null;
                  return (
                    <option key={t.id} value={t.id}>
                      {m?.name || m?.domain} / {c?.name}
                    </option>
                  );
                })}
              </select>
              <textarea name="body" rows={5} className={inputCls} placeholder="返信本文を貼り付け" required />
              <SubmitButton variant="accent" pendingLabel="AIが分類中…">取り込んでAIに分類させる</SubmitButton>
            </form>
          </Card>

          {(replyTargets ?? []).length === 0 ? (
            <Empty>分類待ちの返信はありません。</Empty>
          ) : (
            (replyTargets ?? []).map((t) => {
              const m = t.media as unknown as { name: string; domain: string } | null;
              const reps = ((t.replies as unknown as Record<string, string>[]) ?? []).sort((a, b) =>
                a.received_at < b.received_at ? 1 : -1
              );
              const r = reps[0];
              if (!r) return null;
              return (
                <Card
                  key={t.id}
                  title={`${m?.name || m?.domain}`}
                  desc={(t.campaign as unknown as { name: string } | null)?.name}
                >
                  <div className="grid gap-4 md:grid-cols-[1fr_260px]">
                    <div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                        {r.body}
                      </pre>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <div className="text-[11px] text-slate-400">AIの分類</div>
                        <Badge tone="bg-sky-100 text-sky-800">
                          {REPLY_CLASS[r.ai_class as keyof typeof REPLY_CLASS] ?? "未判定"}
                        </Badge>
                        <p className="mt-1 text-[11px] text-slate-600">{r.ai_summary}</p>
                        {r.extracted_terms && (
                          <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                            条件：{r.extracted_terms}
                          </p>
                        )}
                      </div>
                      <form action={confirmReply} className="space-y-2">
                        <input type="hidden" name="reply_id" value={r.id} />
                        <input type="hidden" name="target_id" value={t.id} />
                        <select
                          name="final_class"
                          defaultValue={r.ai_class || "negotiating"}
                          className={inputCls}
                        >
                          {Object.entries(REPLY_CLASS).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                        <SubmitButton variant="accent">この分類で確定</SubmitButton>
                      </form>
                      <Link href={`/media/${t.media_id}`} className={`${btnGhost} w-full`}>
                        メディア台帳を見る
                      </Link>
                    </div>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      )}
    </>
  );
}
