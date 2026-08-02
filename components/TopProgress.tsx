"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * 画面遷移のローディングバー。
 * 内部リンクのクリックを拾って即座にバーを出し、URL が変わったら自動的に消える。
 * 「押したのに何も起きない」体感をなくすのが目的。
 * （フォーム送信中の表示は SubmitButton 側が担当）
 */
export default function TopProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const key = `${pathname}?${searchParams?.toString() ?? ""}`;

  // 「どの URL にいるときにクリックされたか」を持つ。
  // URL が変われば key が変わるので、setState なしで自然に消える。
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const active = startedAt !== null && startedAt === key;

  const start = useCallback((k: string) => setStartedAt(k), []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const el = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
      if (!el) return;
      const href = el.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (el.target && el.target !== "_self") return;
      if (el.hasAttribute("download")) return;
      try {
        const url = new URL(el.href, window.location.href);
        if (url.origin !== window.location.origin) return;
        if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      } catch {
        return;
      }
      start(`${window.location.pathname}?${window.location.search.replace(/^\?/, "")}`);
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [start]);

  if (!active) return null;

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px] overflow-hidden">
        <div className="h-full w-2/5 animate-[nprogress_1.1s_ease-in-out_infinite] rounded-r-full bg-[#C1553B]" />
      </div>
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex items-center gap-2 rounded-full bg-[#1B2A4A]/95 px-3 py-1.5 text-[11px] font-medium text-white shadow-lg">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        読み込み中…
      </div>
    </>
  );
}
