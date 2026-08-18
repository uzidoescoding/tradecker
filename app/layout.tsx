import type { Metadata } from "next";
import Background from "@/components/Background";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tradecker",
  description:
    "Finds the trades that provably profitable traders are independently agreeing on, from live on chain positions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {/* Explicit z-0 rather than a negative index: a fixed element behind a
            painted body background is ambiguous across browsers, so the content
            is lifted to z-10 instead. */}
        <Background />
        <div className="relative z-10 flex min-h-full flex-1 flex-col">{children}</div>
      </body>
    </html>
  );
}
