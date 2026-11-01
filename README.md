# News Feed — emailed news digest

Get an email with the latest headlines on topics you choose, on a schedule you choose. You change both from a settings page (it also works on your phone). It runs on Netlify, so it keeps sending when your PC is off.

## How it works
- **Settings page** (`public/index.html`): your topics, schedule, recipients and options. It's protected by a PIN.
- **Hourly job** (`netlify/functions/scheduled-digest.mjs`): Netlify runs it every hour. It checks your schedule and only sends when an email is due.
- **News source**: Google News search feeds, one search per topic. Stories already sent are remembered, so they don't show up twice.
- **Optional Claude briefing**: a 2–3 sentence summary at the top of each topic, written from the headlines only.
- **Storage**: Netlify Blobs holds your settings and the send history. It's built into Netlify, so there are no Firebase keys to set up.

## Setup (about 15 minutes)

1. **Make a Gmail app password.** Go to Google Account → Security → 2-Step Verification → App passwords and create one called "News Feed". If your stock scanner already has one, you can reuse it.
2. **Make a GitHub repo** (for example `news-feed`) and upload everything in this folder except `node_modules`. In GitHub, use Add file → Upload files.
3. **On Netlify**, choose Add new site → Import from Git and pick the repo. No build command is needed; leave the publish folder as `public` (it's already set in `netlify.toml`).
   *Drag-and-drop deploys won't work here, because the functions need their packages installed. Netlify only does that for Git-connected sites.*
4. **Add environment variables** under Site configuration → Environment variables:

   | Variable | Value |
   |---|---|
   | `ADMIN_PIN` | Any PIN or password you choose for the settings page |
   | `GMAIL_USER` | Your Gmail address (emails come from it, and it's the default recipient) |
   | `GMAIL_APP_PASSWORD` | The 16-character app password from step 1 |
   | `ANTHROPIC_API_KEY` | *Optional.* Turns on the Claude briefings |
   | `CLAUDE_MODEL` | *Optional.* The default is `claude-haiku-5-5` (the cheapest). For example, `claude-sonnet-5-5` gives richer summaries |

5. **Redeploy** (Deploys → Trigger deploy) so the variables take effect.
6. Open the site, enter your PIN, set up your topics, then use **Preview** and **Send test**.

## Using it
- **Topics**: each topic has a name, a search (`"exact phrase"`, `OR`, `-word` all work) and an optional list of words to leave out. Use the toggle to turn a topic off without deleting it.
- **Schedule**:
  - *At set times*: tap the hours you want (for example 7a and 5p) and the days.
  - *Every few hours*: pick every 1–168 hours, plus a quiet window (for example only between 6 AM and 9 PM).
- **Pause all emails** stops sending and keeps your settings.
- **Send test** gets the last 24 hours of stories. It doesn't change the schedule or what counts as already sent.
- Each scheduled email includes only stories that are new since the previous one.

## Notes
- Times use the time zone on the settings page. The default is America/Phoenix, which has no daylight saving time.
- Netlify checks the schedule once an hour, on the hour, so emails go out at the top of the hour.
- If a send fails (for example a wrong app password), the schedule doesn't move forward, and the error shows under **Last run** on the settings page. Function logs are under Netlify → Logs → Functions.
- Bump `BUILD_VERSION` in both `lib/core.mjs` and `public/index.html` when you change things.
