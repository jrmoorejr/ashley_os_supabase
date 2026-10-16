# Twilio setup for Market Pager

Market Pager sends pages from a Twilio number. US carriers block business texts from unregistered numbers, so the number has to be approved before market. **Start this first. Approval takes days to weeks.**

## 1. Pick the number type

| | Toll-free (recommended) | Local 10DLC |
|---|---|---|
| Approval | Toll-free verification, typically 5–14 days | Brand + campaign registration; campaign review currently 10–15 days |
| Fees | No registration fee | ~$19.50 one-time + $1.50/mo (Low-Volume Standard brand, Low-Volume Mixed campaign) |
| Sender reps see | 8XX number | Local area code |

Fees and timelines are from Twilio's documentation as of October 2026. Check the console for current numbers.

**Business on the form:** Creative Connection by Christy, Inc., 4500 Treebark Lane, High Point, NC 27265. Website: https://encmotion.com. Contact: J.R. Moore, President, jrmoore@encmotion.com. Enter the EIN in Twilio's business registration number field. It isn't stored in this repo.

## 2. Create the account and buy the number

1. Sign up at twilio.com and **upgrade to a paid account**. Add about $20. Trial accounts can only text phone numbers you've verified, and they add a "trial account" prefix to every text.
2. **Phone Numbers → Buy a number.** Choose *Toll-free*, or a local number for 10DLC, with SMS capability.
3. Fill in the **toll-free verification** form (*Phone Numbers → Regulatory Compliance → Toll-free verifications*), or the **A2P 10DLC** brand and campaign forms (*Messaging → Regulatory Compliance*). The answers below fit both.

## 3. Copy-paste answers for the form

The only blank left is [app link]: your hosted app address once it is live. If it is not live yet, leave the link out of the samples.

**Use case / category:** Account notifications (internal team alerts). For 10DLC, choose the *Low Volume Mixed* campaign type.

**Campaign / use case description:**
> Creative Connection by Christy, Inc. uses this number to send internal paging alerts to members of its furniture market showroom team during market events (High Point, NC and Las Vegas, NV). When a dealer customer finishes viewing one product division in our showroom, a rep pages the next division, and the reps assigned to that division receive a text saying which dealer is ready for them. Messages go only to showroom team members who opted in. No marketing or promotional content is sent.

**Message volume:** Under 100 messages per day, during market weeks only.

**How recipients opt in:**
> Recipients are members of our furniture market showroom team. Each member opts in themselves: the first time they sign in to our Market Pager web app, they enter their mobile number and check an unchecked box next to this disclosure: "I agree to receive Market Pager text alerts from Creative Connection by Christy, Inc. at the cell number above when a dealer is ready for my division during furniture market events. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Agreeing is not required to use the app. SMS Terms and Privacy Policy: encmotion.com". We store the time and exact wording of each opt-in. Members who don't check the box never receive texts. A confirmation text is sent right after opt-in. Terms: https://encmotion.com

**Proof of opt-in (if asked for a screenshot or URL):** take a screenshot of step 3 *Text alerts* on the app's first-login setup screen. Supabase's `team_members` table shows each rep's `sms_consent_at` time and `sms_consent_text`.

**Sample messages:**
1. `MARKET PAGE: Furnitureland South (Shelby Sari) is ready for Case Goods. Sent by J.R. Moore. [app link] Reply STOP to opt out.`
2. `MARKET PAGE: Fleet Plummer (Reid Plummer) is ready for Bedding / Accents. Sent by Avery Lee. [app link] Reply STOP to opt out.`

**Opt-out / help keywords:** STOP, HELP. Twilio handles these automatically.

**Opt-in confirmation message (if the form asks):**
> Market Pager: You're signed up for showroom paging texts from Creative Connection by Christy, Inc. during market. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.

**Website:** https://encmotion.com. It must be live (not a "coming soon" page) and show the business name, contact info, SMS terms and a privacy policy. See [website-copy-for-sms-verification.md](website-copy-for-sms-verification.md).

## 4. While you wait for approval

- Put the number into Supabase so the app can use it once approval comes through:
  ```bash
  supabase secrets set TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx TWILIO_FROM=+18885550000
  ```
  The Account SID and Auth Token are on the Twilio console home page.
- Pages still post to the board and beep in the app without texts. If Twilio isn't approved in time for market, the app still works on the floor.
- Once approved, send yourself a test page from the app and check the *notification_log* table in Supabase. Each text shows as `sent` or `failed`, with Twilio's reason.
