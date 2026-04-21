const { normalizePhone, textOrEmpty } = require("../helpers");

function normalizeEnvelope(payload) {
  if (Array.isArray(payload)) {
    const first = payload[0] || {};
    if (first?.body && typeof first.body === "object") {
      return first.body;
    }
    return first;
  }

  if (payload?.body && typeof payload.body === "object") {
    return payload.body;
  }

  return payload || {};
}

function getTextFromUazapiMessage(message = {}, chat = {}, eventPayload = {}) {
  const candidates = [
    message?.text,
    message?.content,
    message?.edited,
    message?.reaction,
    chat?.wa_lastMessageTextVote,
    eventPayload?.text,
  ];

  for (const candidate of candidates) {
    const text = textOrEmpty(candidate);
    if (text) return text;
  }

  return "";
}

function getSenderNumber(message = {}, chat = {}) {
  return normalizePhone(
    message?.sender_pn ||
      message?.chatid ||
      message?.sender ||
      chat?.wa_chatid ||
      chat?.phone ||
      chat?.id
  );
}

function parseUazapiInboundPayload(payload) {
  const eventPayload = normalizeEnvelope(payload);
  const eventType = String(eventPayload?.EventType || "").trim().toLowerCase();
  const message = eventPayload?.message || {};
  const chat = eventPayload?.chat || {};

  if (!eventType) return [];

  const from = getSenderNumber(message, chat);
  const text = getTextFromUazapiMessage(message, chat, eventPayload);
  const isGroup = Boolean(message?.isGroup || chat?.wa_isGroup);

  return [
    {
      provider: "uazapi",
      eventType,
      messageId: String(message?.messageid || message?.id || "").trim(),
      from,
      to: normalizePhone(message?.receiver || eventPayload?.receiver || ""),
      fromMe: Boolean(message?.fromMe),
      isGroup,
      text,
      profileName: textOrEmpty(message?.senderName || chat?.name || chat?.wa_name),
      instanceToken: textOrEmpty(eventPayload?.token),
      raw: {
        eventPayload,
      },
    },
  ];
}

module.exports = {
  parseUazapiInboundPayload,
};
