import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    app: "AI-Rex Recruiting",
    time: new Date().toISOString(),
    supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    worker: !!process.env.WORKER_TOKEN,
  });
}
