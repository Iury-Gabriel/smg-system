const { normalizePhone, textOrEmpty } = require("../helpers");

function parseMetaVerificationQuery(query = {}) {
  return {
    mode: String(query?.["hub.mode"] ?? query?.hub_mode ?? query?.mode ?? "")
      .trim()
      .toLowerCase(),
    verifyToken: String(
      query?.["hub.verify_token"] ?? query?.hub_verify_token ?? query?.verify_token ?? ""
    ).trim(),
    challenge: String(
      query?.["hub.challenge"] ?? query?.hub_challenge ?? query?.challenge ?? ""
    ).trim(),
  };
}

function getTextFromMetaMessage(message) {
  const candidates = [
    message?.text?.body,
    message?.button?.text,
    message?.interactive?.button_reply?.title,
    message?.interactive?.list_reply?.title,
    message?.interactive?.list_reply?.description,
    message?.image?.caption,
    message?.document?.caption,
  ];

  for (const candidate of candidates) {
    const text = textOrEmpty(candidate);
    if (text) return text;
  }

  return "";
}

function collectMetaValues(payload) {
  if (!payload || typeof payload !== "object") return [];

  const directShape =
    String(payload?.messaging_product || "").toLowerCase() === "whatsapp" &&
    payload?.metadata &&
    (Array.isArray(payload?.messages) || Array.isArray(payload?.statuses));
  if (directShape) return [payload];

  const values = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.value && typeof change.value === "object") {
        values.push(change.value);
      }
    }
  }

  return values;
}

function parseMetaInboundPayload(payload) {
  const values = collectMetaValues(payload);
  const events = [];

  for (const value of values) {
    const phoneNumberId = String(value?.metadata?.phone_number_id || "").trim();
    const displayPhone = normalizePhone(value?.metadata?.display_phone_number);
    const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
    const profileName = String(contacts?.[0]?.profile?.name || "").trim();

    const messages = Array.isArray(value?.messages) ? value.messages : [];
    for (const message of messages) {
      const from = normalizePhone(message?.from || contacts?.[0]?.wa_id);
      const text = getTextFromMetaMessage(message);
      events.push({
        provider: "meta",
        eventType: "messages",
        messageId: String(message?.id || "").trim(),
        from,
        to: displayPhone,
        fromMe: from && displayPhone ? from === displayPhone : false,
        isGroup: false,
        text,
        profileName,
        phoneNumberId,
        raw: {
          value,
          message,
        },
      });
    }

    const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
    for (const status of statuses) {
      events.push({
        provider: "meta",
        eventType: "status",
        messageId: String(status?.id || "").trim(),
        from: normalizePhone(status?.recipient_id),
        to: displayPhone,
        fromMe: true,
        isGroup: false,
        text: "",
        profileName: "",
        phoneNumberId,
        status: String(status?.status || "").trim().toLowerCase(),
        raw: {
          value,
          status,
        },
      });
    }
  }

  return events;
}

module.exports = {
  parseMetaVerificationQuery,
  parseMetaInboundPayload,
};
