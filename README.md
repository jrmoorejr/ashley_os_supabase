# Market Pager

A pager board for market. Check a dealer in, track which division and rep they're walking with, and when a division finishes, page the next division(s) by text and email. Every phone on the team sees the same live board.

## What it does

| On the floor | How it works |
|---|---|
| **Dealer arrives** | *Check in* tab. Returning dealers autofill. Optionally page a division right away. |
| **Rep starts walking them** | **Start walk** → pick the division + rep → the division timer starts. |
| **Division is done** | **✓ Finished** → "Where to next?" pops up. Multi-select Motion, Case Goods, Bedding, Stationary, Accents. Divisions they've already seen are **grayed out**. Then **📟 Page selected**. |
| **Paged rep responds** | Gets a text + email, and the app beeps and vibrates on their phone. They tap **On my way**, then **Start walk** when they reach the dealer. |
| **Anyone on the team** | Sees who's here, who they're with, who's being paged, who's on the way, plus a **total showroom timer** and a **current division timer** for every dealer. |
| **Dealer leaves** | **They're done — check out**. All open pages are cancelled. |
| **After market** | *Log* tab: dealers seen per division, average minutes per division, reach %, and a full visit path. **Export CSV** opens straight in Excel. |

Each dealer card shows division chips: ● with them now · 🔔 paged · ✓ already seen (struck through).

## Try it now (no setup)

Open `web/index.html` through any static server, for example `cd web && python3 -m http.server`, then visit http://localhost:8000. With no Supabase settings, the app runs in **Demo mode**: sample team, everything saved in this browser.

To feel the paging: open two tabs. In tab 2, go to *Settings → Acting as* and pick **Riley Brooks** (Bedding). In tab 1, finish a walk and page Bedding. Tab 2 lights up.

## Go live for the team (≈20 minutes)

1. **Create a Supabase project** at supabase.com (the free tier is fine for a market).
2. **Create the database.** Open *SQL Editor*, paste in `supabase/migrations/20261016000000_market_pager.sql`, and run it. Or use the CLI: `supabase link` then `supabase db push`.
3. **Add yourself as the first admin.** Admins can add everyone else from the app.
   ```sql
   insert into team_members (full_name, email, phone, role)
   values ('Your Name', 'you@company.com', '+13365550100', 'admin');
   ```
4. **Turn on email sign-in.** Under *Authentication → Providers*, leave Email enabled. Under *Authentication → URL Configuration*, add your hosted app URL to the redirect URLs. Optional, but helpful on phones: in *Authentication → Email Templates → Magic Link*, add `{{ .Token }}` so the email also includes a 6-digit code. That lets people sign in even if the link opens in a different browser.
5. **Set up the texts and emails.** Deploy the Edge Function and set its secrets:
   ```bash
   supabase functions deploy page-team
   supabase secrets set \
     TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx TWILIO_FROM=+13365550000 \
     RESEND_API_KEY=re_xxxx PAGER_FROM_EMAIL="Market Pager <pager@yourdomain.com>" \
     PAGER_APP_URL=https://your-hosted-app-url
   ```
   - **SMS:** a Twilio number. US numbers that send texts to business contacts need A2P 10DLC registration, which can take a few days, so start it early.
   - **Email:** Resend, with a verified sending domain.
   - Either channel can be skipped. Pages still post to the board and the in-app alert still fires, and the notification log records the skipped channel as `skipped`.
6. **Point the app at your project.** Put your Project URL and anon key in `web/config.js`. Both are in *Project Settings → API*. The anon key is safe to publish, because row-level security blocks anyone not on the team list.
7. **Host the `web/` folder** on any static host: Netlify, Vercel, Cloudflare Pages, or GitHub Pages. It has no build step.
8. **Load the team.** In the app, go to *Team → Import CSV* and paste from Excel. Columns are `Name, Email, Cell, Divisions, Role`, with multiple divisions separated by `;`. See `web/sample-team.csv`. Phone numbers are normalized to +1 format automatically.
9. **Start the market.** Go to *Settings → Start new market* (e.g. "Las Vegas Winter 2027"). Each market keeps its own log.

On every rep's phone: sign in, tap **🔔 Enable alerts**, and add the page to the home screen.

## Access rules

- Only emails on the team list (and marked active) can see or change anything.
- **Reps:** check in dealers, start and finish walks, page, and check out.
- **Admins:** also manage the team, divisions, and markets.
- A rep isn't paged for a page they sent themselves.

## Project layout

```
supabase/migrations/…_market_pager.sql   tables, row-level security, realtime, walkthrough_log view
supabase/functions/page-team/index.ts    sends the SMS + email for a page, logs results
web/index.html, app.js, store.js, styles.css, config.js   the app (no build step)
web/sample-team.csv                       team import template
```

## Notes and limits

- **Adding a division** (e.g. Outdoor): *Settings → Divisions → Add*. It appears everywhere immediately.
- **Timers:** computed from the start times saved to the database, so every phone shows the same numbers. The board also refreshes every 30 seconds in case a realtime message is missed on spotty convention-center wifi.
- **Background alerts:** the in-app beep works while the app is open. Reps who lock their phone get the text message.
- **Reporting:** the `walkthrough_log` view in Supabase has one row per division walk, with minutes, for pivot tables.
