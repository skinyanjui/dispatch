import type { Metadata } from "next";
import { RequestAccess } from "@/components/request-access";

export const metadata: Metadata = { title: "Request access · Relay" };

export default function Page() {
  return <RequestAccess />;
}
