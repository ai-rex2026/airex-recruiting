import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { signOut } from "@/app/actions";
import TopProgress from "@/components/TopProgress";
import SubmitButton from "@/components/SubmitButton";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

type NavItem = { href: string; label: string };

// UIは調査フェーズ（収集 → 陣取りボード → メディア台帳）に絞る。
// 打診・承認・送信・返信・掲載のルートは実装済みだがナビには出さない（URL直アクセスでは動作する）。
const NAV_SECTIONS: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: "/start", label: "案件・収集" },
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
  const { user, profile } = await getSessionProfile();
  if (!user || !profile) redirect("/login");

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
                  className="block rounded-lg px-3 py-2 text-[13px] text-slate-700 transition hover:bg-slate-100"
                >
                  {n.label}
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
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}
