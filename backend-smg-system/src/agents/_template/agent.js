const path = require("path");

module.exports = {
  slug: "trocar-por-slug-cliente",
  name: "Trocar Nome do Agente",
  description: "Template de agente por pasta com orchestrator IA + buffer + historico.",
  workflow: process.env.AGENT_CLIENTE_WORKFLOW || "smg",
  wf2: {
    enabled: false,
  },
  formLink: process.env.AGENT_CLIENTE_FORM_LINK || "https://smg.com.br/diagnostico",
  defaultProvider: "meta",
  promptFile: path.join(__dirname, "prompt.md"),
  ai: {
    enabled:
      String(process.env.AGENT_CLIENTE_AI_ENABLED || "true").toLowerCase() !== "false",
    apiKey: process.env.AGENT_CLIENTE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
    model: process.env.AGENT_CLIENTE_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    bufferSeconds:
      Number(process.env.AGENT_CLIENTE_BUFFER_SECONDS || process.env.AGENT_DEFAULT_BUFFER_SECONDS || 15) ||
      15,
    historyLimit:
      Number(process.env.AGENT_CLIENTE_HISTORY_LIMIT || process.env.AGENT_CONVERSATION_HISTORY_LIMIT || 20) ||
      20,
    humanHandoffEnabled:
      String(process.env.AGENT_CLIENTE_HUMAN_HANDOFF || "true").toLowerCase() !== "false",
    clearMemoryCommandEnabled:
      String(process.env.AGENT_CLIENTE_CLEAR_MEMORY_COMMAND || "true").toLowerCase() !==
      "false",
  },
  providers: {
    meta: {
      verifyToken: process.env.AGENT_CLIENTE_META_VERIFY_TOKEN || "",
      accessToken: process.env.AGENT_CLIENTE_META_ACCESS_TOKEN || "",
      phoneNumberId: process.env.AGENT_CLIENTE_META_PHONE_NUMBER_ID || "",
      wabaId: process.env.AGENT_CLIENTE_META_WABA_ID || "",
      graphBaseUrl:
        process.env.AGENT_CLIENTE_META_GRAPH_BASE_URL ||
        process.env.META_GRAPH_BASE_URL ||
        "https://graph.facebook.com/v23.0",
      templates: {
        initialOutbound: process.env.AGENT_CLIENTE_META_TEMPLATE_INITIAL_OUTBOUND || "",
        followup1: process.env.AGENT_CLIENTE_META_TEMPLATE_FUP1 || "",
        followup2: process.env.AGENT_CLIENTE_META_TEMPLATE_FUP2 || "",
        followup3: process.env.AGENT_CLIENTE_META_TEMPLATE_FUP3 || "",
        followupRecurring: process.env.AGENT_CLIENTE_META_TEMPLATE_FUP_RECORRENTE || "",
        analiseFollowup: process.env.AGENT_CLIENTE_META_TEMPLATE_ANALISE || "",
      },
    },
    uazapi: {
      baseUrl: process.env.AGENT_CLIENTE_UAZAPI_BASE_URL || process.env.UAZAPI_BASE_URL || "",
      instanceToken: process.env.AGENT_CLIENTE_UAZAPI_INSTANCE_TOKEN || "",
      webhookSecret: process.env.AGENT_CLIENTE_UAZAPI_WEBHOOK_SECRET || "",
      sendMessagePath:
        process.env.AGENT_CLIENTE_UAZAPI_SEND_PATH ||
        process.env.UAZAPI_SEND_MESSAGE_PATH ||
        "/send/text",
    },
  },
  async buildTools() {
    return [
      // Exemplo:
      // {
      //   name: "buscar_preco",
      //   description: "Consulta preco de um produto no ERP",
      //   schema: {
      //     sku: { type: "string", description: "SKU do produto" },
      //   },
      //   handler: async ({ sku }) => {
      //     return { sku, preco: 0 };
      //   },
      // },
    ];
  },
};
