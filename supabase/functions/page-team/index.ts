// page-team: texts and emails every active team member in the paged division(s).
//
// POST { page_ids: string[] }   (called by the web app with the user's session token)
//
// Secrets (supabase secrets set ...):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM   -> SMS (optional)
//   RESEND_API_KEY, PAGER_FROM_EMAIL                      -> email (optional)
//   PAGER_APP_URL                                         -> link included in the page (optional)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Result = { status: "sent" | "failed" | "skipped"; detail: string };

async function sendSms(to: string, body: string): Promise<Result> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM");
  if (!sid || !token || !from) return { status: "skipped", detail: "Twilio not configured" };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${token}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok
    ? { status: "sent", detail: data.sid ?? "ok" }
    : { status: "failed", detail: data.message ?? `HTTP ${res.status}` };
}

async function sendEmail(to: string, subject: string, text: string): Promise<Result> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("PAGER_FROM_EMAIL");
  if (!key || !from) return { status: "skipped", detail: "Resend not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok
    ? { status: "sent", detail: data.id ?? "ok" }
    : { status: "failed", detail: data.message ?? `HTTP ${res.status}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  // Confirm the caller is on the team list, using their own session.
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: isMember, error: memberErr } = await userClient.rpc("is_team_member");
  if (memberErr || !isMember) return json({ error: "Not on the team list" }, 403);

  const { page_ids } = await req.json().catch(() => ({ page_ids: [] }));
  if (!Array.isArray(page_ids) || page_ids.length === 0) return json({ error: "page_ids required" }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: pages, error: pagesErr } = await admin
    .from("pages")
    .select(`id, division_id, requested_by,
             division:divisions(name),
             requester:team_members!pages_requested_by_fkey(full_name),
             visit:visits(party, dealer:dealers(name))`)
    .in("id", page_ids)
    .is("claimed_at", null)
    .is("cancelled_at", null);
  if (pagesErr) return json({ error: pagesErr.message }, 500);
  if (!pages?.length) return json({ sent: 0, note: "No open pages" });

  const divisionIds = [...new Set(pages.map((p) => p.division_id))];
  const { data: links, error: linkErr } = await admin
    .from("member_divisions")
    .select("division_id, member:team_members(id, full_name, email, phone, notify_sms, notify_email, active)")
    .in("division_id", divisionIds);
  if (linkErr) return json({ error: linkErr.message }, 500);

  const appUrl = Deno.env.get("PAGER_APP_URL") ?? "";
  const log: Record<string, unknown>[] = [];

  // Group by member so someone covering two paged divisions gets one message.
  const byMember = new Map<string, { member: any; pages: any[] }>();
  for (const page of pages) {
    for (const link of links ?? []) {
      const m: any = link.member;
      if (link.division_id !== page.division_id || !m?.active) continue;
      // Don't page the person who sent the page.
      if (m.id === page.requested_by) continue;
      const entry = byMember.get(m.id) ?? { member: m, pages: [] };
      entry.pages.push(page);
      byMember.set(m.id, entry);
    }
  }

  for (const { member, pages: mine } of byMember.values()) {
    const first: any = mine[0];
    const dealer = first.visit?.dealer?.name ?? "A dealer";
    const party = first.visit?.party ? ` (${first.visit.party})` : "";
    const divisions = mine.map((p: any) => p.division?.name).join(" / ");
    const from = first.requester?.full_name ? ` Sent by ${first.requester.full_name}.` : "";
    const text = `MARKET PAGE: ${dealer}${party} is ready for ${divisions}.${from}` + (appUrl ? ` ${appUrl}` : "");

    // Carriers require opt-out instructions on business texts; Twilio handles STOP/HELP replies itself.
    const sms: Result = member.notify_sms && member.phone
      ? await sendSms(member.phone, `${text} Reply STOP to opt out.`)
      : { status: "skipped", detail: member.phone ? "SMS off for member" : "No phone" };
    const email: Result = member.notify_email && member.email
      ? await sendEmail(member.email, `Market page: ${dealer} → ${divisions}`, text)
      : { status: "skipped", detail: "Email off for member" };

    for (const p of mine) {
      log.push({ page_id: p.id, member_id: member.id, channel: "sms", destination: member.phone, ...sms });
      log.push({ page_id: p.id, member_id: member.id, channel: "email", destination: member.email, ...email });
    }
  }

  if (log.length) await admin.from("notification_log").insert(log);

  const sent = log.filter((l) => l.status === "sent").length;
  return json({ members: byMember.size, sent, skipped: log.filter((l) => l.status === "skipped").length,
    failed: log.filter((l) => l.status === "failed").length });
});
