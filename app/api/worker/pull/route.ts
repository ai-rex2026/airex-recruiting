import { NextResponse, type NextRequest } from "next/server";
import { createWorkerClient } from "@/lib/supabase/server";
import { BLOCKING_RESULTS } from "@/lib/domain";

export const dynamic = "force-dynamic";

/**
 * 送信ワーカー（form-outreach-runner）が、承認済みで送信待ちの件を取得する。
 * 二重送信防止：すでに成功／不確定／営業お断り／手動送信済 の履歴がある打診は返さない。
 */
export async function GET(req: NextRequest) {
  const token = process.env.WORKER_TOKEN;
  if (!token) return NextResponse.json({ error: "worker not configured" }, { status: 503 });
  if (req.headers.get("x-worker-token") !== token)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = await createWorkerClient();
  if (!sb) return NextResponse.json({ error: "worker account not configured" }, { status: 503 });

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 20), 100);

  const { data: attempts, error } = await sb
    .from("send_attempts")
    .select(
      "id, channel, scheduled_for, outreach_target_id, draft:message_drafts(subject, body), contact:media_contacts(kind, value), target:outreach_targets(article_url, media:media(name, domain, no_solicitation))"
    )
    .eq("result", "queued")
    .order("queued_at", { ascending: true })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = Date.now();
  const out = [];
  for (const a of attempts ?? []) {
    const target = a.target as unknown as { article_url: string; media?: { name: string; domain: string; no_solicitation: boolean } } | null;
    if (target?.media?.no_solicitation) continue;
    if (a.scheduled_for && new Date(a.scheduled_for).getTime() > now) continue;

    const { data: past } = await sb
      .from("send_attempts")
      .select("result")
      .eq("outreach_target_id", a.outreach_target_id)
      .neq("id", a.id);
    if ((past ?? []).some((p) => BLOCKING_RESULTS.includes(p.result))) continue;

    const draft = a.draft as unknown as { subject: string; body: string } | null;
    const contact = a.contact as unknown as { kind: string; value: string } | null;
    if (!contact?.value) continue;

    out.push({
      attempt_id: a.id,
      channel: contact.kind || a.channel,
      to: contact.value,
      media: target?.media?.name || target?.media?.domain,
      domain: target?.media?.domain,
      subject: draft?.subject ?? "",
      body: draft?.body ?? "",
    });
  }

  return NextResponse.json({ count: out.length, items: out });
}
