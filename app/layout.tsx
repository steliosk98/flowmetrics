import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowMetrics — Own your energy data",
  description: "A self-hosted energy historian for home batteries and solar systems.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
