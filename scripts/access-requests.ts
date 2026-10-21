import { pool } from "../src/lib/db";
import {
  approveAccessRequest,
  declineAccessRequest,
  listAccessRequests,
} from "../src/lib/access-requests";

// Operator tool for access requests (ADR 0034). Requests come from the public
// "Request access" page or from Google/Apple sign-in by someone without an
// account. Nothing is created until you approve.
//   npm run access:list [pending|approved|declined]
//   npm run access:approve -- <request-id>
//   npm run access:decline -- <request-id> "reason"
const [command, a, b] = process.argv.slice(2);
try {
  if (command === "list") {
    const rows = await listAccessRequests(a || "pending");
    if (!rows.length) console.log("No requests.");
    for (const r of rows)
      console.log(
        `${r.id}  ${r.created_at.toString().slice(0, 16)}  ${r.source}${r.email_verified ? " (verified)" : ""}  ${r.name} <${r.email}>  ${r.company}${r.note ? "  — " + r.note : ""}`,
      );
  } else if (command === "approve" && a) {
    const result = await approveAccessRequest(a);
    console.log("Organization created:", result.organization_id);
    if (result.repeated) console.log("Already approved earlier.");
    else if (result.setup_link)
      console.log(
        "Send the owner this private link (works once, 7 days):\n" +
          result.setup_link +
          "\n(It is also queued as an email; that is only delivered if an email transport is configured.)",
      );
    else
      console.log("The person already had an account, which is now the owner.");
  } else if (command === "decline" && a) {
    await declineAccessRequest(a, b ?? "");
    console.log("Declined.");
  } else {
    console.error(
      "Usage: access:list [status] | access:approve -- <id> | access:decline -- <id> [reason]",
    );
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
