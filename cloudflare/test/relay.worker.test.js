import { env, exports } from "cloudflare:workers";
import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Cloudflare relay", () => {
  it("runs registration, pairing, audio, idempotency, and alarm delivery", async () => {
    const health = await exports.default.fetch("https://relay.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      storageReady: true,
      apnsReady: true,
    });

    const registration = await requestJSON("/v1/installations", {
      method: "POST",
      body: {
        token: "ab".repeat(32),
        platform: "ios",
        environment: "sandbox",
        device_name: "Workers test",
      },
    });
    expect(registration.status).toBe(201);

    const pairing = await requestJSON("/v1/pairings/claim", {
      method: "POST",
      body: { pairing_code: registration.body.pairing_code },
    });
    expect(pairing.status).toBe(200);

    const audioUpload = await exports.default.fetch("https://relay.test/v1/audio", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairing.body.agent_token}`,
        "content-type": "audio/mpeg",
        "idempotency-key": "workers-audio-test-0001",
        "x-audio-filename": "hello.mp3",
      },
      body: new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0]),
    });
    expect(audioUpload.status).toBe(201);
    const audio = await audioUpload.json();

    const downloaded = await exports.default.fetch(
      `https://relay.test/v1/installations/${registration.body.installation_id}/audio/${audio.audio_id}`,
      {
        headers: {
          authorization: `Bearer ${registration.body.installation_secret}`,
        },
      },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
      new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0]),
    );

    const callInput = {
      message: "Workers runtime delivery test",
      caller_name: "Test",
      audio_id: audio.audio_id,
      scheduled_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const first = await requestJSON("/v1/calls", {
      method: "POST",
      token: pairing.body.agent_token,
      idempotencyKey: "workers-call-test-0001",
      body: callInput,
    });
    const second = await requestJSON("/v1/calls", {
      method: "POST",
      token: pairing.body.agent_token,
      idempotencyKey: "workers-call-test-0001",
      body: callInput,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(first.body.status).toBe("scheduled");

    await env.DB.prepare("UPDATE calls SET scheduled_at = ?2 WHERE id = ?1")
      .bind(first.body.id, Date.now() - 1)
      .run();
    const scheduler = env.SCHEDULER.getByName(registration.body.installation_id);
    expect(await runDurableObjectAlarm(scheduler)).toBe(true);

    const terminal = await requestJSON(`/v1/calls/${first.body.id}`, {
      token: pairing.body.agent_token,
    });
    expect(terminal.status).toBe(200);
    expect(terminal.body.status).toBe("failed");
    expect(terminal.body.delivery_errors[0]).toMatch(/invalid base64|private key/i);

    const recovering = await requestJSON("/v1/calls", {
      method: "POST",
      token: pairing.body.agent_token,
      idempotencyKey: "workers-call-test-0002",
      body: {
        message: "Receipt recovery test",
        scheduled_at: new Date(Date.now() + 120_000).toISOString(),
      },
    });
    await env.DB.prepare(
      "UPDATE calls SET status = 'delivering', scheduled_at = ?2 WHERE id = ?1",
    )
      .bind(recovering.body.id, Date.now() - 1)
      .run();
    await runInDurableObject(scheduler, async (_instance, state) => {
      await state.storage.put(`apns-receipt:${recovering.body.id}`, {
        apnsID: recovering.body.id,
        deliveredAt: Date.now(),
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(scheduler)).toBe(true);
    const recovered = await requestJSON(`/v1/calls/${recovering.body.id}`, {
      token: pairing.body.agent_token,
    });
    expect(recovered.body.status).toBe("delivered");
  });
});

async function requestJSON(
  path,
  { method = "GET", body, token, idempotencyKey } = {},
) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  const response = await exports.default.fetch(`https://relay.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
