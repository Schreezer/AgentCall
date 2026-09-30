import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const BRIDGE = "test-bridge-token-32-chars-long-value";
const AGENT = "test-hermes-token-32-chars-long-value";
const CALL_ID = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_CALL_ID = "550e8400-e29b-41d4-a716-446655440002";

async function seedInbound(callID = CALL_ID) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO vobiz_inbound_calls
       (id, direction, from_number, to_number, status, provider_status,
        vobiz_call_uuid, bridge_claimed_at, bridge_connected_at, created_at, updated_at)
     VALUES (?1, 'inbound', ?2, ?3, 'connected', 'answered', ?4, ?5, ?5, ?5, ?5)`,
  ).bind(callID, "+919000000001", "+918071580171",
    crypto.randomUUID(), now).run();
}

async function report(event, inboundReport = "Caller said: Please call back.", extra = {}, callID = CALL_ID) {
  return SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${callID}/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BRIDGE}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ event, inbound_report: inboundReport, ...extra }),
  });
}

async function claim() {
  return SELF.fetch("https://relay.example/v1/vobiz/bridge/notifications/claim", {
    method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
  });
}

async function reject(callID, reason, token = BRIDGE) {
  return SELF.fetch(`https://relay.example/v1/vobiz/bridge/notifications/${callID}/reject`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

describe("durable Caller notification outbox", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM vobiz_caller_notification_outbox").run();
    await env.DB.prepare("DELETE FROM vobiz_inbound_calls").run();
  });

  it("queues an ended inbound call once and exposes a bounded attributed caller reason", async () => {
    await seedInbound();
    expect((await report("ended")).status).toBe(200);
    expect((await report("ended")).status).toBe(200);
    const rows = await env.DB.prepare("SELECT * FROM vobiz_caller_notification_outbox").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ call_id: CALL_ID, status: "pending", attempt_count: 0 });
    const pending = await (await SELF.fetch(
      `https://relay.example/v1/inbound-calls/${CALL_ID}`,
      { headers: { authorization: `Bearer ${AGENT}` } },
    )).json();
    expect(pending.owner_notification_status).toBe("pending");
    const list = await (await SELF.fetch("https://relay.example/v1/inbound-calls", {
      headers: { authorization: `Bearer ${AGENT}` },
    })).json();
    expect(list.calls[0].owner_notification_status).toBe("pending");

    expect((await SELF.fetch("https://relay.example/v1/vobiz/bridge/notifications/claim", {
      method: "POST",
    })).status).toBe(401);
    const response = await claim();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notification: {
      call_id: CALL_ID,
      idempotency_key: `vobiz-inbound-${CALL_ID}`,
      caller_name: "Hermes",
      message: "Caller said (unverified): Please call back.",
      attempt: 1,
    } });
  });

  it("uses only saved caller speech, redacts digits and controls, and bounds Unicode text", async () => {
    await seedInbound();
    const speech = "मुझे डॉक्टर से बात करनी है। मेरा नंबर +91 9000000001 और ١٢٣ है। \u202e\u0007" +
      "कृपया कल फ़ोन करें। ".repeat(20);
    expect((await report("ended", `Caller said: ${speech}`, {
      summary: "Private Hermes context must not appear in a notification.",
    })).status).toBe(200);
    const item = (await (await claim()).json()).notification;
    expect(item.message).toMatch(/^Caller said \(unverified\): मुझे डॉक्टर/);
    expect(item.message).not.toContain("Private Hermes context");
    expect(item.message).not.toContain("9000000001");
    expect(item.message).toContain("[number omitted]");
    expect(item.message).not.toContain("\u202e");
    expect(item.message).not.toContain("\u0007");
    expect(item.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{N}]/u);
    expect([...item.message].length).toBeLessThanOrEqual(180);
    expect(item.message.length).toBeLessThan(500);
  });

  it("labels a Sol-inferred reason as unverified, redacts it, and freezes the short alert", async () => {
    await seedInbound();
    const reason = "मेरा अपॉइंटमेंट बदलने के लिए कॉल किया; कृपया +91 9855145900 पर वापस फ़ोन करें। "
      .repeat(12) + "\u202e\u0007";
    expect((await report("ended", `Likely reason (inferred, unverified): ${reason}`, {
      summary: "Private Hermes context must never appear in the alert.",
    })).status).toBe(200);
    const first = (await (await claim()).json()).notification;
    expect(first.message).toMatch(/^Likely reason \(inferred, unverified\): मेरा अपॉइंटमेंट/);
    expect(first.message).not.toContain("Caller said");
    expect(first.message).not.toContain("Private Hermes context");
    expect(first.message).not.toContain("9855145900");
    expect(first.message).toContain("[number omitted]");
    expect(first.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{N}]/u);
    expect([...first.message].length).toBeLessThanOrEqual(180);
    expect((await report("ended", "Likely reason (inferred, unverified): New claim after delivery."))
      .status).toBe(200);
    const saved = await env.DB.prepare(
      "SELECT inbound_report FROM vobiz_inbound_calls WHERE id = ?1",
    ).bind(CALL_ID).first();
    expect(saved.inbound_report).toContain("मेरा अपॉइंटमेंट");
    expect(saved.inbound_report).not.toContain("9855145900");
    expect(saved.inbound_report).not.toContain("New claim after delivery");
    const queued = await env.DB.prepare(
      "SELECT message FROM vobiz_caller_notification_outbox WHERE call_id = ?1",
    ).bind(CALL_ID).first();
    expect(queued.message).toBe(first.message);
  });

  it("redacts long, separated, and non-ASCII numbers before saving reports and summaries", async () => {
    await seedInbound();
    const callerSpeech = "Caller said: मेरा अपॉइंटमेंट बदलना है। Call +91 (9855) 145-900 " +
      "या ९८५५१४५९००; code 12-34-56. \u202e\u0007 कल बात करें।";
    expect((await report("ended", callerSpeech, {
      summary: "Appointment changed, contact 9855145900 or ١٢٣٤٥٦٧٨٩٠. \u202e\u0007",
    })).status).toBe(200);
    const saved = await env.DB.prepare(
      "SELECT summary, inbound_report FROM vobiz_inbound_calls WHERE id = ?1",
    ).bind(CALL_ID).first();
    expect(saved.inbound_report).toContain("मेरा अपॉइंटमेंट बदलना है");
    expect(saved.inbound_report).toContain("[number omitted]");
    expect(saved.inbound_report).toContain("[code omitted]");
    expect(saved.summary).toContain("Appointment changed");
    expect(saved.summary).toContain("[number omitted]");
    for (const value of [saved.summary, saved.inbound_report]) {
      expect(value).not.toMatch(/9855145900|9855|९८५५|١٢٣٤|12-34-56/);
      expect(value).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    }
  });

  it("falls back when the saved report has no caller message", async () => {
    await seedInbound();
    expect((await report("ended", "No caller message captured.")).status).toBe(200);
    const item = (await (await claim()).json()).notification;
    expect(item.message).toBe("Hermes answered an incoming call. Ask Hermes for the call result.");
  });

  it("uses the generic alert for a caller message containing only a redacted number", async () => {
    await seedInbound();
    expect((await report("ended", "Caller said: १२३४५६")).status).toBe(200);
    const item = (await (await claim()).json()).notification;
    expect(item.message).toBe("Hermes answered an incoming call. Ask Hermes for the call result.");
  });

  it("uses the generic alert for an inferred reason containing only a redacted number", async () => {
    await seedInbound();
    expect((await report("ended", "Likely reason (inferred, unverified): १२३४५६"))
      .status).toBe(200);
    const item = (await (await claim()).json()).notification;
    expect(item.message).toBe("Hermes answered an incoming call. Ask Hermes for the call result.");
  });

  it("keeps the generic body for a pending row created before the message migration", async () => {
    await seedInbound();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO vobiz_caller_notification_outbox
         (call_id, status, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?1, 'pending', 0, ?2, ?2, ?2)`,
    ).bind(CALL_ID, now).run();
    await env.DB.prepare(
      "UPDATE vobiz_inbound_calls SET inbound_report = ?2 WHERE id = ?1",
    ).bind(CALL_ID, "Caller said: New report after an old generic delivery.").run();
    const item = (await (await claim()).json()).notification;
    expect(item.message).toBe("Hermes answered an incoming call. Ask Hermes for the call result.");
  });

  it("survives a send-before-ack crash and retries with the same idempotency key", async () => {
    await seedInbound();
    await report("ended");
    const first = (await (await claim()).json()).notification;
    expect(await (await claim()).json()).toEqual({ notification: null });

    expect((await report("ended", "Caller said: Changed story after delivery.")).status).toBe(200);
    const saved = await env.DB.prepare(
      "SELECT inbound_report FROM vobiz_inbound_calls WHERE id = ?1",
    ).bind(CALL_ID).first();
    expect(saved.inbound_report).toBe("Caller said: Please call back.");

    await env.DB.prepare(
      "UPDATE vobiz_caller_notification_outbox SET next_attempt_at = 0 WHERE call_id = ?1",
    ).bind(CALL_ID).run();
    const retried = (await (await claim()).json()).notification;
    expect(retried.idempotency_key).toBe(first.idempotency_key);
    expect(retried.message).toBe(first.message);
    expect(retried.attempt).toBe(2);

    const ackURL = `https://relay.example/v1/vobiz/bridge/notifications/${CALL_ID}/ack`;
    const options = { method: "POST", headers: { authorization: `Bearer ${BRIDGE}` } };
    expect((await SELF.fetch(ackURL, options)).status).toBe(200);
    expect((await SELF.fetch(ackURL, options)).status).toBe(200);
    expect(await (await claim()).json()).toEqual({ notification: null });
    expect(await env.DB.prepare(
      "SELECT status, sent_at FROM vobiz_caller_notification_outbox WHERE call_id = ?1",
    ).bind(CALL_ID).first()).toMatchObject({ status: "sent" });
    const sent = await (await SELF.fetch(
      `https://relay.example/v1/inbound-calls/${CALL_ID}`,
      { headers: { authorization: `Bearer ${AGENT}` } },
    )).json();
    expect(sent.owner_notification_status).toBe("sent");
  });

  it("quarantines a permanent failure and still claims the next due alert", async () => {
    await seedInbound();
    expect((await report("ended")).status).toBe(200);
    await env.DB.prepare(
      "UPDATE vobiz_caller_notification_outbox SET created_at = 1 WHERE call_id = ?1",
    ).bind(CALL_ID).run();
    await seedInbound(SECOND_CALL_ID);
    expect((await report("ended", "Caller said: A different caller needs help.", {},
      SECOND_CALL_ID)).status).toBe(200);

    expect((await reject(CALL_ID, "caller_relay_conflict")).status).toBe(409);
    expect((await reject(CALL_ID, "caller_relay_conflict", "wrong-bridge-token")).status).toBe(401);
    const first = (await (await claim()).json()).notification;
    expect(first.call_id).toBe(CALL_ID);
    expect((await reject(CALL_ID, "arbitrary caller text")).status).toBe(400);
    expect((await reject(CALL_ID, "caller_relay_conflict")).status).toBe(200);
    expect((await reject(CALL_ID, "caller_relay_conflict")).status).toBe(200);
    const quarantined = await env.DB.prepare(
      "SELECT status, quarantined_at, quarantine_reason FROM vobiz_caller_notification_outbox WHERE call_id = ?1",
    ).bind(CALL_ID).first();
    expect(quarantined.status).toBe("pending");
    expect(quarantined.quarantined_at).toEqual(expect.any(Number));
    expect(quarantined.quarantine_reason).toBe("caller_relay_conflict");
    const firstDetail = await (await SELF.fetch(
      `https://relay.example/v1/inbound-calls/${CALL_ID}`,
      { headers: { authorization: `Bearer ${AGENT}` } },
    )).json();
    expect(firstDetail.owner_notification_status).toBe("failed");
    const list = await (await SELF.fetch("https://relay.example/v1/inbound-calls", {
      headers: { authorization: `Bearer ${AGENT}` },
    })).json();
    expect(list.calls.find((item) => item.id === CALL_ID).owner_notification_status).toBe("failed");
    expect((await SELF.fetch(
      `https://relay.example/v1/vobiz/bridge/notifications/${CALL_ID}/ack`,
      { method: "POST", headers: { authorization: `Bearer ${BRIDGE}` } },
    )).status).toBe(409);

    const second = (await (await claim()).json()).notification;
    expect(second.call_id).toBe(SECOND_CALL_ID);
    expect(second.message).toContain("A different caller needs help.");
    await env.DB.prepare(
      "UPDATE vobiz_caller_notification_outbox SET next_attempt_at = 0 WHERE call_id = ?1",
    ).bind(CALL_ID).run();
    expect(await (await claim()).json()).toEqual({ notification: null });
  });

  it("leases one due alert to only one concurrent claimant", async () => {
    await seedInbound();
    expect((await report("ended")).status).toBe(200);
    const [first, second] = await Promise.all([claim(), claim()]);
    const notifications = [
      (await first.json()).notification,
      (await second.json()).notification,
    ];
    expect(notifications.filter(Boolean)).toHaveLength(1);
    expect(notifications.find(Boolean)).toMatchObject({ call_id: CALL_ID, attempt: 1 });
  });

  it("does not notify for a failed inbound call", async () => {
    await seedInbound();
    expect((await report("failed")).status).toBe(200);
    expect(await (await claim()).json()).toEqual({ notification: null });
    const detail = await (await SELF.fetch(
      `https://relay.example/v1/inbound-calls/${CALL_ID}`,
      { headers: { authorization: `Bearer ${AGENT}` } },
    )).json();
    expect(detail.owner_notification_status).toBeNull();
  });
});
