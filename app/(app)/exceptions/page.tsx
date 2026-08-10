import Link from "next/link";
import ExceptionsView from "@/components/ExceptionsView";

export const dynamic = "force-dynamic";

export default function ExceptionsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">例外対応キュー</h1>
        <p className="mt-1 text-xs text-slate-500">
          自動化しない・できない件だけをここに集めます。CAPTCHA突破と営業お断りへの送信は行いません。
        </p>
        <p className="mt-1 text-xs">
          <Link href="/queue?tab=exceptions" className="text-slate-500 underline hover:text-slate-700">
            承認キューのタブでも表示できます
          </Link>
        </p>
      </header>
      <ExceptionsView />
    </div>
  );
}
