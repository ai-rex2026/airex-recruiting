import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI-Rex Recruiting — 広告リクルーティング業務 AI化アプリ",
  description:
    "ランキング／比較メディアへの掲載獲得業務を、AIが下書きし人は承認するだけで回すオペレーション基盤",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-slate-50 text-slate-900">
        {children}
      </body>
    </html>
  );
}
