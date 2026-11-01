import { loadSettings, saveSettings, loadState, nextSend, checkPin, BUILD_VERSION } from "../../lib/core.mjs";

export default async (req) => {
  const denied = checkPin(req);
  if (denied) return denied;

  let settings;
  if (req.method === "PUT" || req.method === "POST") {
    settings = await saveSettings(await req.json());
  } else {
    settings = await loadSettings();
  }
  const state = await loadState();
  return Response.json({
    settings,
    buildVersion: BUILD_VERSION,
    lastRun: state.lastRun || null,
    lastSentAt: state.lastSentAt || null,
    nextSend: nextSend(settings, state),
    defaultRecipient: process.env.GMAIL_USER || null,
    aiAvailable: !!process.env.ANTHROPIC_API_KEY,
  });
};

export const config = { path: "/api/settings" };
