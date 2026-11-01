// Preview the digest in the browser, or send a test email right now.
// Test sends look back 24 hours and don't affect the schedule.
import { runDigest, checkPin } from "../../lib/core.mjs";

export default async (req) => {
  const denied = checkPin(req);
  if (denied) return denied;
  const { preview } = await req.json().catch(() => ({}));
  const result = await runDigest({ mode: preview ? "preview" : "test" });
  return Response.json(result);
};

export const config = { path: "/api/send-now" };
