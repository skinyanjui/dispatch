import type { Metadata } from "next";
import "./globals.css";
import "./workspace-shell.css";
import "./check-ins.css";
import "./operations.css";
import "./onboarding.css";
import "./sidebar.css";
import "./density.css";
import "./system.css";
import "./login.css";
import "./marketing.css";
import "./workspace-look.css";
import "./assistant.css";
import "./fleet.css";
import "./controls.css";
import "./loads.css";
import "./exceptions.css";
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
