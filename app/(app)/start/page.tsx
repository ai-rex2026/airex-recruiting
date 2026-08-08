import StartWizard from "./StartWizard";

export const dynamic = "force-dynamic";
// サーバーアクション（AI分析・Web検索収集）はこのページのセグメント設定で実行されるため、
// タイムアウトを 60 秒に引き上げておく（vercel.json でも全関数 60s を指定済み）。
export const maxDuration = 60;

export default function StartPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">かんたん開始</h1>
        <p className="mt-1 text-xs text-slate-500">
          商品のURL、または商品情報のテキストを入れるだけで、関連する比較・ランキング・おすすめサイトが自動で集まり、陣取り表が出来上がります。
        </p>
      </header>
      <StartWizard />
    </div>
  );
}
