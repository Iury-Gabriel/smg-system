const fs = require("fs");
const path = require("path");
const env = require("../../config/env");
const { getAgentOrThrow, invalidateAgentsCache } = require("./registry.service");

const ENV_FILE_PATH = path.join(process.cwd(), ".env");

function toEnvSafeSlug(slug) {
  return String(slug || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

function fieldCatalogForAgent(agentSlug) {
  const normalized = toEnvSafeSlug(agentSlug);
  const prefix = `AGENT_${normalized}_`;

  return [
    {
      id: "allowOutboundMessages",
      section: "runtime",
      label: "Permitir envio de mensagens",
      envKey: "ALLOW_OUTBOUND_MESSAGES",
      type: "boolean",
      secret: false,
      required: true,
    },
    {
      id: "wf2EnableOutboundStart",
      section: "runtime",
      label: "Ativar outbound.start do WF2",
      envKey: "WF2_ENABLE_OUTBOUND_START",
      type: "boolean",
      secret: false,
      required: true,
    },
    {
      id: "aiEnabled",
      section: "ai",
      label: "IA habilitada",
      envKey: `${prefix}AI_ENABLED`,
      type: "boolean",
      secret: false,
      required: true,
    },
    {
      id: "openaiApiKey",
      section: "ai",
      label: "OpenAI API key",
      envKey: `${prefix}OPENAI_API_KEY`,
      fallbackEnvKey: "OPENAI_API_KEY",
      type: "password",
      secret: true,
      required: true,
    },
    {
      id: "formLink",
      section: "wf2",
      label: "Link do formulario WF2",
      envKey: `${prefix}FORM_LINK`,
      type: "url",
      secret: false,
      required: false,
    },
    {
      id: "metaVerifyToken",
      section: "meta",
      label: "Meta verify token",
      envKey: `${prefix}META_VERIFY_TOKEN`,
      fallbackEnvKey: "META_WEBHOOK_VERIFY_TOKEN",
      type: "text",
      secret: false,
      required: false,
    },
    {
      id: "metaAccessToken",
      section: "meta",
      label: "Meta access token",
      envKey: `${prefix}META_ACCESS_TOKEN`,
      type: "password",
      secret: true,
      required: true,
    },
    {
      id: "metaPhoneNumberId",
      section: "meta",
      label: "Meta phone number ID",
      envKey: `${prefix}META_PHONE_NUMBER_ID`,
      type: "text",
      secret: false,
      required: true,
    },
    {
      id: "metaWabaId",
      section: "meta",
      label: "Meta WABA ID",
      envKey: `${prefix}META_WABA_ID`,
      type: "text",
      secret: false,
      required: false,
    },
    {
      id: "uazapiBaseUrl",
      section: "uazapi",
      label: "Uazapi base URL",
      envKey: `${prefix}UAZAPI_BASE_URL`,
      fallbackEnvKey: "UAZAPI_BASE_URL",
      type: "url",
      secret: false,
      required: false,
    },
    {
      id: "uazapiInstanceToken",
      section: "uazapi",
      label: "Uazapi instance token",
      envKey: `${prefix}UAZAPI_INSTANCE_TOKEN`,
      type: "password",
      secret: true,
      required: false,
    },
    {
      id: "uazapiWebhookSecret",
      section: "uazapi",
      label: "Uazapi webhook secret",
      envKey: `${prefix}UAZAPI_WEBHOOK_SECRET`,
      type: "password",
      secret: true,
      required: false,
    },
  ];
}

function normalizeBoolean(value, fallback = false) {
  const raw = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "sim") return true;
  if (raw === "false" || raw === "0" || raw === "no" || raw === "nao") return false;
  return fallback;
}

function isConfiguredValue(value) {
  return String(value === undefined || value === null ? "" : value).trim().length > 0;
}

function resolveFieldValue(field) {
  const primary = process.env[field.envKey];
  if (isConfiguredValue(primary)) {
    return {
      value: String(primary),
      source: "agent",
    };
  }

  if (field.fallbackEnvKey && isConfiguredValue(process.env[field.fallbackEnvKey])) {
    return {
      value: String(process.env[field.fallbackEnvKey]),
      source: "global",
    };
  }

  return {
    value: "",
    source: "none",
  };
}

function getAgentSetup(agentSlug) {
  const agent = getAgentOrThrow(agentSlug);
  const catalog = fieldCatalogForAgent(agent.slug);

  const fields = catalog.map((field) => {
    const resolved = resolveFieldValue(field);
    const configured =
      field.type === "boolean"
        ? true
        : field.required
        ? isConfiguredValue(resolved.value)
        : isConfiguredValue(resolved.value) || !field.required;

    const effectiveValue =
      field.type === "boolean"
        ? String(
            normalizeBoolean(
              resolved.value || (field.envKey === "ALLOW_OUTBOUND_MESSAGES"
                ? String(env.allowOutboundMessages)
                : field.envKey === "WF2_ENABLE_OUTBOUND_START"
                ? String(env.wf2EnableOutboundStart)
                : "false"),
              false
            )
          )
        : resolved.value;

    return {
      id: field.id,
      section: field.section,
      label: field.label,
      type: field.type,
      required: field.required,
      configured,
      source: resolved.source,
      value: field.secret ? "" : effectiveValue,
      hasSecretValue: field.secret ? isConfiguredValue(resolved.value) : false,
      envKey: field.envKey,
    };
  });

  const missing = fields.filter((field) => field.required && !field.configured);

  return {
    agentSlug: agent.slug,
    mode: {
      outboundMessagesEnabled: env.allowOutboundMessages,
      wf2OutboundStartEnabled: env.wf2EnableOutboundStart,
    },
    summary: {
      total: fields.length,
      required: fields.filter((field) => field.required).length,
      missingRequired: missing.length,
    },
    fields,
    missing,
  };
}

function formatEnvValue(rawValue) {
  const value = String(rawValue === undefined || rawValue === null ? "" : rawValue);
  if (!value) return "";

  if (/^(true|false)$/i.test(value)) {
    return value.toLowerCase();
  }

  if (/^[a-zA-Z0-9._:/-]+$/.test(value)) {
    return value;
  }

  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function upsertEnvVars(updatesByEnvKey) {
  const fileExists = fs.existsSync(ENV_FILE_PATH);
  let content = fileExists ? fs.readFileSync(ENV_FILE_PATH, "utf8") : "";
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content ? content.split(/\r?\n/) : [];

  const entries = Object.entries(updatesByEnvKey);

  for (const [envKey, envValue] of entries) {
    const formatted = formatEnvValue(envValue);
    const nextLine = `${envKey}=${formatted}`;
    const pattern = new RegExp(`^${envKey}=`);
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) {
      lines[index] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }

  const nextContent = lines.join("\n");
  fs.writeFileSync(
    ENV_FILE_PATH,
    hasTrailingNewline || !nextContent ? `${nextContent}\n` : nextContent,
    "utf8"
  );
}

function updateAgentSetup(agentSlug, values = {}) {
  const agent = getAgentOrThrow(agentSlug);
  const catalog = fieldCatalogForAgent(agent.slug);
  const byId = new Map(catalog.map((field) => [field.id, field]));
  const updatesByEnvKey = {};

  for (const [fieldId, incomingValue] of Object.entries(values || {})) {
    const field = byId.get(fieldId);
    if (!field) continue;

    if (field.type === "boolean") {
      const normalized = normalizeBoolean(incomingValue, false);
      updatesByEnvKey[field.envKey] = normalized ? "true" : "false";
      process.env[field.envKey] = normalized ? "true" : "false";
      continue;
    }

    const value = String(incomingValue === undefined || incomingValue === null ? "" : incomingValue).trim();
    updatesByEnvKey[field.envKey] = value;
    process.env[field.envKey] = value;
  }

  if (Object.keys(updatesByEnvKey).length > 0) {
    upsertEnvVars(updatesByEnvKey);
    invalidateAgentsCache();
  }

  return getAgentSetup(agent.slug);
}

module.exports = {
  getAgentSetup,
  updateAgentSetup,
};
