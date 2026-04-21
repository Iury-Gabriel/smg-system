const fs = require("fs");
const path = require("path");
const env = require("../../config/env");
const { resolveWorkflow } = require("../../config/workflows");
const {
  normalizeProvider,
  isNonEmptyString,
  maskCredential,
} = require("./helpers");

const AGENTS_DIR = path.join(__dirname, "..", "..", "agents");
let agentsCache = null;

function ensureAgentsDirectory() {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

function normalizeSlug(value, fallback = "agent") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function loadAgentFromDirectory(directoryName) {
  const agentFilePath = path.join(AGENTS_DIR, directoryName, "agent.js");
  if (!fs.existsSync(agentFilePath)) {
    return null;
  }

  delete require.cache[require.resolve(agentFilePath)];
  const loaded = require(agentFilePath);
  const rawAgent = loaded && typeof loaded === "object" && loaded.default ? loaded.default : loaded;
  if (!rawAgent || typeof rawAgent !== "object") {
    return null;
  }

  const slug = normalizeSlug(rawAgent.slug || directoryName, directoryName);
  const name = String(rawAgent.name || directoryName).trim();
  const description = String(rawAgent.description || "").trim();
  const providers = rawAgent.providers && typeof rawAgent.providers === "object" ? rawAgent.providers : {};
  const defaultProvider = normalizeProvider(rawAgent.defaultProvider || "meta") || "meta";
  const workflow = resolveWorkflow(rawAgent.workflow || env.defaultWorkflow || "smg");
  const ai = rawAgent.ai && typeof rawAgent.ai === "object" ? rawAgent.ai : {};

  return {
    ...rawAgent,
    slug,
    name,
    description,
    defaultProvider,
    workflow,
    ai,
    providers,
    directoryName,
    directoryPath: path.join(AGENTS_DIR, directoryName),
  };
}

function loadAgentsFromDisk() {
  ensureAgentsDirectory();
  const directoryEntries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agents = [];

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const agent = loadAgentFromDirectory(entry.name);
    if (agent) {
      agents.push(agent);
    }
  }

  agents.sort((a, b) => a.slug.localeCompare(b.slug));
  return agents;
}

function getAgents() {
  if (!agentsCache || env.agentRegistryHotReload) {
    agentsCache = loadAgentsFromDisk();
  }
  return agentsCache;
}

function listAgents() {
  return getAgents();
}

function invalidateAgentsCache() {
  agentsCache = null;
}

function getAgentOrThrow(agentSlug) {
  const normalized = normalizeSlug(agentSlug);
  const agent = getAgents().find((item) => item.slug === normalized);
  if (!agent) {
    const error = new Error(`Agente "${normalized}" nao encontrado.`);
    error.statusCode = 404;
    throw error;
  }
  return agent;
}

function getAgentProviderConfig(agent, providerInput) {
  const provider = normalizeProvider(providerInput || agent.defaultProvider);
  if (!provider) {
    const error = new Error("Provider invalido. Use meta ou uazapi.");
    error.statusCode = 400;
    throw error;
  }

  const providerConfig = agent.providers?.[provider];
  if (!providerConfig || typeof providerConfig !== "object") {
    const error = new Error(
      `Provider "${provider}" nao configurado para o agente "${agent.slug}".`
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    provider,
    config: providerConfig,
  };
}

function buildWebhookUrls(origin, agentSlug) {
  const base = String(origin || "").trim().replace(/\/+$/, "");
  if (!base) return {};
  return {
    meta: `${base}/api/webhooks/${encodeURIComponent(agentSlug)}/meta`,
    uazapi: `${base}/api/webhooks/${encodeURIComponent(agentSlug)}/uazapi`,
  };
}

function buildProviderStatus(agent, providerInput) {
  const provider = normalizeProvider(providerInput);
  if (!provider) return null;
  const config = agent.providers?.[provider] || {};

  if (provider === "meta") {
    return {
      provider,
      configured: isNonEmptyString(config.accessToken) && isNonEmptyString(config.phoneNumberId),
      credentials: {
        verifyTokenConfigured: isNonEmptyString(config.verifyToken),
        accessToken: maskCredential(config.accessToken),
        phoneNumberId: String(config.phoneNumberId || "").trim(),
        wabaId: String(config.wabaId || "").trim(),
      },
    };
  }

  return {
    provider,
    configured: isNonEmptyString(config.baseUrl) && isNonEmptyString(config.instanceToken),
    credentials: {
      baseUrl: String(config.baseUrl || "").trim(),
      instanceToken: maskCredential(config.instanceToken),
      sendMessagePath: String(config.sendMessagePath || "").trim() || "/send/text",
      webhookSecretConfigured: isNonEmptyString(config.webhookSecret),
    },
  };
}

function serializeAgent(agent, origin = "") {
  const providerNames = ["meta", "uazapi"];
  const aiConfig = agent.ai && typeof agent.ai === "object" ? agent.ai : {};
  const wf2Config = agent.wf2 && typeof agent.wf2 === "object" ? agent.wf2 : {};
  const aiEnabled = aiConfig.enabled !== false;
  const hasOwnApiKey = isNonEmptyString(aiConfig.apiKey);
  const hasEnvApiKey = isNonEmptyString(env.openaiApiKey);

  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    defaultProvider: agent.defaultProvider,
    workflow: agent.workflow,
    directory: agent.directoryName,
    webhooks: buildWebhookUrls(origin, agent.slug),
    ai: {
      enabled: aiEnabled,
      useLangChain: aiConfig.useLangChain !== false,
      model: String(env.openaiModel || "gpt-4o-mini").trim(),
      bufferSeconds: Math.max(
        5,
        Number(
          aiConfig.bufferSeconds !== undefined
            ? aiConfig.bufferSeconds
            : env.agentDefaultBufferSeconds
        ) || 15
      ),
      historyLimit: Math.max(
        1,
        Math.min(
          Number(
            aiConfig.historyLimit !== undefined
              ? aiConfig.historyLimit
              : env.agentConversationHistoryLimit
          ) || 20,
          80
        )
      ),
      humanHandoffEnabled: aiConfig.humanHandoffEnabled !== false,
      clearMemoryCommandEnabled: aiConfig.clearMemoryCommandEnabled !== false,
      apiKeyConfigured: hasOwnApiKey || hasEnvApiKey,
      apiKeySource: hasOwnApiKey ? "agent" : hasEnvApiKey ? "env" : "none",
      toolsCount: Array.isArray(agent.tools) ? agent.tools.length : null,
    },
    wf2: {
      enabled: wf2Config.enabled === true,
      formLink: String(agent.formLink || "").trim() || null,
    },
    providers: providerNames
      .map((providerName) => buildProviderStatus(agent, providerName))
      .filter(Boolean),
  };
}

module.exports = {
  listAgents,
  invalidateAgentsCache,
  getAgentOrThrow,
  getAgentProviderConfig,
  buildWebhookUrls,
  serializeAgent,
};
