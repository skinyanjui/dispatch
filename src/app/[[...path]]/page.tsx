import { notFound } from "next/navigation";
import Workspace from "@/components/dispatch-workspace";
import { parsePath } from "@/lib/routes";

/** Every signed-in address (`/loads/:id`, `/billing`, …) renders the workspace
 *  at that place; an address that names nothing is a 404. Static pages such as
 *  `/pricing` and `/demo`, and `/api`, are matched before this route. */
export default async function Page({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  let route = null;
  try {
    route = parsePath(path.map(decodeURIComponent));
  } catch {
    // A malformed %-escape names nothing.
  }
  if (!route) notFound();
  return <Workspace initialRoute={route} />;
}
