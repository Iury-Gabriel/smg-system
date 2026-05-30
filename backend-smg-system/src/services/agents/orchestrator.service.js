const fs = require("fs");
const env = require("../../config/env");
const { resolveWorkflow } = require("../../config/workflows");
const { getPrisma } = require("../../lib/prisma");
const {
  buildRedisKey,
  pushBufferedMessage,
  popAllBufferedMessages,
  acquireLock,
  releaseLock,
} = require("../../lib/buffer-store");
const { generateAiReply } = require("../../lib/ai-client");
const { buildTypingChunks } = require("../../utils/whatsapp-message");
const { normalizePhone, textOrEmpty } = require("./helpers");
const { getWorkflowTables } = require("../workflow-data-access.service");
const { buildPhoneCandidates, normalizeE164, isWithinAutomationSchedule } = require("../wf2/helpers");
const { getAgentOrThrow, getAgentProviderConfig } = require("./registry.service");
const {
  sendMetaTextMessage,
  sendMetaReadTypingIndicator,
} = require("./providers/meta.provider");
const { sendUazapiTextMessage } = require("./providers/uazapi.provider");
const { registerInboundMessageEvent, startOutboundFromCommand } = require("../wf2/wf2.service");
const { retrieveAgentRagContext } = require("./rag.service");
const {
  createExecutionRun,
  appendExecutionEvent,
  finishExecutionRun,
} = require("./execution-tracker.service");

const bufferTimers = new Map();
const promptCache = new Map();
const CLEAR_RESET_TX_OPTIONS = {
  maxWait: 10000,
  timeout: 30000,
};
const CLEAR_RESET_MAX_ATTEMPTS = 2;
const AGENT_INITIAL_REPLY_DELAY_MS = Math.max(0, Number(env.agentInitialReplyDelayMs || 0));
const AGENT_INTER_MESSAGE_DELAY_MS = Math.max(0, Number(env.agentInterMessageDelayMs || 0));

function logOrchestrator(level, event, payload = {}) {
  const stamp = new Date().toISOString();
  const line = `[agents-orchestrator][${stamp}][${event}]`;
  if (level === "error") {
    console.error(line, payload);
    return;
  }
  if (level === "warn") {
    console.warn(line, payload);
    return;
  }
  console.log(line, payload);
}

function safeJson(value, max = 6000) {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > max ? `${raw.slice(0, max)}...<truncated>` : raw;
  } catch (_error) {
    return "<unserializable_payload>";
  }
}

function promptJson(value, max = 5000) {
  try {
    const raw = JSON.stringify(value, null, 2);
    if (!raw) return "{}";
    return raw.length > max ? `${raw.slice(0, max)}...<truncated>` : raw;
  } catch (_error) {
    return "{}";
  }
}

async function waitMs(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (!safeMs) return;
  await new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

function isClearMemoryCommand(value = "") {
  const normalized = textOrEmpty(value).trim().toLowerCase();
  if (!normalized) return false;

  const firstToken = normalized.split(/\s+/)[0]?.replace(/[.,;:!?]+$/g, "") || "";
  return firstToken === "/clear";
}

function isPrismaInteractiveTxExpiredError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("transaction already closed") &&
    message.includes("expired transaction")
  );
}

function parseStartOutboundCommand(value = "") {
  const original = textOrEmpty(value).trim();
  if (!original) return null;

  const normalized = original.toLowerCase();
  const firstToken = normalized.split(/\s+/)[0]?.replace(/[.,;:!?]+$/g, "") || "";
  const isStartToken =
    firstToken === "/start" || firstToken.startsWith("/start=") || firstToken.startsWith("/start:");
  if (!isStartToken) return null;

  let tail = original.slice(6).trim();
  if (tail.startsWith("=") || tail.startsWith(":")) {
    tail = tail.slice(1).trim();
  }
  tail = tail.replace(/^nicho[\s:=_-]*/i, "").trim();
  const segmentHint = tail ? String(tail.split(/\s+/)[0] || "").trim() : "";

  return {
    command: "/start",
    segmentHint,
  };
}

function resolveEtapaAtualFromStatus(statusInput = "") {
  const status = String(statusInput || "").trim().toUpperCase();
  const mapping = {
    NOVO_LEAD: "1",
    INTERMEDIARIO_IDENTIFICADO: "3",
    DECISOR_IDENTIFICADO: "3",
    FORMULARIO_ENVIADO: "5",
    FORMULARIO_RESPONDIDO: "6",
    ANALISE_ENVIADA: "7",
    FUP_SEM_RESPOSTA: "7",
    DIAGNOSTICO_AGENDADO: "8",
    DESQUALIFICADO: "8",
  };
  return mapping[status] || "1";
}

function toConversationPayloadHistory(historyItems = [], limit = 20) {
  const rows = Array.isArray(historyItems) ? historyItems : [];
  const slice = rows.slice(-Math.max(1, Number(limit) || 20));
  return slice.map((item) => ({
    role: item?.role === "ai" ? "assistant" : "user",
    content: String(item?.content || "").trim(),
    timestamp: item?.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
  }));
}

function summarizeHistoryForPayload(history = []) {
  if (!Array.isArray(history) || !history.length) return null;
  const human = history.filter((item) => item.role === "user");
  const assistant = history.filter((item) => item.role === "assistant");
  const lastHuman = human[human.length - 1]?.content || "";
  const lastAssistant = assistant[assistant.length - 1]?.content || "";
  return [
    `Historico truncado para ${history.length} mensagens.`,
    lastAssistant ? `Ultima mensagem da Clara: "${String(lastAssistant).slice(0, 140)}"` : null,
    lastHuman ? `Ultima mensagem do lead: "${String(lastHuman).slice(0, 140)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

async function findLeadForInboundContext({ tables, senderNumber, agentSlug = "" }) {
  const candidates = buildPhoneCandidates(senderNumber);
  if (!candidates.length) return null;

  const normalizedAgentSlug = textOrEmpty(agentSlug);
  const where = {
    telefone: {
      in: candidates,
    },
  };
  if (normalizedAgentSlug) {
    where.agentSlug = normalizedAgentSlug;
  }

  const firstMatch = await tables.lead.findFirst({
    where,
    orderBy: { criadoEm: "desc" },
  });
  if (firstMatch || normalizedAgentSlug) {
    return firstMatch;
  }

  return tables.lead.findFirst({
    where: {
      telefone: {
        in: candidates,
      },
    },
    orderBy: { criadoEm: "desc" },
  });
}

function mapFormularioPayload(form) {
  if (!form) return null;
  return {
    segmento: textOrEmpty(form.segmento),
    faturamento_mensal: textOrEmpty(form.faturamentoMensal),
    num_funcionarios:
      form.numFuncionarios === undefined || form.numFuncionarios === null
        ? ""
        : String(form.numFuncionarios),
    ferramentas_usadas: textOrEmpty(form.ferramentas),
    maior_desafio: textOrEmpty(form.maiorDesafio),
    urgencia: textOrEmpty(form.urgencia),
    motivacao: textOrEmpty(form.motivacao),
    expectativa: textOrEmpty(form.expectativa),
    tentativa_anterior: textOrEmpty(form.tentativaAnterior),
  };
}

function mapWf2OperationalContext(lead = null) {
  const wf2 =
    lead?.dadosBrutos && typeof lead.dadosBrutos === "object" && lead.dadosBrutos.wf2
      ? lead.dadosBrutos.wf2
      : {};
  const status = String(lead?.status || "").trim().toUpperCase();
  const analysis = {
    sent_at: textOrEmpty(wf2.analysisSentAt),
    file_url: textOrEmpty(wf2.analysisFileUrl),
    awaiting_read_confirmation: Boolean(wf2.analysisAwaitingReadConfirmation),
    read_confirmed_at: textOrEmpty(wf2.analysisReadConfirmedAt),
    delivery_step: textOrEmpty(wf2.analysisDeliveryStep),
    post_read_interaction_count: Number(wf2.analysisPostReadInteractionCount || 0),
  };

  let nextAction = "";
  if (status === "FORMULARIO_RESPONDIDO") {
    nextAction = "enviar_analise_pdf";
  } else if (status === "ANALISE_ENVIADA" && analysis.awaiting_read_confirmation) {
    nextAction = "confirmar_leitura_da_analise_sem_reapresentacao";
  } else if (status === "ANALISE_ENVIADA") {
    const hasMinimumDepth =
      analysis.post_read_interaction_count >= 3 ||
      analysis.delivery_step === "micro_approfundamento_ready_for_scheduling";
    nextAction = hasMinimumDepth
      ? "converter_para_diagnostico_com_2_horarios"
      : "aprofundar_antes_de_agendar_sem_horarios";
  } else if (status === "DIAGNOSTICO_AGENDADO") {
    nextAction = "confirmar_proximos_passos_pos_agendamento";
  }

  return {
    analysis,
    next_action: nextAction,
  };
}

async function resolveHorarioValido({ prisma, workflow }) {
  try {
    if (!prisma?.configAutomacao?.findUnique) return true;
    const config = await prisma.configAutomacao.findUnique({
      where: {
        workflow,
      },
    });
    if (!config) return true;
    return Boolean(isWithinAutomationSchedule(config, new Date()));
  } catch (_error) {
    return true;
  }
}

async function buildInboundPayloadContext({
  agent,
  workflow,
  prisma,
  senderNumber,
  historyItems,
  messages,
}) {
  const tables = getWorkflowTables(prisma, workflow);
  const lead = await findLeadForInboundContext({
    tables,
    senderNumber: normalizeE164(senderNumber) || senderNumber,
    agentSlug: agent.slug,
  });

  const historyPayload = toConversationPayloadHistory(historyItems, 20);
  const historyTruncated = Array.isArray(historyItems) && historyItems.length > historyPayload.length;
  const historySummary = historyTruncated ? summarizeHistoryForPayload(historyPayload) : null;

  let formulario = null;
  if (lead?.diagnosticoFormularioId && prisma?.leadDiagnostico?.findUnique) {
    formulario = await prisma.leadDiagnostico
      .findUnique({
        where: {
          id: String(lead.diagnosticoFormularioId),
        },
      })
      .catch(() => null);
  }

  const status = textOrEmpty(lead?.status || "NOVO_LEAD");
  const wf2Context = mapWf2OperationalContext(lead);
  const payload = {
    lead: {
      status: status || "NOVO_LEAD",
      pipeline_origin: textOrEmpty(lead?.pipelineOrigin || "automacao"),
      segmento: textOrEmpty(lead?.segmento || "outro"),
      nome: textOrEmpty(lead?.nome || "Lead"),
      empresa: textOrEmpty(lead?.empresa || "Empresa"),
    },
    wf2_context: wf2Context,
    conversation: {
      history: historyPayload,
      history_truncated: historyTruncated,
      history_summary: historySummary,
    },
    formulario: mapFormularioPayload(formulario),
    aprendizados_contextuais: [],
    config: {
      etapa_atual: resolveEtapaAtualFromStatus(status),
      pipeline_origin: textOrEmpty(lead?.pipelineOrigin || "automacao"),
      horario_valido: await resolveHorarioValido({ prisma, workflow }),
    },
  };

  const ragResult = retrieveAgentRagContext({
    agent,
    payload,
    messages,
    maxItems: 5,
    maxContextChars: 4200,
  });
  payload.aprendizados_contextuais = ragResult.contextualLearnings.map((item) => ({
    segmento: item.segmento,
    etapa: item.etapa,
    padrao: item.padrao,
    origem: item.origem,
  }));

  return {
    payload,
    lead,
    ragContextText: ragResult.contextText,
    ragChunks: ragResult.chunks,
    contextualLearnings: ragResult.contextualLearnings,
  };
}

async function logExecutionEvent(workflow, runId, payload) {
  if (!runId) return;
  await appendExecutionEvent({
    workflow,
    runId,
    ...payload,
  }).catch(() => null);
}

function getAgentWorkflow(agent) {
  return resolveWorkflow(agent?.workflow || env.defaultWorkflow || "smg");
}

function getPrismaForAgent(agent) {
  return getPrisma(getAgentWorkflow(agent));
}

function hasConversationModels(prisma) {
  return Boolean(prisma?.agentConversationMessage && prisma?.agentConversationSession);
}

function toConversationKey({ provider, from, to }) {
  const normalizedProvider = textOrEmpty(provider || "meta");
  const sender = normalizePhone(from);
  const receiver = normalizePhone(to);
  return `${normalizedProvider}:${receiver || "default"}:${sender}`;
}

function getAiConfig(agent) {
  const raw = agent?.ai && typeof agent.ai === "object" ? agent.ai : {};
  const bufferSecondsRaw =
    raw.bufferSeconds !== undefined
      ? raw.bufferSeconds
      : env.agentDefaultBufferSeconds;
  const historyLimitRaw =
    raw.historyLimit !== undefined
      ? raw.historyLimit
      : env.agentConversationHistoryLimit;

  return {
    enabled: raw.enabled !== false,
    model: textOrEmpty(env.openaiModel || "gpt-4o-mini"),
    apiKey: textOrEmpty(raw.apiKey || env.openaiApiKey),
    useLangChain: raw.useLangChain !== false,
    humanHandoffEnabled: raw.humanHandoffEnabled !== false,
    clearMemoryCommandEnabled: raw.clearMemoryCommandEnabled !== false,
    fallbackReply:
      textOrEmpty(raw.fallbackReply) ||
      "Recebi suas mensagens. Obrigado pelo contato, ja vou te ajudar com isso.",
    bufferSeconds: Math.max(5, Number(bufferSecondsRaw) || 15),
    historyLimit: Math.max(1, Math.min(Number(historyLimitRaw) || 20, 80)),
  };
}

function isAiOrchestratorEnabled(agent) {
  return getAiConfig(agent).enabled;
}

function formatConversationHistory(historyItems) {
  if (!Array.isArray(historyItems) || historyItems.length === 0) {
    return "Sem historico anterior.";
  }

  return historyItems
    .map((item, index) => {
      const type = item?.role === "ai" ? "ia" : "human";
      const content = String(item?.content || "").trim();
      return `${index + 1}. [${type}] ${content}`;
    })
    .join("\n");
}

function buildSystemPrompt({ agent, promptText, tools, ragContextText = "" }) {
  const toolLines = Array.isArray(tools)
    ? tools
        .map((tool) => {
          const name = textOrEmpty(tool?.name);
          if (!name) return null;
          const description = textOrEmpty(tool?.description);
          return description ? `- ${name}: ${description}` : `- ${name}`;
        })
        .filter(Boolean)
    : [];

  return [
    "Voce e um assistente de atendimento via WhatsApp.",
    "Responda de forma clara, curta, util e sem inventar dados.",
    "Se nao souber algo, seja transparente e peça dados adicionais.",
    toolLines.length
      ? `Tools disponiveis:\n${toolLines.join("\n")}\nUse as tools quando necessario.`
      : "Nenhuma tool externa configurada no momento.",
    `Agente: ${textOrEmpty(agent?.name || agent?.slug || "agente")}.`,
    textOrEmpty(agent?.description)
      ? `Descricao do agente: ${textOrEmpty(agent.description)}.`
      : null,
    promptText ? `Prompt base do agente:\n${promptText}` : null,
    textOrEmpty(ragContextText)
      ? `Contexto RAG recuperado para esta interacao:\n${ragContextText}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserPrompt({
  senderName,
  senderNumber,
  historyItems,
  messages,
  payloadContext = null,
}) {
  const mergedMessages = messages
    .map((item, index) => `Mensagem ${index + 1}: ${String(item?.text || "").trim()}`)
    .filter(Boolean)
    .join("\n");

  return [
    `Contato: ${senderName || "Cliente"} (${senderNumber}).`,
    "Historico recente da conversa:",
    formatConversationHistory(historyItems),
    "Mensagens recebidas em buffer:",
    mergedMessages,
    payloadContext
      ? `Payload operacional atual:\n${promptJson(payloadContext, 5500)}`
      : null,
    "Responda como atendente comercial e continue a conversa de forma natural.",
  ].join("\n\n");
}

function sanitizeTool(toolConfig) {
  if (!toolConfig || typeof toolConfig !== "object") return null;
  if (toolConfig.enabled === false) return null;
  if (typeof toolConfig.handler !== "function") return null;

  const name = textOrEmpty(toolConfig.name);
  if (!name) return null;

  const description = textOrEmpty(toolConfig.description || "Tool externa");
  const schema = toolConfig.schema && typeof toolConfig.schema === "object" ? toolConfig.schema : {};

  return {
    name,
    description,
    schema,
    handler: toolConfig.handler,
  };
}

async function resolveAgentTools({ agent, context }) {
  let tools = [];
  if (typeof agent.buildTools === "function") {
    const loaded = await agent.buildTools(context);
    tools = Array.isArray(loaded) ? loaded : [];
  } else if (Array.isArray(agent.tools)) {
    tools = agent.tools;
  }

  return tools.map((tool) => sanitizeTool(tool)).filter(Boolean);
}

function loadAgentPromptText(agent) {
  const promptFile = textOrEmpty(agent?.promptFile);
  if (!promptFile) return "";

  if (promptCache.has(promptFile)) {
    return promptCache.get(promptFile);
  }

  try {
    const content = fs.readFileSync(promptFile, "utf8");
    const normalized = String(content || "").trim();
    promptCache.set(promptFile, normalized);
    return normalized;
  } catch (error) {
    logOrchestrator("warn", "agent.prompt.read_failed", {
      agentSlug: agent?.slug,
      promptFile,
      message: error?.message || "unknown",
    });
    promptCache.set(promptFile, "");
    return "";
  }
}

async function loadConversationHistory({
  prisma,
  workflow,
  agentSlug,
  conversationKey,
  limit = 20,
}) {
  if (!hasConversationModels(prisma)) return [];

  const rows = await prisma.agentConversationMessage.findMany({
    where: {
      workflow,
      agentSlug,
      conversationKey,
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(Number(limit) || 20, 80)),
    select: {
      role: true,
      content: true,
      createdAt: true,
    },
  });

  return rows.reverse();
}

async function saveConversationMessages({
  prisma,
  workflow,
  agentSlug,
  provider,
  conversationKey,
  phoneNumber,
  role,
  messages,
}) {
  if (!hasConversationModels(prisma)) return;

  const normalizedRole = role === "ai" ? "ai" : "human";
  const payloads = (Array.isArray(messages) ? messages : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((content) => ({
      workflow,
      agentSlug,
      provider,
      conversationKey,
      phoneNumber,
      role: normalizedRole,
      content,
    }));

  if (!payloads.length) return;

  await prisma.agentConversationMessage.createMany({
    data: payloads,
  });
}

async function getConversationSession({ prisma, workflow, agentSlug, conversationKey }) {
  if (!hasConversationModels(prisma)) return null;

  return prisma.agentConversationSession.findUnique({
    where: {
      workflow_agentSlug_conversationKey: {
        workflow,
        agentSlug,
        conversationKey,
      },
    },
  });
}

async function upsertConversationSessionHeartbeat({
  prisma,
  workflow,
  agentSlug,
  provider,
  conversationKey,
  phoneNumber,
}) {
  if (!hasConversationModels(prisma)) return null;

  return prisma.agentConversationSession.upsert({
    where: {
      workflow_agentSlug_conversationKey: {
        workflow,
        agentSlug,
        conversationKey,
      },
    },
    update: {
      provider,
      phoneNumber,
      lastMessageAt: new Date(),
    },
    create: {
      workflow,
      agentSlug,
      provider,
      conversationKey,
      phoneNumber,
      lastMessageAt: new Date(),
    },
  });
}

async function pauseConversationSessionForHuman({
  prisma,
  workflow,
  agentSlug,
  provider,
  conversationKey,
  phoneNumber,
  reason,
}) {
  if (!hasConversationModels(prisma)) return null;

  return prisma.agentConversationSession.upsert({
    where: {
      workflow_agentSlug_conversationKey: {
        workflow,
        agentSlug,
        conversationKey,
      },
    },
    update: {
      provider,
      phoneNumber,
      aiPaused: true,
      pausedReason: String(reason || "Transferencia para humano"),
      pausedAt: new Date(),
      lastMessageAt: new Date(),
    },
    create: {
      workflow,
      agentSlug,
      provider,
      conversationKey,
      phoneNumber,
      aiPaused: true,
      pausedReason: String(reason || "Transferencia para humano"),
      pausedAt: new Date(),
      lastMessageAt: new Date(),
    },
  });
}

async function clearConversationMemory({
  prisma,
  workflow,
  agentSlug,
  conversationKey,
}) {
  if (!hasConversationModels(prisma)) {
    return { messagesDeleted: 0, sessionsReset: 0 };
  }

  const deleted = await prisma.agentConversationMessage.deleteMany({
    where: {
      workflow,
      agentSlug,
      conversationKey,
    },
  });

  const reset = await prisma.agentConversationSession.updateMany({
    where: {
      workflow,
      agentSlug,
      conversationKey,
    },
    data: {
      aiPaused: false,
      pausedReason: null,
      pausedAt: null,
      lastMessageAt: new Date(),
    },
  });

  return {
    messagesDeleted: Number(deleted?.count || 0),
    sessionsReset: Number(reset?.count || 0),
  };
}

async function sendTextByProvider({ agent, provider, to, text }) {
  if (!env.allowOutboundMessages) {
    logOrchestrator("warn", "outbound.send.skipped", {
      explanation:
        "Envio outbound suprimido por configuracao global de somente recebimento.",
      agentSlug: agent?.slug || null,
      provider,
      to,
      textPreview: textOrEmpty(text).slice(0, 500),
    });
    return {
      suppressed: true,
      reason: "outbound_disabled",
      provider,
      to,
    };
  }

  const { config: providerConfig } = getAgentProviderConfig(agent, provider);
  if (provider === "meta") {
    return sendMetaTextMessage(providerConfig, { to, text });
  }
  return sendUazapiTextMessage(providerConfig, { to, text });
}

async function sendTypingIndicatorIfSupported({
  agent,
  provider,
  inboundMessageId = "",
  to = "",
}) {
  if (provider !== "meta") return { sent: false };
  const safeMessageId = textOrEmpty(inboundMessageId);
  if (!safeMessageId) return { sent: false };

  try {
    const { config: providerConfig } = getAgentProviderConfig(agent, provider);
    const result = await sendMetaReadTypingIndicator(providerConfig, {
      messageId: safeMessageId,
    });
    return {
      sent: true,
      result,
    };
  } catch (error) {
    logOrchestrator("warn", "typing_indicator.send_failed", {
      explanation:
        "Falha ao enviar typing indicator da Meta. Fluxo segue normalmente para nao interromper resposta.",
      agentSlug: agent?.slug || null,
      provider,
      to: normalizePhone(to),
      messageId: safeMessageId,
      message: error?.message || "unknown",
    });
    return {
      sent: false,
      error: error?.message || "unknown",
    };
  }
}

async function sendBufferedReply({
  agent,
  provider,
  to,
  text,
  inboundMessageId = "",
  initialDelayMs = AGENT_INITIAL_REPLY_DELAY_MS,
  interMessageDelayMs = AGENT_INTER_MESSAGE_DELAY_MS,
}) {
  if (!env.allowOutboundMessages) {
    return {
      sentCount: 0,
      sent: [],
      chunks: [],
      suppressed: true,
      reason: "outbound_disabled",
    };
  }

  const chunks = buildTypingChunks(text, {
    maxChunkLength: Math.max(120, Number(env.agentReplyChunkMaxLength) || 420),
    preferredChunkLength: Math.max(
      60,
      Math.min(
        Number(env.agentReplyChunkPreferredLength) || 180,
        Math.max(120, Number(env.agentReplyChunkMaxLength) || 420)
      )
    ),
  });
  const sent = [];
  const outgoing = chunks.length ? chunks : [{ text: String(text || "").trim() }];

  for (let index = 0; index < outgoing.length; index += 1) {
    const chunk = outgoing[index];
    const delayBeforeSend = index === 0 ? initialDelayMs : interMessageDelayMs;
    await sendTypingIndicatorIfSupported({
      agent,
      provider,
      inboundMessageId,
      to,
    });
    if (delayBeforeSend > 0) {
      await waitMs(delayBeforeSend);
    }

    const result = await sendTextByProvider({
      agent,
      provider,
      to,
      text: String(chunk?.text || "").trim(),
    });
    sent.push(result);
  }

  return {
    sentCount: sent.length,
    sent,
    chunks: outgoing.map((chunk) => String(chunk?.text || "").trim()).filter(Boolean),
  };
}

async function sendImmediateReplies({
  agent,
  provider,
  to,
  replies = [],
  inboundMessageId = "",
}) {
  const sent = [];
  const normalizedReplies = (Array.isArray(replies) ? replies : [])
    .map((item) => textOrEmpty(item))
    .filter(Boolean);

  for (let index = 0; index < normalizedReplies.length; index += 1) {
    if (index > 0 && AGENT_INTER_MESSAGE_DELAY_MS > 0) {
      await sendTypingIndicatorIfSupported({
        agent,
        provider,
        inboundMessageId,
        to,
      });
      await waitMs(AGENT_INTER_MESSAGE_DELAY_MS);
    }

    const result = await sendTextByProvider({
      agent,
      provider,
      to,
      text: normalizedReplies[index],
    });
    sent.push(result);
  }

  return sent;
}

function scheduleBufferedProcessing(jobPayload) {
  const existing = bufferTimers.get(jobPayload.timerKey);
  if (existing) {
    clearTimeout(existing);
  }

  const handler = setTimeout(() => {
    bufferTimers.delete(jobPayload.timerKey);
    processBufferedConversation(jobPayload).catch((error) => {
      logOrchestrator("error", "buffer.process.unhandled_error", {
        timerKey: jobPayload.timerKey,
        message: error?.message || "unknown",
      });
    });
  }, jobPayload.waitMs);

  if (typeof handler.unref === "function") {
    handler.unref();
  }

  bufferTimers.set(jobPayload.timerKey, handler);
}

async function processBufferedConversation(jobPayload) {
  const lockAcquired = await acquireLock(jobPayload.lockKey, 45000);
  if (!lockAcquired) {
    logOrchestrator("warn", "buffer.process.lock_not_acquired", {
      timerKey: jobPayload.timerKey,
      lockKey: jobPayload.lockKey,
    });
    return;
  }

  let executionRun = null;
  let workflow = resolveWorkflow("smg");

  try {
    const messages = await popAllBufferedMessages(jobPayload.bufferKey);
    if (!messages.length) {
      return;
    }

    const agent = getAgentOrThrow(jobPayload.agentSlug);
    workflow = getAgentWorkflow(agent);
    const prisma = getPrismaForAgent(agent);
    const aiConfig = getAiConfig(agent);
    const lastMessage = messages[messages.length - 1];
    const senderNumber = normalizePhone(lastMessage?.senderNumber);

    executionRun = await createExecutionRun({
      workflow,
      agentSlug: agent.slug,
      provider: jobPayload.provider,
      conversationKey: jobPayload.conversationKey,
      phoneNumber: senderNumber || "",
      triggerSource: "buffer:flush",
      inputPayload: {
        messagesCount: messages.length,
        timerKey: jobPayload.timerKey,
        conversationKey: jobPayload.conversationKey,
      },
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "buffer_flush_start",
      title: "Processamento do buffer iniciado",
      nodeType: "trigger",
      status: "success",
      payload: {
        messagesCount: messages.length,
      },
    });

    logOrchestrator("info", "buffer.process.received_messages", {
      explanation:
        "Mensagens removidas do buffer para processamento consolidado da IA.",
      agentSlug: jobPayload.agentSlug,
      conversationKey: jobPayload.conversationKey,
      provider: jobPayload.provider,
      messagesCount: messages.length,
      messagesPreview: messages.map((item) => ({
        senderNumber: item?.senderNumber || null,
        senderName: item?.senderName || null,
        providerMessageId: item?.providerMessageId || null,
        text: textOrEmpty(item?.text).slice(0, 300),
      })),
    });

    if (!senderNumber) {
      logOrchestrator("warn", "buffer.process.sender_not_identified", {
        agentSlug: agent.slug,
        timerKey: jobPayload.timerKey,
      });
      await logExecutionEvent(workflow, executionRun?.id, {
        stepKey: "buffer_sender_missing",
        title: "Remetente nao identificado",
        nodeType: "condition",
        status: "warning",
        payload: {},
      });
      if (executionRun?.id) {
        await finishExecutionRun({
          workflow,
          runId: executionRun.id,
          status: "warning",
          outputPayload: {
            reason: "sender_not_identified",
          },
        }).catch(() => null);
      }
      return;
    }

    await upsertConversationSessionHeartbeat({
      prisma,
      workflow,
      agentSlug: agent.slug,
      provider: jobPayload.provider,
      conversationKey: jobPayload.conversationKey,
      phoneNumber: senderNumber,
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "session_heartbeat",
      title: "Sessao atualizada",
      nodeType: "process",
      status: "success",
      payload: {
        conversationKey: jobPayload.conversationKey,
      },
    });

    const historyItems = await loadConversationHistory({
      prisma,
      workflow,
      agentSlug: agent.slug,
      conversationKey: jobPayload.conversationKey,
      limit: aiConfig.historyLimit,
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "history_loaded",
      title: "Historico de conversa carregado",
      nodeType: "database",
      status: "success",
      payload: {
        historyItems: historyItems.length,
      },
    });

    const promptText = loadAgentPromptText(agent);
    let pausedSessionFromTool = null;
    const tools = await resolveAgentTools({
      agent,
      context: {
        agent,
        workflow,
        provider: jobPayload.provider,
        conversationKey: jobPayload.conversationKey,
        senderNumber,
        historyItems,
        messages,
        prisma,
        log: logOrchestrator,
      },
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "tools_resolved",
      title: "Tools resolvidas para a execucao",
      nodeType: "process",
      status: "info",
      payload: {
        toolsCount: tools.length,
      },
    });

    const inboundContext = await buildInboundPayloadContext({
      agent,
      workflow,
      prisma,
      senderNumber,
      historyItems,
      messages,
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "payload_context_resolved",
      title: "Payload operacional consolidado para o LLM",
      nodeType: "process",
      status: "success",
      payload: {
        leadStatus: inboundContext?.payload?.lead?.status || null,
        pipelineOrigin: inboundContext?.payload?.lead?.pipeline_origin || null,
        segmento: inboundContext?.payload?.lead?.segmento || null,
        hasFormulario: Boolean(inboundContext?.payload?.formulario),
        learningsCount: Number(inboundContext?.contextualLearnings?.length || 0),
      },
    });

    if (Array.isArray(inboundContext?.ragChunks) && inboundContext.ragChunks.length) {
      logOrchestrator("info", "buffer.process.rag_context", {
        explanation:
          "Trechos de conhecimento recuperados do RAG para contextualizar a resposta da Clara.",
        agentSlug: agent.slug,
        conversationKey: jobPayload.conversationKey,
        selectedSources: inboundContext.ragChunks.map((item) => ({
          source: item.sourceId,
          score: item.score,
        })),
        learnings: (inboundContext.contextualLearnings || []).map((item) => ({
          segmento: item.segmento,
          etapa: item.etapa,
          origem: item.origem,
        })),
      });
    }

    const systemPrompt = buildSystemPrompt({
      agent,
      promptText,
      tools,
      ragContextText: inboundContext?.ragContextText || "",
    });
    const userPrompt = buildUserPrompt({
      senderName: String(lastMessage?.senderName || "").trim(),
      senderNumber,
      historyItems,
      messages,
      payloadContext: inboundContext?.payload || null,
    });

    logOrchestrator("info", "buffer.process.ai_prompt", {
      explanation:
        "Prompt enviado para a IA apos consolidar buffer e historico da conversa.",
      agentSlug: agent.slug,
      conversationKey: jobPayload.conversationKey,
      systemPromptPreview: textOrEmpty(systemPrompt).slice(0, 1200),
      userPromptPreview: textOrEmpty(userPrompt).slice(0, 1200),
      tools: tools.map((tool) => tool.name),
    });

    await saveConversationMessages({
      prisma,
      workflow,
      agentSlug: agent.slug,
      provider: jobPayload.provider,
      conversationKey: jobPayload.conversationKey,
      phoneNumber: senderNumber,
      role: "human",
      messages: messages.map((item) => item.text),
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "inbound_saved",
      title: "Mensagens inbound salvas",
      nodeType: "database",
      status: "success",
      payload: {
        count: messages.length,
      },
    });

    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "ai_request",
      title: "Solicitacao enviada para IA",
      nodeType: "ai",
      status: "info",
      payload: {
        model: aiConfig.model,
        useLangChain: aiConfig.useLangChain,
      },
    });

    const aiResult = await generateAiReply({
      systemPrompt,
      userPrompt,
      fallbackReply: aiConfig.fallbackReply,
      useLangChain: aiConfig.useLangChain,
      model: aiConfig.model,
      apiKey: aiConfig.apiKey,
      allowEnvFallback: true,
      toolsConfig: {
        humanHandoffEnabled: aiConfig.humanHandoffEnabled,
      },
      externalTools: tools,
      onHumanHandoff: async ({ reason }) => {
        pausedSessionFromTool = await pauseConversationSessionForHuman({
          prisma,
          workflow,
          agentSlug: agent.slug,
          provider: jobPayload.provider,
          conversationKey: jobPayload.conversationKey,
          phoneNumber: senderNumber,
          reason,
        });
      },
    });

    logOrchestrator("info", "buffer.process.ai_response", {
      explanation: "Resposta retornada pela IA para envio ao lead.",
      agentSlug: agent.slug,
      conversationKey: jobPayload.conversationKey,
      model: aiResult?.model || null,
      usedFallback: Boolean(aiResult?.usedFallback),
      usedLangChain: Boolean(aiResult?.usedLangChain),
      handoffTriggered: Boolean(aiResult?.handoffTriggered),
      usedTools: Array.isArray(aiResult?.usedTools) ? aiResult.usedTools : [],
      responseText: textOrEmpty(aiResult?.text).slice(0, 1200),
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "ai_response",
      title: "Resposta gerada pela IA",
      nodeType: "ai",
      status: aiResult?.usedFallback ? "warning" : "success",
      payload: {
        model: aiResult?.model || null,
        usedFallback: Boolean(aiResult?.usedFallback),
        usedLangChain: Boolean(aiResult?.usedLangChain),
        handoffTriggered: Boolean(aiResult?.handoffTriggered),
        usedTools: Array.isArray(aiResult?.usedTools) ? aiResult.usedTools : [],
      },
    });

    const replyText = textOrEmpty(aiResult?.text || aiConfig.fallbackReply);
    const sentReply = await sendBufferedReply({
      agent,
      provider: jobPayload.provider,
      to: senderNumber,
      text: replyText,
      inboundMessageId: textOrEmpty(lastMessage?.providerMessageId),
      initialDelayMs: AGENT_INITIAL_REPLY_DELAY_MS,
      interMessageDelayMs: AGENT_INTER_MESSAGE_DELAY_MS,
    });

    logOrchestrator("info", "buffer.process.provider_response", {
      explanation:
        "Resultado do envio da resposta da IA para o provider de WhatsApp.",
      agentSlug: agent.slug,
      provider: jobPayload.provider,
      conversationKey: jobPayload.conversationKey,
      sentCount: sentReply.sentCount,
      chunks: sentReply.chunks,
      providerRawResponse: safeJson(sentReply.sent),
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "provider_send",
      title: "Mensagens enviadas ao provider",
      nodeType: "process",
      status: "success",
      payload: {
        sentCount: sentReply.sentCount,
      },
    });

    const outboundMessages = sentReply.suppressed
      ? []
      : sentReply.chunks.length
      ? sentReply.chunks
      : [replyText];

    if (outboundMessages.length) {
      await saveConversationMessages({
        prisma,
        workflow,
        agentSlug: agent.slug,
        provider: jobPayload.provider,
        conversationKey: jobPayload.conversationKey,
        phoneNumber: senderNumber,
        role: "ai",
        messages: outboundMessages,
      });
      await logExecutionEvent(workflow, executionRun?.id, {
        stepKey: "outbound_saved",
        title: "Mensagens outbound salvas",
        nodeType: "database",
        status: "success",
        payload: {
          count: outboundMessages.length,
        },
      });
    } else if (sentReply.suppressed) {
      await logExecutionEvent(workflow, executionRun?.id, {
        stepKey: "outbound_suppressed",
        title: "Envio outbound suprimido por configuracao",
        nodeType: "condition",
        status: "warning",
        payload: {
          reason: sentReply.reason || "outbound_disabled",
        },
      });
    }

    await upsertConversationSessionHeartbeat({
      prisma,
      workflow,
      agentSlug: agent.slug,
      provider: jobPayload.provider,
      conversationKey: jobPayload.conversationKey,
      phoneNumber: senderNumber,
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "session_heartbeat_final",
      title: "Sessao final atualizada",
      nodeType: "process",
      status: "success",
      payload: {},
    });

    logOrchestrator("info", "buffer.process.success", {
      workflow,
      agentSlug: agent.slug,
      provider: jobPayload.provider,
      conversationKey: jobPayload.conversationKey,
      inboundMessages: messages.length,
      outboundMessages: outboundMessages.length,
      model: aiResult?.model || null,
      usedFallback: Boolean(aiResult?.usedFallback),
      usedLangChain: Boolean(aiResult?.usedLangChain),
      handoffTriggered: Boolean(aiResult?.handoffTriggered),
      handoffReason: aiResult?.handoffReason || null,
      pausedSessionId: pausedSessionFromTool?.id || null,
      usedTools: Array.isArray(aiResult?.usedTools) ? aiResult.usedTools : [],
    });
    if (executionRun?.id) {
      await finishExecutionRun({
        workflow,
        runId: executionRun.id,
        status: "success",
        outputPayload: {
          inboundMessages: messages.length,
          outboundMessages: outboundMessages.length,
          model: aiResult?.model || null,
          usedFallback: Boolean(aiResult?.usedFallback),
          handoffTriggered: Boolean(aiResult?.handoffTriggered),
        },
      }).catch(() => null);
    }
  } catch (error) {
    logOrchestrator("error", "buffer.process.error", {
      agentSlug: jobPayload.agentSlug,
      provider: jobPayload.provider,
      timerKey: jobPayload.timerKey,
      message: error?.message || "unknown",
    });
    await logExecutionEvent(workflow, executionRun?.id, {
      stepKey: "buffer_error",
      title: "Falha no processamento do buffer",
      nodeType: "process",
      status: "error",
      payload: {
        message: error?.message || "unknown",
      },
    });
    if (executionRun?.id) {
      await finishExecutionRun({
        workflow,
        runId: executionRun.id,
        status: "error",
        errorMessage: error?.message || "unknown",
        outputPayload: {
          reason: "buffer_process_error",
        },
      }).catch(() => null);
    }
  } finally {
    await releaseLock(jobPayload.lockKey).catch(() => null);
  }
}

async function clearConversationAndPendingBuffer({
  agent,
  provider,
  conversationKey,
  timerKey,
  bufferKey,
  destination,
}) {
  const prisma = getPrismaForAgent(agent);
  const workflow = getAgentWorkflow(agent);
  const tables = getWorkflowTables(prisma, workflow);

  const existingTimer = bufferTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    bufferTimers.delete(timerKey);
  }

  await popAllBufferedMessages(bufferKey).catch(() => []);
  const clearResult = await clearConversationMemory({
    prisma,
    workflow,
    agentSlug: agent.slug,
    conversationKey,
  });
  const normalizedDestination =
    normalizeE164(destination) || normalizePhone(destination) || textOrEmpty(destination);

  const lead = await findLeadForInboundContext({
    tables,
    senderNumber: normalizedDestination || destination,
    agentSlug: agent.slug,
  });

  let leadReset = {
    foundLead: false,
    leadId: null,
    status: null,
    timelineDeleted: 0,
    crmDeleted: 0,
    analysesDeleted: 0,
    formsDeleted: 0,
    tasksDeleted: 0,
  };

  if (lead) {
    const linkedFormId = textOrEmpty(lead.diagnosticoFormularioId) || null;
    const phoneCandidates = buildPhoneCandidates(normalizedDestination);
    const formDeleteWhereOr = [];
    if (linkedFormId) {
      formDeleteWhereOr.push({ id: linkedFormId });
    }
    for (const candidate of phoneCandidates) {
      const normalizedCandidate = textOrEmpty(candidate);
      if (!normalizedCandidate) continue;
      formDeleteWhereOr.push({ telefone: normalizedCandidate });
    }
    const resetAt = new Date().toISOString();

    let transactionResult = null;
    for (let attempt = 1; attempt <= CLEAR_RESET_MAX_ATTEMPTS; attempt += 1) {
      try {
        transactionResult = await prisma.$transaction(
          async (tx) => {
            const txTables = getWorkflowTables(tx, workflow);
            const timelineDelete = await tx.leadAutomacaoTimeline.deleteMany({
              where: {
                workflow,
                leadId: lead.id,
              },
            });
            const crmDelete = await tx.leadCrm.deleteMany({
              where: {
                workflow,
                leadId: lead.id,
              },
            });
            const analysisDelete = await tx.analiseMaturidade.deleteMany({
              where: {
                workflow,
                leadId: lead.id,
              },
            });
            const formDelete = formDeleteWhereOr.length
              ? await tx.leadDiagnostico.deleteMany({
                  where: {
                    workflow,
                    OR: formDeleteWhereOr,
                  },
                })
              : { count: 0 };
            const tasksDelete = await tx.taskComercial.deleteMany({
              where: {
                workflow,
                leadId: lead.id,
              },
            });
            const updatedLead = await txTables.lead.update({
              where: { id: lead.id },
              data: {
                status: "NOVO_LEAD",
                automationActive: true,
                formularioPreenchido: false,
                diagnosticoFormularioId: null,
                ultimaInteracao: new Date(),
                ultimoEnvioIa: null,
                proximoFollowupEm: null,
                followupNivel: 0,
                dadosBrutos: {
                  wf2: {
                    resetByClearCommand: true,
                    resetAt,
                    previousStatus: String(lead.status || "").trim() || null,
                    fullDataCleared: true,
                  },
                },
              },
            });

            return {
              updatedLead,
              timelineDeleted: Number(timelineDelete?.count || 0),
              crmDeleted: Number(crmDelete?.count || 0),
              analysesDeleted: Number(analysisDelete?.count || 0),
              formsDeleted: Number(formDelete?.count || 0),
              tasksDeleted: Number(tasksDelete?.count || 0),
            };
          },
          CLEAR_RESET_TX_OPTIONS
        );
        break;
      } catch (error) {
        const canRetry =
          attempt < CLEAR_RESET_MAX_ATTEMPTS && isPrismaInteractiveTxExpiredError(error);
        if (!canRetry) {
          throw error;
        }
        logOrchestrator("warn", "clear.reset.retry_after_tx_timeout", {
          agentSlug: agent.slug,
          workflow,
          leadId: lead.id,
          attempt,
          maxAttempts: CLEAR_RESET_MAX_ATTEMPTS,
          message: error?.message || "unknown",
        });
      }
    }

    leadReset = {
      foundLead: true,
      leadId: transactionResult?.updatedLead?.id || lead.id,
      status: transactionResult?.updatedLead?.status || "NOVO_LEAD",
      timelineDeleted: Number(transactionResult?.timelineDeleted || 0),
      crmDeleted: Number(transactionResult?.crmDeleted || 0),
      analysesDeleted: Number(transactionResult?.analysesDeleted || 0),
      formsDeleted: Number(transactionResult?.formsDeleted || 0),
      tasksDeleted: Number(transactionResult?.tasksDeleted || 0),
    };
  }

  await sendTextByProvider({
    agent,
    provider,
    to: destination,
    text: "Pronto. Apaguei historico, formulario, agendamentos e todo o contexto do seu lead.",
  });

  return {
    ...clearResult,
    leadReset,
  };
}

async function queueInboundForOrchestrator({
  agent,
  inboundProvider,
  event,
  execution = null,
}) {
  const aiConfig = getAiConfig(agent);
  const senderNumber = normalizePhone(event?.from);
  const destinationNumber = normalizePhone(event?.to);
  const text = textOrEmpty(event?.text);
  const workflow = getAgentWorkflow(agent);
  const runId = execution?.runId || null;

  logOrchestrator("info", "queue.inbound.received", {
    explanation:
      "Mensagem inbound recebida pelo orquestrador antes de regras de WF2/buffer.",
    agentSlug: agent.slug,
    inboundProvider,
    senderNumber,
    destinationNumber,
    text: text.slice(0, 1000),
    messageId: textOrEmpty(event?.messageId),
  });

  if (!text) {
    await logExecutionEvent(workflow, runId, {
      stepKey: "ignored_empty_text",
      title: "Mensagem ignorada por texto vazio",
      nodeType: "condition",
      status: "warning",
      payload: {},
    });
    return {
      handled: false,
      ignored: true,
      reason: "empty_text",
      buffered: false,
    };
  }

  const conversationKey = toConversationKey({
    provider: inboundProvider,
    from: senderNumber,
    to: destinationNumber,
  });
  const timerKey = `${workflow}:${agent.slug}:${conversationKey}`;
  const bufferKey = buildRedisKey(`agent-buffer:${timerKey}`);
  const lockKey = buildRedisKey(`agent-lock:${timerKey}`);
  const prisma = getPrismaForAgent(agent);

  await logExecutionEvent(workflow, runId, {
    stepKey: "conversation_key_resolved",
    title: "Chave de conversa resolvida",
    nodeType: "process",
    status: "info",
    payload: {
      conversationKey,
      senderNumber,
      destinationNumber,
    },
  });

  const startCommand = parseStartOutboundCommand(text);
  if (agent?.wf2?.enabled && startCommand) {
    const startResult = await startOutboundFromCommand({
      agentSlug: agent.slug,
      workflow,
      provider: inboundProvider,
      phoneNumber: senderNumber,
      profileName: textOrEmpty(event?.profileName),
      segmentHint: startCommand.segmentHint,
    });

    await logExecutionEvent(workflow, runId, {
      stepKey: "outbound_start_command",
      title: "Comando /start processado",
      nodeType: "process",
      status: startResult?.processed ? "success" : "warning",
      payload: {
        command: "/start",
        segmentHint: startCommand.segmentHint || null,
        processed: Boolean(startResult?.processed),
        reason: startResult?.reason || null,
        leadId: startResult?.lead?.id || null,
        segmentApplied: startResult?.segmentApplied || null,
      },
    });

    if (!startResult?.processed && textOrEmpty(startResult?.immediateReply)) {
      await sendTextByProvider({
        agent,
        provider: inboundProvider,
        to: senderNumber,
        text: startResult.immediateReply,
      });
    }

    return {
      handled: true,
      ignored: false,
      reason: startResult?.reason || "outbound_start_command",
      buffered: false,
      startedOutbound: Boolean(startResult?.processed),
      conversationKey,
      startResult,
    };
  }

  if (aiConfig.clearMemoryCommandEnabled && isClearMemoryCommand(text)) {
    const clearResult = await clearConversationAndPendingBuffer({
      agent,
      provider: inboundProvider,
      conversationKey,
      timerKey,
      bufferKey,
      destination: senderNumber,
    });

    await logExecutionEvent(workflow, runId, {
      stepKey: "memory_cleared",
      title: "Memoria de conversa limpa",
      nodeType: "process",
      status: "success",
      payload: {
        command: "/clear",
        messagesDeleted: Number(clearResult?.messagesDeleted || 0),
        sessionsReset: Number(clearResult?.sessionsReset || 0),
        leadReset: {
          foundLead: Boolean(clearResult?.leadReset?.foundLead),
          leadId: clearResult?.leadReset?.leadId || null,
          status: clearResult?.leadReset?.status || null,
          timelineDeleted: Number(clearResult?.leadReset?.timelineDeleted || 0),
          crmDeleted: Number(clearResult?.leadReset?.crmDeleted || 0),
          analysesDeleted: Number(clearResult?.leadReset?.analysesDeleted || 0),
          formsDeleted: Number(clearResult?.leadReset?.formsDeleted || 0),
          tasksDeleted: Number(clearResult?.leadReset?.tasksDeleted || 0),
        },
      },
    });

    return {
      handled: true,
      ignored: false,
      reason: "memory_cleared",
      buffered: false,
      cleared: true,
      clearResult,
      conversationKey,
    };
  }

  if (agent?.wf2?.enabled) {
    const wf2Result = await registerInboundMessageEvent({
      agentSlug: agent.slug,
      workflow,
      provider: inboundProvider,
      phoneNumber: senderNumber,
      messageText: text,
      profileName: textOrEmpty(event?.profileName),
    });

    logOrchestrator("info", "queue.inbound.wf2_result", {
      explanation:
        "Resultado do registro do inbound no WF2 (estado do lead, opt-out, token, etc).",
      agentSlug: agent.slug,
      conversationKey,
      wf2Result: safeJson({
        foundLead: Boolean(wf2Result?.foundLead),
        suppressAi: Boolean(wf2Result?.suppressAi),
        reason: wf2Result?.reason || null,
        immediateReply: textOrEmpty(wf2Result?.immediateReply).slice(0, 300),
        immediateRepliesCount: Array.isArray(wf2Result?.immediateReplies)
          ? wf2Result.immediateReplies.length
          : 0,
      }),
    });

    await logExecutionEvent(workflow, runId, {
      stepKey: "wf2_inbound_registered",
      title: "Evento inbound registrado no WF2",
      nodeType: "process",
      status: wf2Result?.foundLead ? "success" : "warning",
      payload: {
        reason: wf2Result?.reason || null,
        suppressAi: Boolean(wf2Result?.suppressAi),
      },
    });

    if (wf2Result?.suppressAi) {
      const immediateReplies = Array.isArray(wf2Result?.immediateReplies)
        ? wf2Result.immediateReplies
        : [];
      if (immediateReplies.length) {
        await sendImmediateReplies({
          agent,
          provider: inboundProvider,
          to: senderNumber,
          replies: immediateReplies,
          inboundMessageId: textOrEmpty(event?.messageId),
        });
      } else if (textOrEmpty(wf2Result.immediateReply)) {
        await sendImmediateReplies({
          agent,
          provider: inboundProvider,
          to: senderNumber,
          replies: [wf2Result.immediateReply],
          inboundMessageId: textOrEmpty(event?.messageId),
        });
      }

      await logExecutionEvent(workflow, runId, {
        stepKey: "wf2_suppressed_ai",
        title: "Resposta tratada pelo WF2 sem IA",
        nodeType: "process",
        status: "success",
        payload: {
          reason: wf2Result.reason || "wf2_suppressed_ai",
          immediateReply: Boolean(textOrEmpty(wf2Result.immediateReply)),
          immediateRepliesCount: immediateReplies.length,
        },
      });

      return {
        handled: true,
        ignored: false,
        reason: wf2Result.reason || "wf2_suppressed_ai",
        buffered: false,
        waitSeconds: null,
        pausedForHuman: false,
        conversationKey,
      };
    }

    logOrchestrator("warn", "queue.inbound.wf2_passed_to_ai", {
      explanation:
        "WF2 nao suprimiu resposta. O inbound sera encaminhado para o fluxo da IA.",
      agentSlug: agent.slug,
      conversationKey,
      wf2Reason: wf2Result?.reason || "unknown",
      foundLead: Boolean(wf2Result?.foundLead),
      suppressAi: Boolean(wf2Result?.suppressAi),
    });
  }

  const session = await getConversationSession({
    prisma,
    workflow,
    agentSlug: agent.slug,
    conversationKey,
  });
  if (session?.aiPaused) {
    await saveConversationMessages({
      prisma,
      workflow,
      agentSlug: agent.slug,
      provider: inboundProvider,
      conversationKey,
      phoneNumber: senderNumber,
      role: "human",
      messages: [text],
    });

    await upsertConversationSessionHeartbeat({
      prisma,
      workflow,
      agentSlug: agent.slug,
      provider: inboundProvider,
      conversationKey,
      phoneNumber: senderNumber,
    });

    await logExecutionEvent(workflow, runId, {
      stepKey: "paused_for_human",
      title: "Conversa pausada para humano",
      nodeType: "condition",
      status: "warning",
      payload: {
        pausedReason: session?.pausedReason || null,
      },
    });

    return {
      handled: true,
      ignored: false,
      reason: "paused_for_human",
      buffered: false,
      pausedForHuman: true,
      conversationKey,
    };
  }

  if (!env.allowOutboundMessages) {
    await saveConversationMessages({
      prisma,
      workflow,
      agentSlug: agent.slug,
      provider: inboundProvider,
      conversationKey,
      phoneNumber: senderNumber,
      role: "human",
      messages: [text],
    });

    await upsertConversationSessionHeartbeat({
      prisma,
      workflow,
      agentSlug: agent.slug,
      provider: inboundProvider,
      conversationKey,
      phoneNumber: senderNumber,
    });

    await logExecutionEvent(workflow, runId, {
      stepKey: "outbound_disabled_inbound_only",
      title: "Modo somente recebimento ativo",
      nodeType: "condition",
      status: "warning",
      payload: {
        reason: "outbound_disabled",
      },
    });

    return {
      handled: true,
      ignored: false,
      reason: "outbound_disabled",
      buffered: false,
      waitSeconds: null,
      pausedForHuman: false,
      conversationKey,
    };
  }

  const bufferedMessage = {
    text,
    senderNumber,
    senderName: textOrEmpty(event?.profileName),
    providerMessageId: textOrEmpty(event?.messageId),
    receivedAt: Date.now(),
  };

  await pushBufferedMessage(bufferKey, bufferedMessage, aiConfig.bufferSeconds + 120);

  logOrchestrator("info", "queue.inbound.buffer_push", {
    explanation:
      "Mensagem adicionada ao buffer para juntar entradas proximas antes da chamada da IA.",
    agentSlug: agent.slug,
    conversationKey,
    bufferKey,
    ttlSeconds: aiConfig.bufferSeconds + 120,
    waitSeconds: aiConfig.bufferSeconds,
    bufferedMessage: safeJson({
      senderNumber: bufferedMessage.senderNumber,
      senderName: bufferedMessage.senderName,
      providerMessageId: bufferedMessage.providerMessageId,
      text: textOrEmpty(bufferedMessage.text).slice(0, 300),
      receivedAt: bufferedMessage.receivedAt,
    }),
  });

  await logExecutionEvent(workflow, runId, {
    stepKey: "buffer_queued",
    title: "Mensagem enfileirada no buffer",
    nodeType: "queue",
    status: "success",
    payload: {
      waitSeconds: aiConfig.bufferSeconds,
      bufferKey,
    },
  });

  scheduleBufferedProcessing({
    timerKey,
    lockKey,
    bufferKey,
    waitMs: aiConfig.bufferSeconds * 1000,
    agentSlug: agent.slug,
    provider: inboundProvider,
    conversationKey,
  });

  return {
    handled: true,
    ignored: false,
    reason: "buffered",
    buffered: true,
    waitSeconds: aiConfig.bufferSeconds,
    conversationKey,
  };
}

module.exports = {
  isAiOrchestratorEnabled,
  queueInboundForOrchestrator,
};
