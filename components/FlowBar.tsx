"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type FlowCounts = {
  /** 収集済・対象確定（陣取りボードの未処理） */
  collect: number;
  /** 承認待ち＋送信待ち */
  outreach: number;
  /** 例外・不確定 */
  exceptions: number;
  /** 送信済（返事待ち）＋返信あり＋交渉中 */
  reply: number;
  /** 掲載可能（登録待ち）＋掲載中（報告待ち） */
  place: number;
};

type Step = {
  label: string;
  sub: string;
  href: string;
  paths: string[];
  count: (c: FlowCounts) => number;
};

const STEPS: Step[] = [
  {
    label: "① 集める",
    sub: "陣取りボード",
    href: "/start",
    paths: ["/start", "/collect", "/board"],
    count: (c) => c.collect,
  },
  {
    label: "② 打診する",
    sub: "承認キュー",
    href: "/queue",
    paths: ["/queue", "/outbox", "/exceptions"],
    count: (c) => c.outreach,
  },
  {
    label: "③ 返信・交渉",
    sub: "返信・交渉",
    href: "/replies",
    paths: ["/replies"],
    count: (c) => c.reply,
  },
  {
    label: "④ 掲載・報告",
    sub: "掲載・報告",
    href: "/placements",
    paths: ["/placements", "/reports"],
    count: (c) => c.place,
  },
];

/** 全画面の上部に出す業務フローバー。現在地のハイライトと「待っている件数」を表示する。 */
export default function FlowBar({ counts }: { counts: FlowCounts }) {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="業務フロー" className="no-print mb-6 overflow-x-auto">
      <ol className="flex w-max items-center gap-1 whitespace-nowrap">
        {STEPS.map((s, i) => {
          const active = s.paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
          const n = s.count(counts);
          return (
            <li key={s.href} className="flex items-center gap-1">
              {i > 0 && <span className="px-0.5 text-slate-300">›</span>}
              <Link
                href={s.href}
                title={s.sub}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1 transition ${
                  active
                    ? "border-[#1B2A4A] bg-[#1B2A4A] text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                <span className="flex flex-col leading-tight">
                  <span className="text-[11px] font-semibold">{s.label}</span>
                  <span className={`text-[9px] ${active ? "text-white/70" : "text-slate-400"}`}>
                    {s.sub}
                  </span>
                </span>
                {n > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                      active ? "bg-white/20 text-white" : "bg-[#C1553B] text-white"
                    }`}
                  >
                    {n}
                  </span>
                )}
              </Link>
              {s.href === "/queue" && counts.exceptions > 0 && (
                <Link
                  href="/queue?tab=exceptions"
                  title="例外対応"
                  className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700 hover:bg-red-200"
                >
                  +例外{counts.exceptions}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
