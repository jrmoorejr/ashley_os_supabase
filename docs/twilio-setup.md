# Twilio setup for Market Pager

Market Pager sends pages from a Twilio number. US carriers block business texts from unregistered numbers, so the number has to be approved before market. **Start this first. Approval takes days to weeks.**

## 1. Pick the number type

| | Toll-free (recommended) | Local 10DLC |
|---|---|---|
| Approval | Toll-free verification, typically 5–14 days | Brand + campaign registration; campaign review currently 10–15 days |
| Fees | No registration fee | ~$19.50 one-time + $1.50/mo (Low-Volume Standard brand, Low-Volume Mixed campaign) |
| Sender reps see | 8XX number | Local area code |

Fees and timelines are from Twilio's documentation as of October 2026. Check the console for current numbers.

**Before you start, decide whose business is registering.** Both options ask for a legal business name, address, and website, and usually a tax ID (EIN). Use your own rep agency or LLC if you have one. Don't register under Ashley's name or tax ID without company approval.

## 2. Create the account and buy the number

1. Sign up at twilio.com and **upgrade to a paid account**. Add about $20. Trial accounts can only text phone numbers you've verified, and they add a "trial account" prefix to every text.
2. **Phone Numbers → Buy a number.** Choose *Toll-free*, or a local number for 10DLC, with SMS capability.
3. Fill in the **toll-free verification** form (*Phone Numbers → Regulatory Compliance → Toll-free verifications*), or the **A2P 10DLC** brand and campaign forms (*Messaging → Regulatory Compliance*). The answers below fit both.

## 3. Copy-paste answers for the form

Replace the parts in [brackets].

**Use case / category:** Account notifications (internal team alerts). For 10DLC, choose the *Low Volume Mixed* campaign type.

**Campaign / use case description:**
> [Business name] uses this number to send internal paging alerts to its own sales representatives during furniture market events (High Point, NC and Las Vegas, NV). When a dealer customer finishes viewing one product division in our showroom, a rep pages the next division, and the reps assigned to that division receive a text saying which dealer is ready for them. Messages go only to our own team members. No marketing or promotional content is sent.

**Message volume:** Under 100 messages per day, during market weeks only.

**How recipients opt in:**
> Recipients are [Business name] sales representatives. Each rep gives their mobile number to the sales manager on our team roster and agrees, in writing (email or signed roster), to receive showroom paging texts during market events. The manager then adds them to our internal Market Pager app. Reps can reply STOP at any time to stop messages, and HELP for help.

Keep those email or roster agreements. Carriers can ask for proof of opt-in.

**Sample messages:**
1. `MARKET PAGE: Furnitureland South (Shelby Sari) is ready for Case Goods. Sent by J.R. Moore. [app link] Reply STOP to opt out.`
2. `MARKET PAGE: Fleet Plummer (Reid Plummer) is ready for Bedding / Accents. Sent by Avery Lee. [app link] Reply STOP to opt out.`

**Opt-out / help keywords:** STOP, HELP. Twilio handles these automatically.

**Opt-in confirmation message (if the form asks):**
> You're on the [Business name] Market Pager team list and will get showroom paging texts during market. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.

**Website:** your business website. For 10DLC, it should show the business name and match what's on the form.

## 4. While you wait for approval

- Put the number into Supabase so the app can use it once approval comes through:
  ```bash
  supabase secrets set TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx TWILIO_FROM=+18885550000
  ```
  The Account SID and Auth Token are on the Twilio console home page.
- Pages still post to the board and beep in the app without texts. If Twilio isn't approved in time for market, the app still works on the floor.
- Once approved, send yourself a test page from the app and check the *notification_log* table in Supabase. Each text shows as `sent` or `failed`, with Twilio's reason.
