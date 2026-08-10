import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** ダッシュボードは廃止（旧リンク・ブックマーク用にルートだけ残し、標準の入口へ転送する） */
export default function DashboardPage() {
  redirect("/start");
}
