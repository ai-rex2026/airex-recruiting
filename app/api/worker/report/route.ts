import { NextResponse, type NextRequest } from "next/server";
import { createWorkerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID = [
  "success",
  "uncertain",
  "form_error",
  "url_error",
  "captcha",
  "no_solicitation",
] as const;

/** ワーカーが送信結果を書き戻す。 */
export async function POST(req: NextRequest) {
  const token = process.env.WORKER_TOKEN;
  if (!token) return NextResponse.json({ error: "worker not configured" }, { status: 503 });
  if (req.headers.get("x-worker-token") !== token)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { attempt_id?: string; result?: string; detail?: string; evidence_path?: string }
    | null;
  if (!body?.attempt_id || !body.result)
    return NextResponse.json({ error: "attempt_id and result are required" }, { status: 400 });
  if (!VALID.includes(body.result as (typeof VALID)[number]))
    return NextResponse.json({ error: `result must be one of ${VALID.join(", ")}` }, { status: 400 });

  const sb = await createWorkerClient();
  if (!sb) return NextResponse.json({ error: "worker account not configured" }, { status: 503 });

  const { data: attempt } = await sb
    .from("send_attempts")
    .select("id, tenant_id, outreach_target_id, result")
    .eq("id", body.attempt_id)
    .maybeSingle();
  if (!attempt) return NextResponse.json({ error: "attempt not found" }, { status: 404 });
  if (attempt.result !== "queued")
    return NextResponse.json({ error: "already reported", result: attempt.result }, { status: 409 });

  await sb
    .from("send_attempts")
    .update({
      result: body.result,
      error_detail: body.detail ?? "",
      evidence_path: body.evidence_path ?? "",
      sent_at: new Date().toISOString(),
    })
    .eq("id", attempt.id);

  const next =
    body.result === "success"
      ? "sent"
      : body.result === "uncertain"
      ? "uncertain"
      : body.result === "no_solicitation"
      ? "excluded"
      : "exception";

  await sb
    .from("outreach_targets")
    .update({ status: next, status_reason: body.detail ?? "", updated_at: new Date().toISOString() })
    .eq("id", attempt.outreach_target_id);

  if (body.result === "no_solicitation") {
    const { data: t } = await sb
      .from("outreach_targets")
      .select("media_id")
      .eq("id", attempt.outreach_target_id)
      .maybeSingle();
    if (t)
      await sb
        .from("media")
        .update({ no_solicitation: true, no_solicitation_reason: body.detail || "送信時に検知" })
        .eq("id", t.media_id);
  }

  await sb.from("audit_logs").insert({
    tenant_id: attempt.tenant_id,
    actor_name: "worker",
    entity: "send_attempt",
    entity_id: attempt.id,
    action: `result:${body.result}`,
    detail: body.detail ?? "",
  });

  return NextResponse.json({ ok: true, status: next });
}
