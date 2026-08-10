import Link from "next/link";
import OutboxView from "@/components/OutboxView";

export const dynamic = "force-dynamic";

export default function OutboxPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">送信ログ</h1>
        <p className="mt-1 text-xs text-slate-500">
          承認済みの送信キューと、送信結果の分類。実際の送信は外部ワーカー（form-outreach-runner）が実行します。
        </p>
        <p className="mt-1 text-xs">
          <Link href="/queue?tab=outbox" className="text-slate-500 underline hover:text-slate-700">
            承認キューのタブでも表示できます
          </Link>
        </p>
      </header>
      <OutboxView />
    </div>
  );
}
