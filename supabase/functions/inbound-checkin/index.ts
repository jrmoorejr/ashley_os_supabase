// inbound-checkin: turns a check-in text message into a dealer on the floor board.
//
// Two ways in:
//   1. Twilio: set the number's "A message comes in" webhook to this function's URL.
//      Twilio's signature is verified. Texts from team phones or INBOUND_ALLOWED_FROM numbers
//      auto check in; texts from anyone else go to the review inbox.
//   2. JSON (iPhone Shortcut, Android forwarder, anything else):
//      POST { "text": "...", "from": "optional" } with header  x-pager-token: <INBOUND_TOKEN>
//
// Deploy without JWT checks (Twilio can't send a Supabase login):
//   supabase functions deploy inbound-checkin --no-verify-jwt
//
// Secrets: TWILIO_AUTH_TOKEN, INBOUND_TOKEN, optional INBOUND_ALLOWED_FROM (comma-separated
// numbers), INBOUND_AUTO_CHECKIN=false to send everything to the inbox, INBOUND_SMS_REPLY=false
// to skip the confirmation text, INBOUND_PUBLIC_URL if the function sits behind a custom domain.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { matchMember, parseCheckin } from "../_shared/checkin-parser.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pager-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const twiml = (message?: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${message.replace(/[<>&]/g, "")}</Message>` : ""}</Response>`,
    { headers: { "Content-Type": "text/xml" } },
  );

const digits = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);

async function twilioSignatureOk(req: Request, params: URLSearchParams): Promise<boolean> {
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const sig = req.headers.get("X-Twilio-Signature");
  if (!token || !sig) return false;
  const url = Deno.env.get("INBOUND_PUBLIC_URL") ?? `${Deno.env.get("SUPABASE_URL")}/functions/v1/inbound-checkin`;
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const isTwilio = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  let text = "", from: string | null = null, channel = "sms";

  if (isTwilio) {
    const params = new URLSearchParams(await req.text());
    if (!(await twilioSignatureOk(req, params))) return new Response("Bad signature", { status: 403 });
    text = params.get("Body") ?? "";
    from = params.get("From");
  } else {
    // The password can come from the INBOUND_TOKEN secret or from Settings in the app (app_settings).
    const given = req.headers.get("x-pager-token") ?? new URL(req.url).searchParams.get("token");
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: setting } = await svc.from("app_settings").select("value").eq("key", "inbound_token").maybeSingle();
    const valid = [Deno.env.get("INBOUND_TOKEN"), setting?.value].filter((t): t is string => !!t && t.length >= 16);
    if (!given || !valid.includes(given)) return json({ error: "Missing or wrong x-pager-token" }, 401);
    const body = await req.json().catch(() => ({}));
    text = String(body.text ?? body.body ?? body.message ?? "");
    from = body.from ? String(body.from) : null;
    channel = body.channel === "forward" ? "forward" : "shortcut";
  }
  if (!text.trim()) return isTwilio ? twiml() : json({ error: "text required" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = text.slice(0, 2000);

  // The whole team gets the same market text; if several phones forward it, handle it once.
  const { data: seen } = await admin.from("inbound_messages").select("id, status, parsed_dealer")
    .eq("body", body).gte("received_at", new Date(Date.now() - 15 * 60e3).toISOString())
    .limit(1).maybeSingle();
  if (seen) {
    return isTwilio ? twiml() : json({ status: "already_received", dealer: seen.parsed_dealer, first: seen.status });
  }
  const [{ data: market }, { data: dealers }, { data: members }] = await Promise.all([
    admin.from("markets").select("id, name").eq("is_active", true).maybeSingle(),
    admin.from("dealers").select("id, name, account_number"),
    admin.from("team_members").select("id, full_name, phone").eq("active", true),
  ]);

  const parsed = parseCheckin(text, dealers ?? []);

  // Opt-in confirmations and similar aren't check-ins: keep a record, but don't bother anyone.
  if (parsed.ignore) {
    await admin.from("inbound_messages").insert({ channel, from_number: from, body, confidence: "low", status: "ignored", handled_at: new Date().toISOString() });
    return isTwilio ? twiml() : json({ status: "ignored" });
  }
  const askedFor = matchMember(parsed.requestedRep, members ?? []);

  // Who do we trust to check someone in without a human looking first?
  const allowed = new Set([
    ...(members ?? []).map((m) => digits(m.phone)),
    ...(Deno.env.get("INBOUND_ALLOWED_FROM") ?? "").split(",").map(digits),
  ].filter(Boolean));
  const trusted = !isTwilio || allowed.has(digits(from));
  const auto = Deno.env.get("INBOUND_AUTO_CHECKIN") !== "false"
    && trusted && market && parsed.dealer && parsed.confidence !== "low";

  const { data: msg, error: msgErr } = await admin.from("inbound_messages").insert({
    channel, from_number: from, body,
    parsed_dealer: parsed.dealer, parsed_party: parsed.party, parsed_account: parsed.account,
    confidence: parsed.confidence,
  }).select().single();
  if (msgErr) return isTwilio ? twiml() : json({ error: msgErr.message }, 500);

  let result: { status: string; dealer?: string | null; reason?: string } = { status: "pending", dealer: parsed.dealer };

  if (auto) {
    let dealerId = parsed.dealerId;
    if (!dealerId) {
      dealerId = (dealers ?? []).find((d) => d.name.trim().toLowerCase() === parsed.dealer!.trim().toLowerCase())?.id ?? null;
      if (!dealerId) {
        const { data: created, error } = await admin.from("dealers")
          .insert({ name: parsed.dealer, account_number: parsed.account }).select("id").single();
        if (error?.code === "23505") {
          // Another phone's copy of this text created the dealer a moment ago.
          const { data: all } = await admin.from("dealers").select("id, name");
          dealerId = (all ?? []).find((d) => d.name.trim().toLowerCase() === parsed.dealer!.trim().toLowerCase())?.id ?? null;
        } else if (error) return isTwilio ? twiml() : json({ error: error.message }, 500);
        else dealerId = created.id;
        if (!dealerId) return isTwilio ? twiml() : json({ error: "Could not create dealer" }, 500);
      }
    }
    const { data: open } = await admin.from("visits").select("id")
      .eq("market_id", market!.id).eq("dealer_id", dealerId).is("checked_out_at", null).maybeSingle();
    if (open) {
      await admin.from("inbound_messages").update({ status: "duplicate", visit_id: open.id, handled_at: new Date().toISOString() }).eq("id", msg.id);
      result = { status: "duplicate", dealer: parsed.dealer };
    } else {
      const { data: visit, error } = await admin.from("visits").insert({
        market_id: market!.id, dealer_id: dealerId, party: parsed.party, source: "text",
        requested_rep_id: askedFor?.id ?? null, requested_rep_name: parsed.requestedRep, meet_location: parsed.location,
      }).select("id").single();
      if (error?.code === "23505") {
        // Another copy of this check-in won the race.
        await admin.from("inbound_messages").update({ status: "duplicate", handled_at: new Date().toISOString() }).eq("id", msg.id);
        result = { status: "duplicate", dealer: parsed.dealer };
      } else if (error) {
        return isTwilio ? twiml() : json({ error: error.message }, 500);
      } else {
        await admin.from("inbound_messages").update({ status: "checked_in", visit_id: visit.id, handled_at: new Date().toISOString() }).eq("id", msg.id);
        result = { status: "checked_in", dealer: parsed.dealer };
      }
    }
  } else {
    result.reason = !market ? "No active market" : !trusted ? "Sender not on the allowed list" : !parsed.dealer ? "Couldn't find a dealer name" : "Auto check-in is off";
  }

  if (isTwilio) {
    if (Deno.env.get("INBOUND_SMS_REPLY") === "false") return twiml();
    if (result.status === "checked_in") return twiml(`Checked in: ${result.dealer}`);
    if (result.status === "duplicate") return twiml(`${result.dealer} is already checked in`);
    return twiml(`Got it. Sent to the Market Pager inbox for review (${result.reason}).`);
  }
  return json(result);
});
