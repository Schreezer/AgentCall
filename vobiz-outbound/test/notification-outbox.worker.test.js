import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const BRIDGE = "test-bridge-token-32-chars-long-value";
const AGENT = "test-hermes-token-32-chars-long-value";
const CALL_ID = "550e8400-e29b-41d4-a716-446655440000";

async function seedInbound() {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO vobiz_inbound_calls
       (id, direction, from_number, to_number, status, provider_status,
        vobiz_call_uuid, bridge_claimed_at, bridge_connected_at, created_at, updated_at)
     VALUES (?1, 'inbound', ?2, ?3, 'connected', 'answered', ?4, ?5, ?5, ?5, ?5)`,
  ).bind(CALL_ID, "+919000000001", "+918071580171",
    "550e8400-e29b-41d4-a716-446655440001", now).run();
}

async function report(event) {
  return SELF.fetch(`https://relay.example/v1/vobiz/bridge/calls/${CALL_ID}/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BRIDGE}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ event, inbound_report: "Please call back." }),
  });
}

async function claim() {
  return SELF.fetch("https://relay.example/v1/vobiz/bridge/notifications/claim", {
    method: "POST", headers: { authorization: `Bearer ${BRIDGE}` },
  });
}

describe("durable Caller notification outbox", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM vobiz_caller_notification_outbox").run();
    await env.DB.prepare("DELETE FROM vobiz_inbound_calls").run();
  });

  it("queues an ended inbound call once and exposes only a fixed low-detail alert", async () => {
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
      message: "Hermes answered an incoming call. Ask Hermes for the call result.",
      attempt: 1,
    } });
  });

  it("survives a send-before-ack crash and retries with the same idempotency key", async () => {
    await seedInbound();
    await report("ended");
    const first = (await (await claim()).json()).notification;
    expect(await (await claim()).json()).toEqual({ notification: null });

    await env.DB.prepare(
      "UPDATE vobiz_caller_notification_outbox SET next_attempt_at = 0 WHERE call_id = ?1",
    ).bind(CALL_ID).run();
    const retried = (await (await claim()).json()).notification;
    expect(retried.idempotency_key).toBe(first.idempotency_key);
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
