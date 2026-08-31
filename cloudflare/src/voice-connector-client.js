export async function connectorRequest(env, installationID, message) {
  const stub = env.VOICE_CONNECTOR.getByName(installationID);
  const response = await stub.fetch("https://voice-connector.internal/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  const payload = await response.json();
  if (!response.ok) {
    return { ok: false, status: response.status, error: payload?.error ?? "connector_failed" };
  }
  return payload;
}

export async function connectorStatus(env, installationID) {
  const response = await env.VOICE_CONNECTOR.getByName(installationID)
    .fetch("https://voice-connector.internal/status");
  return response.json();
}
