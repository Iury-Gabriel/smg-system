const env = require("./env");

const WORKFLOW_SMG = "smg";
const WORKFLOW_BSB = "bsb";
const BSB_SEARCH_LOCATION = "Sao Paulo, State of Sao Paulo, Brazil";
const BSB_SEARCH_LL = "@-23.5505,-46.6333,14z";

const WORKFLOW_CONFIGS = {
  [WORKFLOW_SMG]: {
    id: WORKFLOW_SMG,
    label: "SMG",
    channel: "scrap_smg",
    databaseUrl: env.databaseUrl,
    defaultAgentSlug: env.workflowDefaultAgentSmg || "default-sdr",
    cron: env.scraperCronSmg,
    targetApprovedPerExecution: 34,
  },
  [WORKFLOW_BSB]: {
    id: WORKFLOW_BSB,
    label: "BSB",
    channel: "scrap_bsb",
    databaseUrl: env.databaseUrl,
    defaultAgentSlug: env.workflowDefaultAgentBsb || "default-sdr",
    cron: env.scraperCronBsb,
    targetApprovedPerExecution: 67,
  },
};

function normalizeWorkflow(input) {
  return String(input || "")
    .trim()
    .toLowerCase();
}

function isKnownWorkflow(value) {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_CONFIGS, value);
}

function resolveWorkflow(input, fallback = env.defaultWorkflow || WORKFLOW_SMG) {
  const normalized = normalizeWorkflow(input);
  if (isKnownWorkflow(normalized)) {
    return normalized;
  }

  const normalizedFallback = normalizeWorkflow(fallback);
  if (isKnownWorkflow(normalizedFallback)) {
    return normalizedFallback;
  }

  return WORKFLOW_SMG;
}

function getWorkflowConfig(workflowId) {
  const resolved = resolveWorkflow(workflowId);
  return WORKFLOW_CONFIGS[resolved];
}

function listWorkflowConfigs() {
  return Object.values(WORKFLOW_CONFIGS);
}

function parseWorkflowFromRequest(req, { allowAll = false } = {}) {
  const rawQuery = req.query?.workflow;
  const rawBody = req.body?.workflow;
  const rawParam = req.params?.workflow;
  const input = rawQuery || rawBody || rawParam;

  if (allowAll && String(input || "").trim().toLowerCase() === "all") {
    return "all";
  }

  return resolveWorkflow(input);
}

module.exports = {
  WORKFLOW_SMG,
  WORKFLOW_BSB,
  BSB_SEARCH_LOCATION,
  BSB_SEARCH_LL,
  WORKFLOW_CONFIGS,
  resolveWorkflow,
  getWorkflowConfig,
  listWorkflowConfigs,
  parseWorkflowFromRequest,
};
