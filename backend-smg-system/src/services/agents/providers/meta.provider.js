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

function logMeta(event, payload = {}) {
  const stamp = new Date().toISOString();
  console.log(`[providers.meta][${stamp}][${event}]`, payload);
}

function buildMetaGraphBaseUrl(providerConfig = {}) {
  const fromAgent = textOrEmpty(providerConfig.graphBaseUrl);
  const fromEnv = textOrEmpty(env.metaGraphBaseUrl);
  const base = fromAgent || fromEnv || "https://graph.facebook.com/v23.0";
  return base.replace(/\/+$/, "");
}

function assertMetaProviderConfig(providerConfig = {}) {
  const accessToken = textOrEmpty(providerConfig.accessToken);
  const phoneNumberId = textOrEmpty(providerConfig.phoneNumberId);

  if (!accessToken || !phoneNumberId) {
    const error = new Error(
      "Credenciais Meta incompletas para este agente. Configure accessToken e phoneNumberId."
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    accessToken,
    phoneNumberId,
    wabaId: textOrEmpty(providerConfig.wabaId),
    verifyToken: textOrEmpty(providerConfig.verifyToken),
    graphBaseUrl: buildMetaGraphBaseUrl(providerConfig),
  };
}

async function sendMetaTextMessage(providerConfig, { to, text }) {
  const config = assertMetaProviderConfig(providerConfig);
  const destination = normalizePhone(to);
  const messageText = textOrEmpty(text);

  if (!destination || !messageText) {
    const error = new Error("Campos obrigatorios: to e text.");
    error.statusCode = 400;
    throw error;
  }

  const url = `${config.graphBaseUrl}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: destination,
    type: "text",
    text: {
      body: messageText,
    },
  };

  logMeta("send_text.request", {
    explanation: "Requisicao de envio de texto para WhatsApp oficial (Meta).",
    to: destination,
    phoneNumberId: config.phoneNumberId,
    url,
    payload: safeJson(payload),
  });

  const response = await axios.post(url, payload, {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });

  logMeta("send_text.response", {
    explanation: "Resposta da Meta para envio de texto.",
    to: destination,
    status: response.status,
    data: safeJson(response.data),
  });

  if (response.status < 200 || response.status >= 300) {
    const message =
      response?.data?.error?.message ||
      response?.data?.message ||
      `Falha ao enviar mensagem via Meta (status ${response.status}).`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.details = response.data;
    throw error;
  }

  return {
    provider: "meta",
    status: "sent",
    to: destination,
    text: messageText,
    phoneNumberId: config.phoneNumberId,
    data: response.data,
  };
}

async function sendMetaTemplateMessage(
  providerConfig,
  { to, templateName, parameters = [], languageCode = "pt_BR" }
) {
  const config = assertMetaProviderConfig(providerConfig);
  const destination = normalizePhone(to);
  const name = textOrEmpty(templateName);
  const safeParams = Array.isArray(parameters) ? parameters : [];

  if (!destination || !name) {
    const error = new Error("Campos obrigatorios: to e templateName.");
    error.statusCode = 400;
    throw error;
  }

  const url = `${config.graphBaseUrl}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: destination,
    type: "template",
    template: {
      name,
      language: {
        code: textOrEmpty(languageCode) || "pt_BR",
      },
      ...(safeParams.length
        ? {
            components: [
              {
                type: "body",
                parameters: safeParams.map((item) => ({
                  type: "text",
                  text: String(item || "").trim(),
                })),
              },
            ],
          }
        : {}),
    },
  };

  logMeta("send_template.request", {
    explanation: "Requisicao de envio de template aprovado pela Meta.",
    to: destination,
    templateName: name,
    phoneNumberId: config.phoneNumberId,
    url,
    payload: safeJson(payload),
  });

  const response = await axios.post(url, payload, {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });

  logMeta("send_template.response", {
    explanation: "Resposta da Meta para envio de template.",
    to: destination,
    templateName: name,
    status: response.status,
    data: safeJson(response.data),
  });

  if (response.status < 200 || response.status >= 300) {
    const message =
      response?.data?.error?.message ||
      response?.data?.message ||
      `Falha ao enviar template via Meta (status ${response.status}).`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.details = response.data;
    throw error;
  }

  return {
    provider: "meta",
    status: "sent_template",
    to: destination,
    templateName: name,
    phoneNumberId: config.phoneNumberId,
    data: response.data,
  };
}

async function sendMetaDocumentMessage(
  providerConfig,
  { to, documentUrl, caption = "", filename = "Analise_SMG.pdf" }
) {
  const config = assertMetaProviderConfig(providerConfig);
  const destination = normalizePhone(to);
  const link = textOrEmpty(documentUrl);

  if (!destination || !link) {
    const error = new Error("Campos obrigatorios: to e documentUrl.");
    error.statusCode = 400;
    throw error;
  }

  const url = `${config.graphBaseUrl}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: destination,
    type: "document",
    document: {
      link,
      caption: textOrEmpty(caption),
      filename: textOrEmpty(filename) || "Analise_SMG.pdf",
    },
  };

  logMeta("send_document.request", {
    explanation: "Requisicao de envio de documento para WhatsApp oficial (Meta).",
    to: destination,
    phoneNumberId: config.phoneNumberId,
    url,
    payload: safeJson(payload),
  });

  const response = await axios.post(url, payload, {
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
  });

  logMeta("send_document.response", {
    explanation: "Resposta da Meta para envio de documento.",
    to: destination,
    status: response.status,
    data: safeJson(response.data),
  });

  if (response.status < 200 || response.status >= 300) {
    const message =
      response?.data?.error?.message ||
      response?.data?.message ||
      `Falha ao enviar documento via Meta (status ${response.status}).`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.details = response.data;
    throw error;
  }

  return {
    provider: "meta",
    status: "sent_document",
    to: destination,
    documentUrl: link,
    phoneNumberId: config.phoneNumberId,
    data: response.data,
  };
}

module.exports = {
  assertMetaProviderConfig,
  sendMetaTextMessage,
  sendMetaTemplateMessage,
  sendMetaDocumentMessage,
};
