import Link from "next/link";
import type { ReactNode } from "react";

export function Card({
  title,
  desc,
  children,
  action,
}: {
  title?: string;
  desc?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3">
          <div>
            {title && <h2 className="text-sm font-bold text-slate-900">{title}</h2>}
            {desc && <p className="mt-0.5 text-xs text-slate-500">{desc}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = "bg-slate-100 text-slate-700",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone}`}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-[#1B2A4A]">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

export const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[#1B2A4A] focus:ring-1 focus:ring-[#1B2A4A]";
export const btnPrimary =
  "inline-flex items-center justify-center rounded-lg bg-[#1B2A4A] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#25375f] disabled:opacity-50";
export const btnAccent =
  "inline-flex items-center justify-center rounded-lg bg-[#C1553B] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#a9482f] disabled:opacity-50";
export const btnGhost =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50";
export const btnSmall =
  "inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50";
export const labelCls = "block text-xs font-semibold text-slate-600 mb-1";
