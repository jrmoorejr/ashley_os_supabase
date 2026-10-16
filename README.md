# Market Pager

A pager board for market. Check a dealer in, track which division and rep they're walking with, and when a division finishes, page the next division(s) by text and email. Every phone on the team sees the same live board.

## What it does

| On the floor | How it works |
|---|---|
| **Dealer arrives** | A check-in text puts them on the board automatically (see below). Or use the *Check in* tab, where returning dealers autofill and you can page a division right away. |
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

## Check dealers in by text (automatic)

If check-in alerts already arrive as text messages, the app can read them. A clear text ("Coastal Home has checked in with Mary and 2 buyers") puts the dealer on the board as **Here**, tagged *via text*, with no typing. An unclear text goes to a **review inbox** at the top of the Floor tab, where anyone can fix the name and tap Check in. A dealer who is already on the board is never added twice.

**Set up the receiving end once:**
```bash
supabase db push   # or run supabase/migrations/20261016010000_text_checkin.sql in the SQL Editor
supabase functions deploy inbound-checkin   # supabase/config.toml turns off the login check for this one
supabase secrets set INBOUND_TOKEN=pick-a-long-random-password \
  INBOUND_ALLOWED_FROM=+13365550000          # the number(s) the check-in texts come from
```
The function's address is `https://<your-project>.supabase.co/functions/v1/inbound-checkin`.

**Then pick how the texts reach it.** Options are listed from most to least automatic.

1. **Have the texts sent to the app's number.** This is the best option when the alerts come from a system or a front desk. In Twilio, open *Phone Numbers → your number → Messaging → "A message comes in"*, choose *Webhook, HTTP POST*, and paste the function address. Then ask whoever sends the check-in texts to add that number to their list. No phone is involved.
2. **Auto-forward from an iPhone** (iOS 17 or later). **This is the recommended setup for the market's own check-in texts**, which come from short code **274-539** (saved on most phones as "High Point/Las Vegas"). Short codes usually can't text a Twilio number, so the phone has to pass them along. On one or more reps' iPhones:
   1. Open **Shortcuts → Automation → + (New Automation) → Message**.
   2. **Sender → Choose →** the *High Point/Las Vegas* contact (274-539). Set **Message Contains** to `Meet`, so only check-ins are sent.
   3. Select **Run Immediately** and turn off *Notify When Run*. Tap **Next → New Blank Automation**.
   4. Add the action **Get Contents of URL**. Paste the function address, then tap the arrow to show more options:
      - **Method:** POST
      - **Headers:** add `x-pager-token` = your INBOUND_TOKEN
      - **Request Body:** JSON. Add a *Text* field with key `text`, and set its value to *Shortcut Input*. Tap that variable and choose **Content**.
   5. Tap **Done**.

   Every check-in text from the market now reaches the board within seconds, and the phone doesn't need to be unlocked.

   **Every rep who gets market texts needs this automation on their own phone.** The market texts only the rep the buyer asked for ("J.R. MOORE – Meet …"), so a check-in addressed to Avery never reaches J.R.'s phone. When the market sends the same text twice, or a buyer asks for two reps, the dealer is still checked in only once.

   From `J.R. MOORE – Meet SHELBY SARI from FURNITURELAND SOUTH at Front Desk`, the app records:
   - **Dealer:** Furnitureland South
   - **Who's with them:** Shelby Sari
   - **Asked for:** J.R. Moore (linked to the team member with that name)
   - **Waiting at:** Front Desk

   Opt-in confirmations and similar texts are skipped. The *Mine* filter on the Floor shows dealers who asked for you.
3. **Auto-forward from Android.** Use an SMS-forwarding app such as MacroDroid, Tasker, or SMS Forwarder. Have it post the same JSON to the same address with the same header, or forward the text to the Twilio number.
4. **By hand, with the form filled for you.** Copy the market text in Messages, open the app's *Check in* tab, and tap **📋 Paste text**. Dealer, buyer, who they asked for, and where they're waiting all fill in instantly, and you tap **Check in**. If the dealer is already on the floor, the app tells you. You can also long-press the text and forward it to the app's number; team members' cell numbers are trusted automatically.
5. **Review before checking in.** If you'd rather glance at each one first, build the iPhone automation from option 2 with a different action: in place of *Get Contents of URL*, use **Open URLs** with `https://<your-app-address>/?text=` followed by *Shortcut Input → Content*. Each market text opens the app on *Check in* with the form already filled. This works on the hosted app only, not the Claude demo link.

**Rules the app follows:**
- A dealer it already knows (by name or account number) is always matched.
- A new name is checked in when the text clearly says so ("X checked in", "X is here", "X arrived", "Dealer: X").
- Texts from numbers that aren't on the team list or `INBOUND_ALLOWED_FROM` always go to the review inbox.
- `INBOUND_AUTO_CHECKIN=false` sends every text to the inbox.
- `INBOUND_SMS_REPLY=false` stops the confirmation reply ("Checked in: Coastal Home").

Test it without a phone:
```bash
curl -X POST https://<your-project>.supabase.co/functions/v1/inbound-checkin \
  -H "x-pager-token: <INBOUND_TOKEN>" -H "content-type: application/json" \
  -d '{"text":"Coastal Home has checked in with Mary Jones"}'
```
The parser is tuned for common wording. Send a few real check-in texts through it (with phone numbers removed) and adjust `supabase/functions/_shared/checkin-parser.js` to match. `node tests/parser.test.mjs` checks the parser against the sample texts.

## Access rules

- Only emails on the team list (and marked active) can see or change anything.
- **Reps:** check in dealers, start and finish walks, page, and check out.
- **Admins:** also manage the team, divisions, and markets.
- A rep isn't paged for a page they sent themselves.

## Project layout

```
supabase/migrations/…_market_pager.sql   tables, row-level security, realtime, walkthrough_log view
supabase/functions/page-team/index.ts    sends the SMS + email for a page, logs results
supabase/functions/inbound-checkin/      receives check-in texts and puts dealers on the board
supabase/functions/_shared/checkin-parser.js  reads dealer / party / account out of a text (copied to web/)
web/index.html, app.js, store.js, styles.css, config.js   the app (no build step)
web/sample-team.csv                       team import template
```

## Notes and limits

- **Adding a division** (e.g. Outdoor): *Settings → Divisions → Add*. It appears everywhere immediately.
- **Timers:** computed from the start times saved to the database, so every phone shows the same numbers. The board also refreshes every 30 seconds in case a realtime message is missed on spotty convention-center wifi.
- **Background alerts:** the in-app beep works while the app is open. Reps who lock their phone get the text message.
- **Reporting:** the `walkthrough_log` view in Supabase has one row per division walk, with minutes, for pivot tables.
