import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { signOut } from "@/app/actions";
import TopProgress from "@/components/TopProgress";
import SubmitButton from "@/components/SubmitButton";
import FlowBar from "@/components/FlowBar";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

type NavItem = { href: string; label: string; key?: string };

// サイドバーは横断的な作業キューと台帳だけに絞る（4項目＋管理）。
// 例外対応・送信ログは 承認キュー(/queue) のタブ、案件ごとの画面は 案件詳細ハブ /campaigns/[id] のタブから辿る。
const NAV_SECTIONS: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: "/start", label: "案件・収集" },
      { href: "/queue", label: "承認キュー", key: "queue" },
      { href: "/media", label: "メディア台帳" },
    ],
  },
  {
    label: "管理",
    items: [
      { href: "/templates", label: "文面テンプレ" },
      { href: "/settings", label: "設定" },
      { href: "/audit", label: "監査ログ" },
    ],
  },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { sb, user, profile } = await getSessionProfile();
  if (!user || !profile) redirect("/login");

  // ステータスを1クエリで取得し、ナビのバッジと業務フローバーの件数をまとめて算出する
  const { data: statusRows } = await sb.from("outreach_targets").select("status");
  const countOf = (statuses: string[]) =>
    (statusRows ?? []).filter((t) => statuses.includes(t.status)).length;

  const counts: Record<string, number> = {
    queue: countOf(["awaiting_approval", "replied"]),
    exceptions: countOf(["exception", "uncertain"]),
  };
  const flowCounts = {
    collect: countOf(["collected", "confirmed"]),
    outreach: countOf(["awaiting_approval", "queued"]),
    exceptions: countOf(["exception", "uncertain"]),
    reply: countOf(["sent", "replied", "negotiating"]),
    place: countOf(["placeable", "placed"]),
  };

  return (
    <div className="flex min-h-screen">
      <Suspense fallback={null}>
        <TopProgress />
      </Suspense>
      <aside className="no-print w-56 shrink-0 border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-4">
          <p className="text-[10px] font-bold tracking-wider text-[#C1553B]">AI-REX RECRUITING</p>
          <p className="mt-0.5 text-sm font-bold text-[#1B2A4A]">リクルーティング基盤</p>
        </div>
        <nav className="p-2">
          {NAV_SECTIONS.map((sec, si) => (
            <div key={sec.label ?? si}>
              {sec.label && (
                <p className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {sec.label}
                </p>
              )}
              {sec.items.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-[13px] text-slate-700 transition hover:bg-slate-100"
                >
                  <span>{n.label}</span>
                  <span className="flex items-center gap-1">
                    {n.key && counts[n.key] > 0 && (
                      <span className="rounded-full bg-[#C1553B] px-1.5 py-0.5 text-[10px] font-bold text-white">
                        {counts[n.key]}
                      </span>
                    )}
                    {n.href === "/queue" && counts.exceptions > 0 && (
                      <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                        例外{counts.exceptions}
                      </span>
                    )}
                  </span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-4">
          <p className="text-xs font-medium text-slate-700">{profile.full_name || user.email}</p>
          <p className="text-[11px] text-slate-400">{profile.role}</p>
          <form action={signOut}>
            <SubmitButton variant="small" className="mt-2 !border-0 !bg-transparent !px-0 !text-[11px] !text-slate-500 underline" pendingLabel="…">
              ログアウト
            </SubmitButton>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        <FlowBar counts={flowCounts} />
        {children}
      </main>
    </div>
  );
}
