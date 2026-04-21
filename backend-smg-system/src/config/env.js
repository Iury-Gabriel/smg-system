const dotenv = require("dotenv");

dotenv.config();
const OPENAI_FIXED_MODEL = "gpt-4o-mini";

const env = {
  port: Number(process.env.PORT || 3344),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl:
    process.env.DATABASE_URL ||
    process.env.DATABASE_URL_SMG ||
    "postgresql://smg:smg123@localhost:5432/smg?schema=public",
  defaultWorkflow: String(process.env.DEFAULT_WORKFLOW || "smg")
    .trim()
    .toLowerCase(),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  redisPrefix: String(process.env.REDIS_PREFIX || "smg").trim(),
  bullQueueName: process.env.BULLMQ_QUEUE_NAME || "smg-scrap-queue",
  workerConcurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 10)),
  serpApiKey: String(process.env.SERPAPI_API_KEY || "").trim(),
  serpApiBaseUrl: process.env.SERPAPI_BASE_URL || "https://serpapi.com/search",
  serpApiTimeoutMs: Math.max(5000, Number(process.env.SERPAPI_TIMEOUT_MS || 30000)),
  serpApiMaxStart: Math.max(10, Number(process.env.SERPAPI_MAX_START || 200)),
  scraperCron: process.env.SCRAPER_CRON || "0 9 * * *",
  scraperCronSmg: process.env.SCRAPER_CRON_SMG || process.env.SCRAPER_CRON || "0 9 * * *",
  scraperCronBsb: process.env.SCRAPER_CRON_BSB || "0 10 * * *",
  workflowDefaultAgentSmg: String(process.env.WORKFLOW_DEFAULT_AGENT_SMG || "default-sdr").trim(),
  workflowDefaultAgentBsb: String(process.env.WORKFLOW_DEFAULT_AGENT_BSB || "default-sdr").trim(),
  scraperTimezone: process.env.SCRAPER_TIMEZONE || "America/Sao_Paulo",
  publicWebhookBaseUrl: String(process.env.PUBLIC_WEBHOOK_BASE_URL || "").trim(),
  metaGraphBaseUrl:
    String(process.env.META_GRAPH_BASE_URL || "").trim() ||
    "https://graph.facebook.com/v23.0",
  metaWebhookVerifyToken: String(process.env.META_WEBHOOK_VERIFY_TOKEN || "").trim(),
  uazapiBaseUrl: String(process.env.UAZAPI_BASE_URL || "").trim(),
  uazapiSendMessagePath:
    String(process.env.UAZAPI_SEND_MESSAGE_PATH || "").trim() || "/send/text",
  uazapiSendMediaPath:
    String(process.env.UAZAPI_SEND_MEDIA_PATH || "").trim() || "/send/media",
  openaiApiKey: String(process.env.OPENAI_API_KEY || "").trim(),
  openaiModel: OPENAI_FIXED_MODEL,
  openaiBaseUrl:
    String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim() ||
    "https://api.openai.com/v1",
  agentDefaultBufferSeconds: Math.max(
    5,
    Number(process.env.AGENT_DEFAULT_BUFFER_SECONDS || 15)
  ),
  agentConversationHistoryLimit: Math.max(
    1,
    Math.min(Number(process.env.AGENT_CONVERSATION_HISTORY_LIMIT || 20), 80)
  ),
  agentReplyChunkMaxLength: Math.max(
    120,
    Math.min(Number(process.env.AGENT_REPLY_CHUNK_MAX_LENGTH || 420), 1000)
  ),
  wf2PollIntervalSeconds: Math.max(
    10,
    Number(process.env.WF2_POLL_INTERVAL_SECONDS || 30)
  ),
  // Hard block: outbound desativado no projeto por seguranca operacional.
  wf2EnableOutboundStart: false,
  allowOutboundMessages: false,
  agentRegistryHotReload:
    String(process.env.AGENT_REGISTRY_HOT_RELOAD || "false").toLowerCase() === "true",
  enableWebsiteEnrichment:
    String(process.env.ENABLE_WEBSITE_ENRICHMENT || "true").toLowerCase() === "true",
  workerVerboseLogs:
    String(process.env.WORKER_VERBOSE_LOGS || "true").toLowerCase() === "true",
  workerLeadLogLimit: Math.max(0, Number(process.env.WORKER_LEAD_LOG_LIMIT || 0)),
};

module.exports = env;
