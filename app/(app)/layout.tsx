import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { signOut } from "@/app/actions";

export const dynamic = "force-dynamic";

const NAV = [
  { href: "/dashboard", label: "ダッシュボード" },
  { href: "/queue", label: "承認キュー", key: "queue" },
  { href: "/board", label: "陣取りボード" },
  { href: "/collect", label: "収集" },
  { href: "/media", label: "メディア台帳" },
  { href: "/outbox", label: "送信ログ" },
  { href: "/exceptions", label: "例外対応", key: "exceptions" },
  { href: "/replies", label: "返信・交渉" },
  { href: "/placements", label: "掲載・報告" },
  { href: "/campaigns", label: "案件・KW" },
  { href: "/templates", label: "文面テンプレ" },
  { href: "/settings", label: "設定" },
  { href: "/audit", label: "監査ログ" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { sb, user, profile } = await getSessionProfile();
  if (!user || !profile) redirect("/login");

  const [{ count: queueCount }, { count: excCount }] = await Promise.all([
    sb
      .from("outreach_targets")
      .select("id", { count: "exact", head: true })
      .in("status", ["awaiting_approval", "replied"]),
    sb
      .from("outreach_targets")
      .select("id", { count: "exact", head: true })
      .in("status", ["exception", "uncertain"]),
  ]);
  const counts: Record<string, number> = {
    queue: queueCount ?? 0,
    exceptions: excCount ?? 0,
  };

  return (
    <div className="flex min-h-screen">
      <aside className="no-print w-56 shrink-0 border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-4">
          <p className="text-[10px] font-bold tracking-wider text-[#C1553B]">AI-REX RECRUITING</p>
          <p className="mt-0.5 text-sm font-bold text-[#1B2A4A]">リクルーティング基盤</p>
        </div>
        <nav className="p-2">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-[13px] text-slate-700 transition hover:bg-slate-100"
            >
              <span>{n.label}</span>
              {n.key && counts[n.key] > 0 && (
                <span className="rounded-full bg-[#C1553B] px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {counts[n.key]}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-4">
          <p className="text-xs font-medium text-slate-700">{profile.full_name || user.email}</p>
          <p className="text-[11px] text-slate-400">{profile.role}</p>
          <form action={signOut}>
            <button className="mt-2 text-[11px] text-slate-500 underline hover:text-slate-800">
              ログアウト
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}
