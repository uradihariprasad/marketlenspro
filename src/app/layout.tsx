import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "F&O Intraday Intelligence — Live Market Terminal",
  description:
    "Real-time intraday F&O market intelligence: dynamic S/R, order-flow estimation, option-chain positioning, structure analysis and disciplined trade candidates. Decision support, not prediction.",
  applicationName: "F&O Intelligence",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "F&O Intelligence",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#05070b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
