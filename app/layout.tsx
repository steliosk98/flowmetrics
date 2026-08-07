import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "FlowMetrics — Own your energy data",
    description: "A self-hosted energy historian for home batteries and solar systems.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title: "FlowMetrics", description: "Own your energy data.", type: "website", images: [{ url: image, width: 1200, height: 630, alt: "FlowMetrics energy analytics dashboard" }] },
    twitter: { card: "summary_large_image", title: "FlowMetrics", description: "Own your energy data.", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
