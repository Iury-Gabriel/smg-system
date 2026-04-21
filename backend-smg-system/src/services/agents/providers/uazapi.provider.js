const axios = require("axios");
const env = require("../../../config/env");
const { normalizePhone, textOrEmpty } = require("../helpers");

function safeJson(value, max = 5000) {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > max ? `${raw.slice(0, max)}...<truncated>` : raw;
  } catch (_error) {
    return "<unserializable_payload>";
  }
}

function logUazapi(event, payload = {}) {
  const stamp = new Date().toISOString();
  console.log(`[providers.uazapi][${stamp}][${event}]`, payload);
}

function assertUazapiProviderConfig(providerConfig = {}) {
  const baseUrl = textOrEmpty(providerConfig.baseUrl || env.uazapiBaseUrl).replace(/\/+$/, "");
  const instanceToken = textOrEmpty(providerConfig.instanceToken);
  const sendMessagePath = textOrEmpty(
    providerConfig.sendMessagePath || env.uazapiSendMessagePath || "/send/text"
  );
  const sendMediaPath = textOrEmpty(
    providerConfig.sendMediaPath || env.uazapiSendMediaPath || "/send/media"
  );

  if (!baseUrl || !instanceToken) {
    const error = new Error(
      "Credenciais Uazapi incompletas para este agente. Configure baseUrl e instanceToken."
    );
    error.statusCode = 400;
    throw error;
  }

  try {
    new URL(baseUrl);
  } catch (_error) {
    const error = new Error("Base URL da Uazapi invalida para este agente.");
    error.statusCode = 400;
    throw error;
  }

  return {
    baseUrl,
    instanceToken,
    sendMessagePath: sendMessagePath.startsWith("/") ? sendMessagePath : `/${sendMessagePath}`,
    sendMediaPath: sendMediaPath.startsWith("/") ? sendMediaPath : `/${sendMediaPath}`,
    webhookSecret: textOrEmpty(providerConfig.webhookSecret),
  };
}

function buildPayloadVariants(to, text) {
  const destination = normalizePhone(to);
  return [
    {
      variant: "official",
      payload: {
        number: destination,
        text,
      },
    },
    {
      variant: "legacy",
      payload: {
        number: destination,
        phone: destination,
        chatId: `${destination}@s.whatsapp.net`,
        text,
        message: text,
        type: "text",
      },
    },
  ];
}

async function sendUazapiTextMessage(providerConfig, { to, text }) {
  const config = assertUazapiProviderConfig(providerConfig);
  const destination = normalizePhone(to);
  const messageText = textOrEmpty(text);

  if (!destination || !messageText) {
    const error = new Error("Campos obrigatorios: to e text.");
    error.statusCode = 400;
    throw error;
  }

  const url = `${config.baseUrl}${config.sendMessagePath}`;
  const variants = buildPayloadVariants(destination, messageText);
  const attempts = [];

  logUazapi("send_text.request", {
    explanation: "Requisicao de envio de texto para Uazapi (serao tentadas variacoes de payload).",
    to: destination,
    url,
    variants: variants.map((item) => ({
      variant: item.variant,
      payload: safeJson(item.payload),
    })),
  });

  for (const variant of variants) {
    const response = await axios.post(url, variant.payload, {
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        token: config.instanceToken,
      },
      validateStatus: () => true,
    });

    attempts.push({
      variant: variant.variant,
      status: response.status,
      message: response?.data?.error || response?.data?.message || null,
    });

    logUazapi("send_text.attempt_response", {
      explanation: "Resposta de uma tentativa de envio via Uazapi.",
      to: destination,
      variant: variant.variant,
      status: response.status,
      data: safeJson(response.data),
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        provider: "uazapi",
        status: "sent",
        to: destination,
        text: messageText,
        data: response.data,
        attempts,
      };
    }
  }

  const error = new Error(
    `Falha ao enviar mensagem via Uazapi. Ultimo status: ${attempts[attempts.length - 1]?.status || "n/a"}`
  );
  error.statusCode = attempts[attempts.length - 1]?.status || 502;
  error.details = { attempts };
  throw error;
}

function buildMediaPayloadVariants(to, mediaUrl, caption, filename) {
  const destination = normalizePhone(to);
  return [
    {
      variant: "official",
      payload: {
        number: destination,
        type: "document",
        file: mediaUrl,
        media: mediaUrl,
        filename,
        caption,
      },
    },
    {
      variant: "legacy",
      payload: {
        number: destination,
        phone: destination,
        chatId: `${destination}@s.whatsapp.net`,
        type: "document",
        file: mediaUrl,
        media: mediaUrl,
        filename,
        caption,
      },
    },
  ];
}

async function sendUazapiDocumentMessage(
  providerConfig,
  { to, documentUrl, caption = "", filename = "Analise_SMG.pdf" }
) {
  const config = assertUazapiProviderConfig(providerConfig);
  const destination = normalizePhone(to);
  const fileUrl = textOrEmpty(documentUrl);
  const fileName = textOrEmpty(filename) || "Analise_SMG.pdf";
  const safeCaption = textOrEmpty(caption);

  if (!destination || !fileUrl) {
    const error = new Error("Campos obrigatorios: to e documentUrl.");
    error.statusCode = 400;
    throw error;
  }

  const url = `${config.baseUrl}${config.sendMediaPath}`;
  const variants = buildMediaPayloadVariants(destination, fileUrl, safeCaption, fileName);
  const attempts = [];

  logUazapi("send_document.request", {
    explanation: "Requisicao de envio de documento para Uazapi (com fallback de variacoes).",
    to: destination,
    url,
    variants: variants.map((item) => ({
      variant: item.variant,
      payload: safeJson(item.payload),
    })),
  });

  for (const variant of variants) {
    const response = await axios.post(url, variant.payload, {
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        token: config.instanceToken,
      },
      validateStatus: () => true,
    });

    attempts.push({
      variant: variant.variant,
      status: response.status,
      message: response?.data?.error || response?.data?.message || null,
    });

    logUazapi("send_document.attempt_response", {
      explanation: "Resposta de uma tentativa de envio de documento via Uazapi.",
      to: destination,
      variant: variant.variant,
      status: response.status,
      data: safeJson(response.data),
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        provider: "uazapi",
        status: "sent_document",
        to: destination,
        documentUrl: fileUrl,
        data: response.data,
        attempts,
      };
    }
  }

  const error = new Error(
    `Falha ao enviar documento via Uazapi. Ultimo status: ${attempts[attempts.length - 1]?.status || "n/a"}`
  );
  error.statusCode = attempts[attempts.length - 1]?.status || 502;
  error.details = { attempts };
  throw error;
}

module.exports = {
  assertUazapiProviderConfig,
  sendUazapiTextMessage,
  sendUazapiDocumentMessage,
};
