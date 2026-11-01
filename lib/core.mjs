// Shared logic for the News Feed digest: settings, scheduling, fetching, email.
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

export const BUILD_VERSION = "1.0.0";

export const DEFAULT_SETTINGS = {
  timezone: "America/Phoenix",
  recipients: [],               // empty = send to GMAIL_USER
  topics: [
    { id: "t1", name: "Artificial intelligence", query: "\"artificial intelligence\" OR OpenAI OR Anthropic", exclude: "", enabled: true },
    { id: "t2", name: "Stock market", query: "stock market OR \"S&P 500\" OR Nasdaq", exclude: "", enabled: true },
  ],
  schedule: {
    mode: "times",              // "times" = at chosen hours | "interval" = every N hours
    hours: [7, 17],             // local hours (0-23) for "times" mode
    days: [0, 1, 2, 3, 4, 5, 6],// 0 = Sunday
    intervalHours: 6,           // for "interval" mode
    activeStart: 6,             // interval mode: only send between these local hours (inclusive)
    activeEnd: 21,
  },
  maxPerTopic: 8,
  aiSummary: true,
  skipIfEmpty: true,
  paused: false,
};

// ---------- storage (Netlify Blobs – no setup or keys needed) ----------
const store = () => getStore({ name: "newsfeed", consistency: "strong" });

export async function loadSettings() {
  const s = await store().get("settings", { type: "json" });
  return normalizeSettings(s || DEFAULT_SETTINGS);
}
export async function saveSettings(s) {
  const clean = normalizeSettings(s);
  await store().setJSON("settings", clean);
  return clean;
}
export async function loadState() {
  return (await store().get("state", { type: "json" })) || { sentKeys: [] };
}
export async function saveState(st) {
  await store().setJSON("state", st);
}

// ---------- validation ----------
const int = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
export function normalizeSettings(input) {
  const d = DEFAULT_SETTINGS;
  const s = input || {};
  const sch = s.schedule || {};
  const uniqInts = (arr, lo, hi) =>
    [...new Set((Array.isArray(arr) ? arr : []).map((x) => parseInt(x, 10)).filter((x) => x >= lo && x <= hi))].sort((a, b) => a - b);
  return {
    timezone: validTz(s.timezone) ? s.timezone : d.timezone,
    recipients: (Array.isArray(s.recipients) ? s.recipients : [])
      .map((e) => String(e).trim())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      .slice(0, 20),
    topics: (Array.isArray(s.topics) ? s.topics : d.topics)
      .map((t, i) => ({
        id: String(t.id || `t${Date.now()}${i}`).slice(0, 40),
        name: String(t.name || "").trim().slice(0, 80),
        query: String(t.query || "").trim().slice(0, 300),
        exclude: String(t.exclude || "").trim().slice(0, 300),
        enabled: t.enabled !== false,
      }))
      .filter((t) => t.name || t.query)
      .slice(0, 30),
    schedule: {
      mode: sch.mode === "interval" ? "interval" : "times",
      hours: sch.hours ? uniqInts(sch.hours, 0, 23) : d.schedule.hours,
      days: sch.days ? uniqInts(sch.days, 0, 6) : d.schedule.days,
      intervalHours: int(sch.intervalHours, 1, 168, d.schedule.intervalHours),
      activeStart: int(sch.activeStart, 0, 23, d.schedule.activeStart),
      activeEnd: int(sch.activeEnd, 0, 23, d.schedule.activeEnd),
    },
    maxPerTopic: int(s.maxPerTopic, 1, 25, d.maxPerTopic),
    aiSummary: s.aiSummary !== false,
    skipIfEmpty: s.skipIfEmpty !== false,
    paused: !!s.paused,
  };
}

// ---------- scheduling ----------
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: +p.hour % 24, weekday: WD.indexOf(p.weekday), slot: `${p.year}-${p.month}-${p.day}T${p.hour}` };
}

export function isDue(settings, state, now) {
  if (settings.paused) return false;
  const sch = settings.schedule;
  const lp = localParts(now, settings.timezone);
  if (!sch.days.includes(lp.weekday)) return false;
  if (sch.mode === "interval") {
    const inWindow = sch.activeStart <= sch.activeEnd
      ? lp.hour >= sch.activeStart && lp.hour <= sch.activeEnd
      : lp.hour >= sch.activeStart || lp.hour <= sch.activeEnd; // overnight window
    if (!inWindow) return false;
    if (!state.lastSentAt) return true;
    const elapsed = now - new Date(state.lastSentAt);
    return elapsed >= sch.intervalHours * 3600e3 - 10 * 60e3; // 10 min slack
  }
  return sch.hours.includes(lp.hour) && state.lastSlot !== lp.slot;
}

// Next hourly check at which a digest would go out (for display).
export function nextSend(settings, state, now = new Date()) {
  if (settings.paused) return null;
  let t = Math.ceil(now / 3600e3) * 3600e3 + 60e3;
  for (let i = 0; i < 24 * 8; i++, t += 3600e3) {
    if (isDue(settings, state, new Date(t))) return new Date(t - 60e3).toISOString();
  }
  return null;
}

// ---------- news fetching (Google News RSS) ----------
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}
export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const tag = (n) => { const r = body.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)); return r ? decode(r[1]) : ""; };
    const source = tag("source");
    let title = tag("title");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const pub = new Date(tag("pubDate"));
    items.push({ title, link: tag("link"), source, published: isNaN(pub) ? null : pub.toISOString() });
  }
  return items;
}
const keyOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);

async function fetchTopic(topic, lookbackHours) {
  const h = Math.max(1, Math.ceil(lookbackHours));
  const when = h <= 48 ? `${h}h` : `${Math.min(30, Math.ceil(h / 24))}d`;
  const q = `${topic.query || topic.name} when:${when}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (NewsFeedDigest)" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Google News returned ${res.status}`);
  return parseRss(await res.text());
}

// ---------- optional Claude summary ----------
async function summarize(sections) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return {};
  const withNews = sections.filter((s) => s.items.length);
  if (!withNews.length) return {};
  const prompt =
    "Below are recent news headlines grouped by topic. For each topic, write a 2-3 sentence plain-English briefing " +
    "of the main developments, based ONLY on these headlines (don't invent details). " +
    'Reply with JSON only: {"<topic name>": "<briefing>", ...}\n\n' +
    withNews.map((s) => `## ${s.name}\n` + s.items.map((i) => `- ${i.title} (${i.source})`).join("\n")).join("\n\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-haiku-5-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(18000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return {};
  }
}

// ---------- email ----------
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ago(iso, now) {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now - new Date(iso)) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
export function buildEmail(sections, summaries, settings, now, isTest) {
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const when = new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);
  const subject = `${isTest ? "[Test] " : ""}News Feed — ${when} · ${total} ${total === 1 ? "story" : "stories"}`;
  const toc = sections.map((s) => `<a href="#${esc(s.id)}" style="color:#2f5d8a;text-decoration:none;margin-right:12px;white-space:nowrap">${esc(s.name)} (${s.items.length})</a>`).join(" ");
  const body = sections.map((s) => {
    const summary = summaries[s.name] ? `<p style="margin:6px 0 12px;padding:10px 12px;background:#f3f6fa;border-left:3px solid #2f5d8a;color:#333;font-size:14px;line-height:1.5">${esc(summaries[s.name])}</p>` : "";
    const list = s.error
      ? `<p style="color:#a33;font-size:14px">Couldn't load this topic: ${esc(s.error)}</p>`
      : s.items.length
        ? s.items.map((i) => `<tr><td style="padding:7px 0;border-bottom:1px solid #eee"><a href="${esc(i.link)}" style="color:#1a1a1a;font-size:15px;line-height:1.4;text-decoration:none;font-weight:600">${esc(i.title)}</a><div style="color:#777;font-size:12px;margin-top:2px">${esc(i.source)}${i.published ? " · " + ago(i.published, now) : ""}</div></td></tr>`).join("")
        : `<tr><td style="color:#888;font-size:14px;padding:6px 0">No new stories since the last email.</td></tr>`;
    return `<h2 id="${esc(s.id)}" style="font-size:18px;margin:26px 0 4px;color:#1a1a1a;border-bottom:2px solid #1a1a1a;padding-bottom:4px">${esc(s.name)}</h2>${summary}<table width="100%" cellpadding="0" cellspacing="0">${list}</table>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#fafafa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#fff;padding:22px 22px 30px">
<div style="font-size:22px;font-weight:700;color:#1a1a1a">News Feed</div>
<div style="color:#777;font-size:13px;margin:2px 0 12px">${esc(when)} · ${total} ${total === 1 ? "story" : "stories"}</div>
<div style="font-size:13px;line-height:1.9">${toc}</div>
${body}
<p style="color:#999;font-size:11px;margin-top:28px">Headlines from Google News.${Object.keys(summaries).length ? " Briefings written by Claude from the headlines only." : ""} Change topics or schedule on your settings page. v${BUILD_VERSION}</p>
</div></body></html>`;
  const text = sections.map((s) => `== ${s.name} ==\n` + (summaries[s.name] ? summaries[s.name] + "\n" : "") + s.items.map((i) => `- ${i.title} (${i.source})\n  ${i.link}`).join("\n")).join("\n\n");
  return { subject, html, text, total };
}

async function sendMail(settings, mail) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD environment variables are not set");
  const to = settings.recipients.length ? settings.recipients : [user];
  const t = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await t.sendMail({ from: `"News Feed" <${user}>`, to: to.join(", "), subject: mail.subject, html: mail.html, text: mail.text });
  return to;
}

// ---------- main ----------
// mode: "scheduled" | "test" | "preview"
export async function runDigest({ mode = "scheduled", settings, state, now = new Date() } = {}) {
  settings = settings || (await loadSettings());
  state = state || (await loadState());
  const isScheduled = mode === "scheduled";
  const since = isScheduled && state.lastSentAt ? new Date(state.lastSentAt) : new Date(now - 24 * 3600e3);
  const lookback = Math.min(168, Math.max(1, (now - since) / 3600e3));
  const seen = new Set(isScheduled ? state.sentKeys || [] : []);
  const newKeys = [];

  const topics = settings.topics.filter((t) => t.enabled);
  const fetched = await Promise.all(topics.map((t) => fetchTopic(t, lookback).then((items) => ({ items }), (e) => ({ items: [], error: e.message }))));

  const sections = topics.map((t, idx) => {
    const ex = t.exclude.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    const items = [];
    for (const it of fetched[idx].items) {
      if (items.length >= settings.maxPerTopic) break;
      if (!it.title) continue;
      if (it.published && new Date(it.published) < since) continue;
      const lower = it.title.toLowerCase();
      if (ex.some((w) => lower.includes(w))) continue;
      const k = keyOf(it.title);
      if (seen.has(k)) continue;
      seen.add(k); newKeys.push(k); items.push(it);
    }
    return { id: t.id, name: t.name || t.query, items, error: fetched[idx].error };
  });

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const finish = async (status, extra = {}) => {
    if (isScheduled) {
      state.lastSentAt = now.toISOString();
      state.lastSlot = localParts(now, settings.timezone).slot;
      state.sentKeys = [...newKeys, ...(state.sentKeys || [])].slice(0, 3000);
    }
    state.lastRun = { at: now.toISOString(), mode, status, stories: total, ...extra };
    if (mode !== "preview") await saveState(state);
    return state.lastRun;
  };

  if (!topics.length) return finish("skipped: no topics enabled");
  if (isScheduled && total === 0 && settings.skipIfEmpty) return finish("skipped: no new stories");

  const summaries = settings.aiSummary ? await summarize(sections) : {};
  const mail = buildEmail(sections, summaries, settings, now, mode !== "scheduled");
  if (mode === "preview") return { status: "preview", stories: total, subject: mail.subject, html: mail.html };

  try {
    const to = await sendMail(settings, mail);
    return finish("sent", { to });
  } catch (e) {
    if (isScheduled) { // don't advance the schedule if the send failed
      state.lastRun = { at: now.toISOString(), mode, status: "error: " + e.message, stories: total };
      await saveState(state);
      return state.lastRun;
    }
    return finish("error: " + e.message);
  }
}

// ---------- auth helper for the settings API ----------
export function checkPin(req) {
  const pin = process.env.ADMIN_PIN;
  if (!pin) return new Response(JSON.stringify({ error: "ADMIN_PIN environment variable is not set on Netlify" }), { status: 500 });
  if (req.headers.get("x-pin") !== pin) return new Response(JSON.stringify({ error: "Wrong PIN" }), { status: 401 });
  return null;
}
