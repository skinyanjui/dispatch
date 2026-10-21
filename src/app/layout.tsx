import type { Metadata } from "next";
import "./globals.css";
import "./workspace-shell.css";
import "./check-ins.css";
export const metadata: Metadata = {
  title: "Relay · Dispatch workspace",
  description: "Carrier-scoped freight dispatch operations",
  icons: { icon: "/favicon.svg" },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
