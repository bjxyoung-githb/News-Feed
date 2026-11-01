// Runs every hour; sends the digest only when the schedule says it's due.
import { loadSettings, loadState, isDue, runDigest } from "../../lib/core.mjs";

export default async () => {
  const settings = await loadSettings();
  const state = await loadState();
  const now = new Date();
  if (!isDue(settings, state, now)) return new Response("not due");
  const result = await runDigest({ mode: "scheduled", settings, state, now });
  console.log("digest:", JSON.stringify(result));
  return Response.json(result);
};

export const config = { schedule: "@hourly" };
