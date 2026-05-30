const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { promises: dnsPromises } = require("dns");
const { LeadSegment, ScrapeSource } = require("@prisma/client");
const env = require("../../config/env");
const { listWorkflowConfigs, resolveWorkflow } = require("../../config/workflows");
const { getPrisma } = require("../../lib/prisma");
const { generateAiReply } = require("../../lib/ai-client");
const { getWorkflowTables } = require("../workflow-data-access.service");
const { listAgents, getAgentOrThrow, getAgentProviderConfig } = require("../agents/registry.service");
const { normalizeProvider } = require("../agents/helpers");
const {
  sendMetaTextMessage,
  sendMetaDocumentMessage,
} = require("../agents/providers/meta.provider");
const {
  sendUazapiTextMessage,
  sendUazapiDocumentMessage,
} = require("../agents/providers/uazapi.provider");
const { generateAnalysisPdf } = require("./analysis-pdf.service");
const {
  textOrEmpty,
  normalizeE164,
  buildPhoneCandidates,
  mergeDadosBrutos,
  clipText,
  extractInboundToken,
  isWithinAutomationSchedule,
  addHours,
  addDays,
} = require("./helpers");

const FINAL_STATUSES = new Set(["DESQUALIFICADO", "DIAGNOSTICO_AGENDADO"]);
const ANALYSIS_SEQUENCE_DELAY_MS = Math.max(
  0,
  Number(process.env.WF2_ANALYSIS_SEQUENCE_DELAY_MS || 2500)
);
const ANALYSIS_INITIAL_REPLY_DELAY_MS = Math.max(
  0,
  Number(env.wf2AnalysisInitialReplyDelayMs || process.env.WF2_ANALYSIS_INITIAL_REPLY_DELAY_MS || 10000)
);
const WF2_MIN_POST_READ_INTERACTIONS = Math.max(
  0,
  Number(process.env.WF2_MIN_POST_READ_INTERACTIONS || 2)
);
const WF2_PERMISSION_POST_READ_INTERACTIONS = Math.max(
  WF2_MIN_POST_READ_INTERACTIONS + 1,
  Number(process.env.WF2_PERMISSION_POST_READ_INTERACTIONS || 3)
);
const analysisInFlightLocks = new Set();
const OPT_OUT_REGEX = /\b(parar|sair|remover|nao quero|não quero|stop|cancelar|opt[\s-]?out)\b/i;
const START_SEGMENT_ALIASES = {
  dentista: "dentista",
  odontologia: "dentista",
  nutri: "nutricionista",
  nutricionista: "nutricionista",
  fisio: "fisioterapeuta",
  fisioterapeuta: "fisioterapeuta",
  fisioterapia: "fisioterapeuta",
  dermato: "dermatologista",
  dermatologista: "dermatologista",
  ortopedia: "ortopedista",
  ortopedista: "ortopedista",
  barbeiro: "barbearia",
  barbearia: "barbearia",
  estetica: "estetica",
  corretor: "corretor",
  corretora: "corretor",
  imobiliaria: "corretor",
  restaurante: "restaurante",
  gastronomia: "restaurante",
  automovel: "automovel",
  automotivo: "automovel",
  auto: "automovel",
  construtora: "construtora",
  construcao: "construtora",
  engenharia: "engenharia",
  arquitetura: "arquitetura",
  outro: "outro",
};
const DEFAULT_WF2_FORM_LINK = "https://sistema.smgcompany.com.br/diagnostico";
const LEGACY_WF2_FORM_LINK = "https://smg.com.br/diagnostico";
const DEFAULT_PUBLIC_PDF_BASE_URL =
  textOrEmpty(process.env.WF2_PUBLIC_PDF_BASE_URL) || "https://api-smg.iurygabriel.xyz";
const INBOUND_WELCOME_TEMPLATE =
  "Oi {nome}, tudo bem? Eu sou a Clara, consultora virtual da SMG. Vou te acompanhar por aqui para montar seu diagnostico operacional.";
const INBOUND_FORM_LINK_TEMPLATE =
  "Para comecarmos, preencha esse formulario rapido para eu personalizar sua analise:\n{form_link}";
const AI_TEXT_MAX_CHARS = 420;
const WF2_OPERATIONAL_SYSTEM_PROMPT = [
  "Voce e Clara, consultora comercial da SMG.",
  "Seu canal e WhatsApp com donos e gestores de pequenas e medias empresas no Brasil.",
  "Escreva sempre em pt-BR natural, humano, direto e consultivo.",
  "Nunca use markdown, listas, emoji, aspas extras ou placeholders.",
  "Nao invente dados, links, horarios, status, promessas ou resultados.",
  "Mantenha intencao comercial clara e mensagem curta.",
].join(" ");

function logWf2(level, event, payload = {}) {
  const stamp = new Date().toISOString();
  const line = `[wf2][${stamp}][${event}]`;
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

function asLeadSegment(value, fallback = LeadSegment.outro) {
  const raw = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LeadSegment, raw)) {
    return LeadSegment[raw];
  }
  const values = Object.values(LeadSegment);
  const found = values.find((item) => String(item).toLowerCase() === raw);
  return found || fallback;
}

function normalizeCommandText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function resolveStartSegment(rawSegment = "") {
  const normalized = normalizeCommandText(rawSegment)
    .replace(/^nicho[\s:=-]*/i, "")
    .replace(/[.,;!?]+$/g, "")
    .trim();
  if (!normalized) {
    return { hasSegmentHint: false, segment: null };
  }

  const firstToken = normalized.split(/\s+/)[0] || "";
  const mapped = START_SEGMENT_ALIASES[firstToken] || "";
  if (!mapped) {
    return { hasSegmentHint: true, segment: null, invalidInput: firstToken };
  }

  return {
    hasSegmentHint: true,
    segment: asLeadSegment(mapped, LeadSegment.outro),
    invalidInput: null,
  };
}

function isInboundLead(lead) {
  const origin = String(lead?.pipelineOrigin || "").trim().toLowerCase();
  const channel = String(lead?.canalAquisicao || "").trim().toLowerCase();
  return (
    origin === "diagnostico_site" ||
    origin.startsWith("inbound") ||
    channel.startsWith("inbound")
  );
}

function isInside24hWindow(lead) {
  if (!lead?.ultimaInteracao) return false;
  const diffMs = Date.now() - new Date(lead.ultimaInteracao).getTime();
  return diffMs < 24 * 60 * 60 * 1000;
}

function nextFollowupDate(config, level, now = new Date()) {
  if (level <= 0) {
    return addHours(now, Number(config.followupHorasFup1 || 24));
  }
  if (level === 1) {
    return addHours(now, Number(config.followupHorasFup2 || 48));
  }
  if (level === 2) {
    return addDays(now, Number(config.followupDiasFup3 || 7));
  }
  return addHours(now, Number(config.followupRecorrenteHx || 84));
}

function buildConfigDefaultDays() {
  return ["seg", "ter", "qua", "qui", "sex"];
}

async function waitAnalysisSequenceDelay() {
  if (ANALYSIS_SEQUENCE_DELAY_MS <= 0) return;
  await new Promise((resolve) => {
    setTimeout(resolve, ANALYSIS_SEQUENCE_DELAY_MS);
  });
}

async function waitMs(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (!safeMs) return;
  await new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

async function ensureWorkflowConfigRows(prisma, workflow) {
  const configAutomacao = await prisma.configAutomacao.upsert({
    where: { workflow },
    update: {},
    create: {
      workflow,
      horarioInicio: "08:00",
      horarioFim: "20:00",
      diasPersonalizados: buildConfigDefaultDays(),
      tempoRespostaMin: 1,
      tempoRespostaMax: 3,
      timezone: "America/Sao_Paulo",
      followupHorasFup1: 24,
      followupHorasFup2: 48,
      followupDiasFup3: 7,
      followupRecorrenteHx: 84,
    },
  });

  await prisma.configNotificacao.upsert({
    where: {
      workflow_canal: {
        workflow,
        canal: "log",
      },
    },
    update: {},
    create: {
      workflow,
      canal: "log",
      enabled: true,
      target: "",
    },
  });

  return configAutomacao;
}

function leadSummary(lead) {
  if (!lead) return null;
  return {
    id: lead.id,
    nome: lead.nome,
    telefone: lead.telefone,
    empresa: lead.empresa,
    segmento: lead.segmento,
    status: lead.status,
    pipelineOrigin: lead.pipelineOrigin,
    canalAquisicao: lead.canalAquisicao,
    automationActive: Boolean(lead.automationActive),
    agentSlug: lead.agentSlug || "default-sdr",
    formularioPreenchido: Boolean(lead.formularioPreenchido),
    diagnosticoFormularioId: lead.diagnosticoFormularioId || null,
  };
}

async function appendTimeline(prisma, payload) {
  return prisma.leadAutomacaoTimeline.create({
    data: {
      workflow: payload.workflow,
      leadId: payload.leadId,
      tipo: payload.tipo,
      etapa: payload.etapa || null,
      direcao: payload.direcao || null,
      mensagem: payload.mensagem || null,
      metadata: payload.metadata || null,
    },
  });
}

async function findLeadByPhone(tables, phoneNumber, agentSlug = "") {
  const candidates = buildPhoneCandidates(phoneNumber);
  if (!candidates.length) return null;

  const where = {
    telefone: {
      in: candidates,
    },
  };
  if (textOrEmpty(agentSlug)) {
    where.agentSlug = textOrEmpty(agentSlug);
  }

  const firstMatch = await tables.lead.findFirst({
    where,
    orderBy: { criadoEm: "desc" },
  });
  if (firstMatch || !textOrEmpty(agentSlug)) {
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

async function findLatestDiagnosticoByPhone(prisma, workflow, phoneNumber) {
  const candidates = buildPhoneCandidates(phoneNumber);
  if (!candidates.length) return null;

  return prisma.leadDiagnostico.findFirst({
    where: {
      workflow,
      telefone: {
        in: candidates,
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
}

async function resolveAgentForLead(lead) {
  const slug = textOrEmpty(lead?.agentSlug || "default-sdr");
  return getAgentOrThrow(slug);
}

async function sendLeadText({
  agent,
  provider,
  lead,
  text,
  forceTemplateName = "",
  rewriteWithAi = true,
  rewritePurpose = "wf2_outbound_text",
  rewriteMustInclude = [],
}) {
  if (!env.allowOutboundMessages) {
    return {
      suppressed: true,
      reason: "outbound_disabled",
    };
  }

  const normalizedProvider = normalizeProvider(provider || agent.defaultProvider) || agent.defaultProvider;
  let safeText = textOrEmpty(text);
  const destination = lead.telefone;
  if (!destination || !safeText) {
    throw new Error("Lead sem telefone ou texto vazio para envio.");
  }

  if (rewriteWithAi) {
    safeText = await rewriteWf2TextWithAi({
      text: safeText,
      workflow: resolveWorkflow(agent?.workflow || "smg"),
      lead,
      purpose: rewritePurpose,
      maxChars: AI_TEXT_MAX_CHARS,
      mustInclude: Array.isArray(rewriteMustInclude) ? rewriteMustInclude : [],
    });
  }

  const { config: providerConfig } = getAgentProviderConfig(agent, normalizedProvider);
  if (normalizedProvider === "meta") {
    const templateName = textOrEmpty(forceTemplateName);
    const insideWindow = isInside24hWindow(lead);

    if (!insideWindow && templateName) {
      throw new Error(
        "Janela de 24h fechada para envio de texto e template bloqueado em modo OpenAI-only."
      );
    }

    try {
      return await sendMetaTextMessage(providerConfig, { to: destination, text: safeText });
    } catch (error) {
      throw error;
    }
  }

  return sendUazapiTextMessage(providerConfig, { to: destination, text: safeText });
}

async function sendLeadDocument({
  agent,
  provider,
  lead,
  documentUrl,
  caption,
  filename,
}) {
  if (!env.allowOutboundMessages) {
    return {
      suppressed: true,
      reason: "outbound_disabled",
    };
  }

  const normalizedProvider = normalizeProvider(provider || agent.defaultProvider) || agent.defaultProvider;
  const { config: providerConfig } = getAgentProviderConfig(agent, normalizedProvider);

  if (normalizedProvider === "meta") {
    return sendMetaDocumentMessage(providerConfig, {
      to: lead.telefone,
      documentUrl,
      caption,
      filename,
    });
  }

  return sendUazapiDocumentMessage(providerConfig, {
    to: lead.telefone,
    documentUrl,
    caption,
    filename,
  });
}

function isLocalhostUrl(url) {
  const value = textOrEmpty(url);
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch (_error) {
    return false;
  }
}

async function resolvePublicBaseUrlForPdf(preferredBaseUrl = "") {
  const candidates = [
    textOrEmpty(preferredBaseUrl),
    textOrEmpty(env.publicWebhookBaseUrl),
    textOrEmpty(DEFAULT_PUBLIC_PDF_BASE_URL),
  ]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  if (!candidates.length) {
    throw new Error(
      "PUBLIC_WEBHOOK_BASE_URL nao configurado. Defina uma URL HTTPS publica para o envio do PDF no WhatsApp."
    );
  }

  const errors = [];
  for (const candidate of candidates) {
    if (isLocalhostUrl(candidate)) {
      errors.push(`${candidate} (localhost nao permitido)`);
      continue;
    }
    try {
      const parsed = new URL(candidate);
      await dnsPromises.lookup(parsed.hostname);
      return candidate;
    } catch (error) {
      errors.push(`${candidate} (${error?.code || error?.message || "dns_lookup_failed"})`);
    }
  }

  throw new Error(
    `Nenhuma base URL publica valida para PDF. Tentativas: ${errors.join(" | ")}`
  );
}

async function resolveTemplateText(prisma, workflow, segmento, etapa, fallback) {
  const stage = textOrEmpty(etapa).toLowerCase();
  const segment = textOrEmpty(segmento).toLowerCase() || "outro";

  const exact = await prisma.configTemplate.findFirst({
    where: {
      workflow,
      etapa: stage,
      segmento: segment,
      isActive: true,
    },
  });
  if (exact?.templateText) return exact.templateText;

  const generic = await prisma.configTemplate.findFirst({
    where: {
      workflow,
      etapa: stage,
      segmento: "default",
      isActive: true,
    },
  });
  if (generic?.templateText) return generic.templateText;

  return fallback;
}

function applyTemplateVariables(template, lead, extra = {}) {
  const mapping = {
    nome: lead?.nome || "Cliente",
    empresa: lead?.empresa || "sua empresa",
    segmento: lead?.segmento || "negocio",
    ...extra,
  };

  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key) => {
    return String(mapping[key] || "").trim();
  });
}

function buildAnalysisPrompt(form, lead) {
  const rawData = form?.rawData && typeof form.rawData === "object" ? form.rawData : {};
  const cargoEmpresa =
    textOrEmpty(rawData.cargo_empresa) ||
    textOrEmpty(rawData.cargoEmpresa) ||
    textOrEmpty(rawData.cargo) ||
    "-";

  return [
    "Voce e especialista senior em arquitetura operacional e inteligencia de negocios da SMG.",
    "Sua tarefa e gerar uma Analise de Maturidade Operacional personalizada, consultiva e executiva.",
    "Este documento e um pre-diagnostico: nao vende, nao promete, nao cita preco, nao cita escopo de implementacao.",
    "Objetivo da leitura: reconhecimento -> urgencia -> desejo de aprofundar no diagnostico.",
    "",
    "DADOS DO LEAD:",
    `- Nome do responsavel: ${lead?.nome || "-"}`,
    `- Cargo: ${cargoEmpresa}`,
    `- Nome da empresa: ${lead?.empresa || "-"}`,
    `- Segmento e atuacao: ${form?.segmento || lead?.segmento || "-"}`,
    `- Faturamento mensal: ${form?.faturamentoMensal || "-"}`,
    `- Numero de funcionarios: ${form?.numFuncionarios ?? "-"}`,
    `- Ferramentas usadas: ${form?.ferramentas || "-"}`,
    `- Tentativa anterior: ${form?.tentativaAnterior || "-"}`,
    `- Descricao da operacao atual: ${form?.descricaoOperacao || "-"}`,
    `- O que mudaria na operacao: ${form?.mudancaOperacao || "-"}`,
    `- Urgencia declarada: ${form?.urgencia || "-"}`,
    `- Maior desafio atual: ${form?.maiorDesafio || "-"}`,
    `- Motivacao para buscar a SMG: ${form?.motivacao || "-"}`,
    `- Expectativa de resultado: ${form?.expectativa || "-"}`,
    "",
    "FRAMEWORK SIG (Sistema, Inteligencia, Gestao):",
    "- Sistema: processos, integracao entre ferramentas, dependencia humana, previsibilidade operacional.",
    "- Inteligencia: uso de dados, visibilidade de indicadores, automacao de rotinas, rastreabilidade.",
    "- Gestao: controle, previsibilidade de resultado, capacidade de escalar sem caos operacional.",
    "",
    "ESCALA DE MATURIDADE POR PILAR (1 a 5):",
    "1 = Reativo | 2 = Iniciante | 3 = Organizado | 4 = Avancado | 5 = Estruturado.",
    "Regra obrigatoria: o score nunca pode contradizer a leitura operacional do mesmo pilar.",
    "Se a leitura mostra improviso, perda de controle ou dependencia critica, o score deve ser 1 ou 2.",
    "Porte ajuda a calibrar, mas nao pode maquiar sintomas concretos.",
    "",
    "REGRAS DE TOM E CONTEUDO:",
    "- Tom consultivo, estrategico, humano, objetivo e preciso.",
    "- Linguagem acessivel ao perfil do lead e ao segmento informado.",
    "- Use fortemente os campos livres (descricao_operacao, mudanca_operacao, maior_desafio, motivacao, expectativa).",
    "- Se faltar dado, diga que o ponto sera aprofundado no diagnostico. Nunca invente.",
    "- Proibido: cliches de marketing, jargao tecnico desnecessario, promessas numericas, pitch de vendas.",
    "",
    "ESTRUTURA OBRIGATORIA DE SAIDA (texto puro, sem markdown):",
    "CAPA",
    "SECAO 1 - VISAO GERAL EXECUTIVA",
    "SECAO 2 - SCORE DE MATURIDADE SIG",
    "SECAO 3 - LEITURA OPERACIONAL",
    "SECAO 4 - PRINCIPAIS GARGALOS IDENTIFICADOS",
    "SECAO 5 - IMPACTOS OPERACIONAIS",
    "SECAO 6 - OPORTUNIDADES DE EVOLUCAO",
    "SECAO 7 - CONCLUSAO E TRANSICAO PARA O DIAGNOSTICO",
    "RODAPE",
    "",
    "Detalhamento obrigatorio por secao:",
    "- SECAO 1: 5 a 7 linhas em prosa executiva, sem bullets.",
    "- SECAO 2: listar Sistema, Inteligencia e Gestao com score [X] / 5 e 1 frase por pilar; incluir maturidade geral (media) e 1 paragrafo curto interpretativo.",
    "- SECAO 3: para cada pilar, 2 paragrafos: (a) avaliacao especifica (b) implicacao pratica.",
    "- SECAO 4: top 3 gargalos por criticidade, com nome direto, manifestacao concreta e impacto provavel.",
    "- SECAO 5: 3 paragrafos de consequencias operacionais se nada mudar, sem dramatizacao exagerada.",
    "- SECAO 6: 3 paragrafos curtos no formato 'E se...', totalmente conectados ao caso do lead, sem explicar implementacao.",
    "- SECAO 7: 2 paragrafos: sintese final + posicionamento consultivo do diagnostico (sem CTA agressivo).",
    "- RODAPE: incluir confidencialidade para a empresa e nota de que o aprofundamento ocorre no diagnostico.",
    "",
    "Escreva em pt-BR, com acentuacao correta e alta personalizacao contextual.",
  ].join("\n");
}

function parseJsonObjectFromText(text) {
  const raw = textOrEmpty(text);
  if (!raw) return null;

  const withoutFence = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  const candidate =
    firstBrace >= 0 && lastBrace > firstBrace
      ? withoutFence.slice(firstBrace, lastBrace + 1)
      : withoutFence;

  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeDeliveryText(value, max = 320) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function formatDiagnosisSlot(date, hour, minute = 0, timezone = "America/Sao_Paulo") {
  const base = new Date(date.getTime());
  base.setHours(hour, minute, 0, 0);

  const weekdayLabel = new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    timeZone: timezone,
  })
    .format(base)
    .replace(".", "")
    .trim();

  const dayMonth = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
  }).format(base);

  return `${weekdayLabel} (${dayMonth}) às ${String(hour).padStart(2, "0")}h`;
}

function nextBusinessDay(fromDate, addBusinessDays = 1) {
  const current = new Date(fromDate.getTime());
  current.setHours(12, 0, 0, 0);

  let count = 0;
  while (count < addBusinessDays) {
    current.setDate(current.getDate() + 1);
    const weekday = current.getDay();
    if (weekday !== 0 && weekday !== 6) {
      count += 1;
    }
  }
  return current;
}

function buildDiagnosisSlotOptions(now = new Date()) {
  const firstDay = nextBusinessDay(now, 1);
  const secondDay = nextBusinessDay(now, 2);
  return {
    slot1: formatDiagnosisSlot(firstDay, 15, 0),
    slot2: formatDiagnosisSlot(secondDay, 10, 0),
  };
}

function followupContainsTwoSlots(followupText) {
  const raw = textOrEmpty(followupText);
  if (!raw) return false;
  const hasOu = /\bou\b/i.test(raw);
  const hourMatchesWithH =
    raw.match(/\b([01]?\d|2[0-3])(?::[0-5]\d)?\s*h\b/gi) || [];
  const hourMatchesCompact = raw.match(/\b([01]?\d|2[0-3])h[0-5]\d\b/gi) || [];
  const hourMatchesColon = raw.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/gi) || [];
  const totalSlots =
    hourMatchesWithH.length + hourMatchesCompact.length + hourMatchesColon.length;
  return hasOu && totalSlots >= 2;
}

function followupRequestsReadConfirmation(followupText) {
  const raw = textOrEmpty(followupText);
  if (!raw) return false;
  const hasPdfOrAnalysis = /\b(pdf|analise|an[aá]lise)\b/i.test(raw);
  const hasReadCheck =
    /\b(conseguiu|consegue|pode|poderia|recebeu|abriu|abrir|acessar|acessou)\b/i.test(raw) &&
    /\?/.test(raw);
  return hasPdfOrAnalysis && hasReadCheck;
}

function normalizeIntentText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isAnalysisReadConfirmedMessage(messageText = "") {
  const text = normalizeIntentText(messageText);
  if (!text) return false;
  if (/\b(nao|nao consegui|nao abriu|nao abriu|nao recebi|erro|falhou)\b/.test(text)) {
    return false;
  }
  if (/^(sim|yes|ok|blz|beleza|deu certo|consegui|abri|abriu|recebi)\b/.test(text)) {
    return true;
  }
  return /\b(consegui|abri|abriu|recebi|deu certo)\b/.test(text);
}

function introContainsQualificationQuestion(introText) {
  const raw = textOrEmpty(introText).toLowerCase();
  if (!raw) return false;
  return (
    /\b(qual|quais|poderia|pode|me conta|me dizer)\b/.test(raw) &&
    /\b(desafio|gargalo|dor|problema|situacao|situação)\b/.test(raw)
  );
}

function introLooksGenericFormConfirmation(introText) {
  const raw = textOrEmpty(introText).toLowerCase();
  if (!raw) return false;
  return (
    /recebi\s+a?\s*confirmacao/.test(raw) ||
    /vi que voce preencheu o formulario/.test(raw) ||
    /preencheu o formulario\.?\s*agora/.test(raw)
  );
}

async function generateAnalysisDeliveryMessages({ workflow, lead, form }) {
  const contextSegment = textOrEmpty(form?.segmento || lead?.segmento || "outro");
  const contextChallenge = textOrEmpty(form?.maiorDesafio || "");
  const contextUrgency = textOrEmpty(form?.urgencia || "");
  const firstName = toShortFirstName(lead?.nome || "");
  const companyName = textOrEmpty(lead?.empresa || "sua empresa");

  const systemPrompt = [
    "Voce escreve mensagens curtas para WhatsApp comercial em pt-BR.",
    "Tom consultivo, natural e humano.",
    "Nunca use markdown, lista, aspas extras ou emoji.",
    "Sempre use acentuacao correta em portugues.",
    "Retorne SOMENTE JSON valido.",
  ].join("\n");

  const baseUserPrompt = [
    "Gere tres mensagens para envio da Analise de Maturidade da SMG.",
    'Formato exato de saida: {"ackText":"...","introText":"...","followupText":"..."}',
    "Regras:",
    `- ackText: confirmar que recebeu as respostas de ${firstName} e avisar que esta preparando a analise da ${companyName}.`,
    "- ackText: maximo 220 caracteres, sem agendamento e sem pergunta.",
    "- introText: apresentar-se como Clara da SMG e avisar que vai enviar o PDF agora.",
    "- introText: incluir 1 detalhe concreto do formulario (segmento, desafio ou urgencia), sem inventar.",
    "- introText: nao fazer pergunta de qualificacao e nao pedir novamente o desafio do lead.",
    '- introText: evite texto generico como "recebi a confirmacao que voce preencheu o formulario".',
    "- followupText: apos o envio, confirmar o envio do PDF e pedir confirmacao de leitura.",
    "- followupText: fazer apenas 1 pergunta objetiva de leitura do material (ex: conseguiu abrir?).",
    "- followupText: nao sugerir horario de diagnostico antes da resposta do lead sobre a analise.",
    "- followupText: nao convidar para agendamento nesta mensagem.",
    "- Evite placeholders como [horario], [data] ou <...>.",
    "- Cada campo com no maximo 320 caracteres.",
    "- Nao repetir frases identicas de templates fixos.",
    "- Linguagem clara e objetiva.",
    "",
    `Contexto do lead: nome=${lead?.nome || "-"}, empresa=${lead?.empresa || "-"}, segmento=${contextSegment}.`,
    `Maior desafio declarado=${contextChallenge || "-"}.`,
    `Urgencia=${contextUrgency || "-"}.`,
  ].join("\n");

  const aiResult = await generateAiReply({
    systemPrompt,
    userPrompt: baseUserPrompt,
    fallbackReply: "{}",
    strictNoFallback: true,
    useLangChain: false,
    allowEnvFallback: true,
    model: env.openaiModel || "gpt-4o-mini",
    apiKey: env.openaiApiKey || "",
  });

  let parsed = parseJsonObjectFromText(aiResult.text);
  let ackText = normalizeDeliveryText(parsed?.ackText);
  let introText = normalizeDeliveryText(parsed?.introText);
  let followupText = normalizeDeliveryText(parsed?.followupText);
  let followupAsksReadConfirmation = followupRequestsReadConfirmation(followupText);
  let introHasQualificationQuestion = introContainsQualificationQuestion(introText);
  let introGenericFormConfirmation = introLooksGenericFormConfirmation(introText);
  let ackValid = Boolean(ackText) && ackText.length <= 220 && !/\?/.test(ackText);
  let repairResult = null;

  if (
    !ackValid ||
    !introText ||
    !followupAsksReadConfirmation ||
    introHasQualificationQuestion ||
    introGenericFormConfirmation
  ) {
    repairResult = await generateAiReply({
      systemPrompt,
      userPrompt: [
        "Corrija o JSON abaixo para cumprir todas as regras.",
        'Formato exato de saida: {"ackText":"...","introText":"...","followupText":"..."}',
        `JSON atual: ${JSON.stringify({
          ackText: ackText || "",
          introText: introText || "",
          followupText: followupText || "",
        })}`,
        "Problemas detectados:",
        `- ackText valido (sem pergunta e <=220 chars): ${ackValid ? "sim" : "nao"}`,
        `- introText valido: ${introText ? "sim" : "nao"}`,
        `- introText sem pergunta de qualificacao: ${
          introHasQualificationQuestion ? "nao" : "sim"
        }`,
        `- introText sem confirmacao generica de formulario: ${
          introGenericFormConfirmation ? "nao" : "sim"
        }`,
        `- followupText pedindo confirmacao de leitura da analise: ${
          followupAsksReadConfirmation ? "sim" : "nao"
        }`,
        "Mantenha o tom natural, use acentuacao correta e sem markdown.",
      ].join("\n"),
      fallbackReply: "{}",
      strictNoFallback: true,
      useLangChain: false,
      allowEnvFallback: true,
      model: env.openaiModel || "gpt-4o-mini",
      apiKey: env.openaiApiKey || "",
    });

    parsed = parseJsonObjectFromText(repairResult.text);
    ackText = normalizeDeliveryText(parsed?.ackText);
    introText = normalizeDeliveryText(parsed?.introText);
    followupText = normalizeDeliveryText(parsed?.followupText);
    followupAsksReadConfirmation = followupRequestsReadConfirmation(followupText);
    introHasQualificationQuestion = introContainsQualificationQuestion(introText);
    introGenericFormConfirmation = introLooksGenericFormConfirmation(introText);
    ackValid = Boolean(ackText) && ackText.length <= 220 && !/\?/.test(ackText);
  }

  const introValid = Boolean(introText) && !introHasQualificationQuestion && !introGenericFormConfirmation;
  const followupValid = Boolean(followupText) && followupAsksReadConfirmation;

  if (!ackValid || !introValid || !followupValid) {
    throw new Error(
      "Falha ao validar copy de entrega da analise gerada pela OpenAI em modo estrito."
    );
  }

  logWf2("info", "analysis.delivery_copy.validation", {
    explanation:
      "Validacao final do copy de entrega da analise com prioridade para texto gerado pela IA.",
    workflow,
    leadId: lead?.id || null,
    ackValid: Boolean(ackValid),
    hadRepairPass: Boolean(repairResult),
    introGenerated: introValid,
    introHasQualificationQuestion,
    introGenericFormConfirmation,
    followupAsksReadConfirmation: Boolean(followupAsksReadConfirmation),
    usedHardFallback: false,
  });

  return {
    ackText,
    introText,
    followupText,
    usedFallback: Boolean(aiResult?.usedFallback) || Boolean(repairResult?.usedFallback),
    model: repairResult?.model || aiResult?.model || null,
    hadRepairPass: Boolean(repairResult),
    usedHardFallback: false,
  };
}

async function processAnalysisForLead({
  workflow,
  agent,
  provider,
  prisma,
  tables,
  lead,
  config = null,
  publicBaseUrlOverride = "",
}) {
  if (!env.allowOutboundMessages) {
    logWf2("warn", "analysis.skip.outbound_disabled", {
      explanation: "Tentativa de gerar/enviar analise bloqueada: outbound desativado.",
      workflow,
      leadId: lead?.id || null,
      leadStatus: String(lead?.status || "").toUpperCase() || null,
    });
    return { processed: false, reason: "outbound_disabled" };
  }

  if (!lead?.id) {
    return { processed: false, reason: "lead_not_found" };
  }

  const lockKey = `${workflow}:${lead.id}`;
  if (analysisInFlightLocks.has(lockKey)) {
    logWf2("warn", "analysis.skip.in_flight", {
      explanation:
        "Tentativa ignorada para evitar envio duplicado da analise enquanto outra execucao ainda esta em andamento.",
      workflow,
      leadId: lead.id,
    });
    return { processed: false, reason: "analysis_in_flight" };
  }

  analysisInFlightLocks.add(lockKey);
  try {
    const currentLead = await tables.lead.findUnique({
      where: { id: lead.id },
    });
    if (!currentLead) {
      return { processed: false, reason: "lead_not_found" };
    }

    const currentStatus = String(currentLead.status || "").toUpperCase();
    if (!currentLead.automationActive) {
      logWf2("warn", "analysis.skip.automation_inactive", {
        explanation: "Tentativa de gerar/enviar analise ignorada: automacao inativa.",
        workflow,
        leadId: currentLead.id,
        leadStatus: currentStatus || null,
      });
      return { processed: false, reason: "automation_inactive" };
    }
    if (currentStatus === "ANALISE_ENVIADA") {
      logWf2("warn", "analysis.skip.already_sent_status", {
        explanation:
          "Tentativa ignorada porque o lead ja esta em ANALISE_ENVIADA (protege contra duplicidade).",
        workflow,
        leadId: currentLead.id,
      });
      return { processed: false, reason: "analysis_already_sent" };
    }
    if (currentStatus !== "FORMULARIO_RESPONDIDO") {
      logWf2("warn", "analysis.skip.status_not_ready", {
        explanation:
          "Tentativa de gerar/enviar analise ignorada: status diferente de FORMULARIO_RESPONDIDO.",
        workflow,
        leadId: currentLead.id,
        leadStatus: currentStatus || null,
      });
      return { processed: false, reason: "status_not_ready" };
    }

    const formId = textOrEmpty(currentLead.diagnosticoFormularioId);
    if (!formId) {
      await appendTimeline(prisma, {
        workflow,
        leadId: currentLead.id,
        tipo: "erro_analise",
        etapa: "etapa6",
        direcao: "system",
        mensagem: "Lead sem diagnostico_formulario_id para gerar analise.",
        metadata: {},
      });
      logWf2("warn", "analysis.skip.missing_form_id", {
        explanation:
          "Tentativa de gerar/enviar analise ignorada: lead sem diagnosticoFormularioId.",
        workflow,
        leadId: currentLead.id,
        leadStatus: currentStatus || null,
      });
      return { processed: false, reason: "missing_form_id" };
    }

    const form = await prisma.leadDiagnostico.findUnique({
      where: { id: formId },
    });
    if (!form) {
      await appendTimeline(prisma, {
        workflow,
        leadId: currentLead.id,
        tipo: "erro_analise",
        etapa: "etapa6",
        direcao: "system",
        mensagem: "Formulario de diagnostico nao encontrado.",
        metadata: { formId },
      });
      logWf2("warn", "analysis.skip.form_not_found", {
        explanation:
          "Tentativa de gerar/enviar analise ignorada: formulario vinculado nao encontrado.",
        workflow,
        leadId: currentLead.id,
        formId,
      });
      return { processed: false, reason: "form_not_found" };
    }

    const existingAnalysis = await prisma.analiseMaturidade.findFirst({
      where: {
        workflow,
        leadId: currentLead.id,
        formularioId: form.id,
      },
      orderBy: { createdAt: "desc" },
    });
    if (existingAnalysis) {
      logWf2("warn", "analysis.skip.already_sent_record", {
        explanation:
          "Tentativa ignorada porque ja existe analise registrada para este lead/formulario (protege contra duplicidade).",
        workflow,
        leadId: currentLead.id,
        formId: form.id,
        analysisUrl: existingAnalysis.arquivoUrl || null,
      });
      return {
        processed: false,
        reason: "analysis_already_sent",
        analysisUrl: existingAnalysis.arquivoUrl || null,
      };
    }

    const companyName = textOrEmpty(currentLead?.empresa || "sua empresa");
    const deliveryMessages = await generateAnalysisDeliveryMessages({
      workflow,
      lead: currentLead,
      form,
    });
    const ackText = textOrEmpty(deliveryMessages?.ackText);
    const introText = textOrEmpty(deliveryMessages?.introText);
    const followupText = textOrEmpty(deliveryMessages?.followupText);

    if (ANALYSIS_INITIAL_REPLY_DELAY_MS > 0) {
      await waitMs(ANALYSIS_INITIAL_REPLY_DELAY_MS);
    }
    await sendLeadText({
      agent,
      provider,
      lead: currentLead,
      text: ackText,
      rewriteWithAi: false,
    });
    await waitAnalysisSequenceDelay();

    const userPrompt = buildAnalysisPrompt(form, currentLead);
    const aiResult = await generateAiReply({
      systemPrompt: [
        "Voce cria analises de maturidade operacional profundas e praticas para PMEs no Brasil.",
      ].join("\n"),
      userPrompt,
      fallbackReply:
        "Analise preliminar: existem oportunidades de melhoria em processos, uso de dados e governanca operacional. Recomendamos diagnostico aprofundado para plano de implementacao.",
      strictNoFallback: true,
      useLangChain: false,
      allowEnvFallback: true,
      model: env.openaiModel || "gpt-4o-mini",
      apiKey: env.openaiApiKey || "",
    });

    const analysisText = textOrEmpty(aiResult.text);
    const savedOverride =
      textOrEmpty(lead?.dadosBrutos?.wf2?.publicBaseUrlOverride) ||
      textOrEmpty(currentLead?.dadosBrutos?.wf2?.publicBaseUrlOverride);
    const publicBaseUrl = await resolvePublicBaseUrlForPdf(
      textOrEmpty(publicBaseUrlOverride) || savedOverride
    );
    logWf2("info", "analysis.pdf.generate.start", {
      explanation: "Inicio da geracao do PDF da analise de maturidade.",
      workflow,
      leadId: currentLead.id,
      formId: form.id,
      publicBaseUrl,
      companyName,
      analysisTextChars: analysisText.length,
    });
    const file = await generateAnalysisPdf({
      projectRoot: process.cwd(),
      publicBaseUrl,
      workflow,
      lead: currentLead,
      analysisText,
    });
    if (!file.publicUrl) {
      throw new Error(
        "Nao foi possivel montar URL publica do PDF. Revise PUBLIC_WEBHOOK_BASE_URL."
      );
    }
    let fileSizeBytes = null;
    try {
      fileSizeBytes = fs.statSync(file.absolutePath).size;
    } catch (_error) {
      fileSizeBytes = null;
    }
    logWf2("info", "analysis.pdf.generate.success", {
      explanation: "PDF da analise gerado com sucesso.",
      workflow,
      leadId: currentLead.id,
      formId: form.id,
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      publicUrl: file.publicUrl,
      filename: file.filename,
      fileSizeBytes,
    });

    await sendLeadText({
      agent,
      provider,
      lead: currentLead,
      text: introText,
      rewriteWithAi: false,
    });
    await waitAnalysisSequenceDelay();

    try {
      logWf2("info", "analysis.pdf.send.request", {
        explanation: "Tentativa de envio do PDF da analise para o provider.",
        workflow,
        leadId: currentLead.id,
        provider: normalizeProvider(provider || agent?.defaultProvider) || provider || null,
        phone: currentLead.telefone || null,
        documentUrl: file.publicUrl,
        filename: file.filename,
      });
      const sendDocumentResult = await sendLeadDocument({
        agent,
        provider,
        lead: currentLead,
        documentUrl: file.publicUrl,
        caption: `Analise de Maturidade da ${companyName}`,
        filename: file.filename,
      });
      logWf2("info", "analysis.pdf.send.success", {
        explanation: "Provider confirmou envio do PDF da analise.",
        workflow,
        leadId: currentLead.id,
        provider: normalizeProvider(provider || agent?.defaultProvider) || provider || null,
        resultStatus: sendDocumentResult?.status || null,
        providerPayload: sendDocumentResult?.data || null,
      });
    } catch (error) {
      logWf2("error", "analysis.send_document_failed", {
        explanation:
          "Falha ao enviar PDF da analise para o provider. Verifique URL publica do arquivo e resposta do provider.",
        workflow,
        leadId: currentLead.id,
        provider: normalizeProvider(provider || agent?.defaultProvider) || provider || null,
        documentUrl: file.publicUrl,
        filename: file.filename,
        message: error?.message || "unknown",
        providerDetails: error?.details || null,
      });
      throw error;
    }
    await waitAnalysisSequenceDelay();

    await sendLeadText({
      agent,
      provider,
      lead: currentLead,
      text: followupText,
      rewriteWithAi: false,
    });

    const now = new Date();
    const effectiveConfig = config || (await ensureWorkflowConfigRows(prisma, workflow));
    await prisma.analiseMaturidade.create({
      data: {
        workflow,
        leadId: currentLead.id,
        formularioId: form.id,
        arquivoPath: file.relativePath,
        arquivoUrl: file.publicUrl,
        resumo: clipText(analysisText, 600),
      },
    });

    const updated = await tables.lead.update({
      where: { id: currentLead.id },
      data: {
        status: "ANALISE_ENVIADA",
        ultimoEnvioIa: now,
        followupNivel: 0,
        proximoFollowupEm: nextFollowupDate(effectiveConfig, 0, now),
        dadosBrutos: mergeDadosBrutos(currentLead.dadosBrutos, {
          wf2: {
            analysisSentAt: now.toISOString(),
            analysisFileUrl: file.publicUrl,
            analysisAwaitingReadConfirmation: true,
            analysisReadConfirmedAt: null,
            analysisDeliveryStep: "awaiting_read_confirmation",
            analysisPostReadInteractionCount: 0,
            analysisDeliveryCycleId: `${now.getTime()}-${currentLead.id.slice(0, 8)}`,
          },
        }),
      },
    });

    await appendTimeline(prisma, {
      workflow,
      leadId: currentLead.id,
      tipo: "analise_enviada",
      etapa: "etapa6",
      direcao: "outbound",
      mensagem: "Analise de maturidade enviada em PDF.",
      metadata: {
        arquivoUrl: file.publicUrl,
        model: aiResult.model || null,
        usedFallback: Boolean(aiResult.usedFallback) || Boolean(deliveryMessages?.usedFallback),
      },
    });

    logWf2("info", "analysis.sent.success", {
      explanation: "Analise de maturidade enviada e lead avancado para ANALISE_ENVIADA.",
      workflow,
      leadId: currentLead.id,
      formId: form.id,
      analysisUrl: file.publicUrl,
      aiModel: aiResult.model || null,
      usedFallback: Boolean(aiResult.usedFallback) || Boolean(deliveryMessages?.usedFallback),
    });

    return {
      processed: true,
      lead: updated,
      analysisUrl: file.publicUrl,
    };
  } finally {
    analysisInFlightLocks.delete(lockKey);
  }
}

async function triggerAnalysisForLeadAsync({
  workflow,
  agent,
  provider,
  prisma,
  tables,
  lead,
  config = null,
  source = "unknown",
  publicBaseUrlOverride = "",
}) {
  const leadId = textOrEmpty(lead?.id);
  if (!leadId) {
    return {
      queued: false,
      reason: "lead_not_found",
    };
  }

  const run = async () => {
    try {
      const result = await processAnalysisForLead({
        workflow,
        agent,
        provider,
        prisma,
        tables,
        lead,
        config,
        publicBaseUrlOverride,
      });
      logWf2("info", "analysis.async.finished", {
        explanation: "Processamento assíncrono de análise concluído.",
        workflow,
        leadId,
        source,
        processed: Boolean(result?.processed),
        reason: result?.reason || null,
      });
    } catch (error) {
      logWf2("error", "analysis.async.failed", {
        explanation: "Falha no processamento assíncrono da análise.",
        workflow,
        leadId,
        source,
        message: error?.message || "unknown",
      });
      await appendTimeline(prisma, {
        workflow,
        leadId,
        tipo: "erro_analise",
        etapa: "etapa6",
        direcao: "system",
        mensagem: error?.message || "Erro ao gerar/enviar analise.",
        metadata: {
          source,
          async: true,
        },
      }).catch(() => null);
    }
  };

  setTimeout(() => {
    run().catch(() => null);
  }, 0);

  return {
    queued: true,
    reason: "analysis_processing_queued",
  };
}

async function processNewOutboundLead({
  workflow,
  prisma,
  tables,
  config,
  lead,
  agent,
  providerOverride = null,
  ignoreSchedule = false,
}) {
  if (!env.allowOutboundMessages) {
    return { processed: false, reason: "outbound_disabled" };
  }

  if (!lead.automationActive) return { processed: false, reason: "automation_inactive" };
  if (isInboundLead(lead)) return { processed: false, reason: "inbound_lead" };
  if (String(lead.status || "").toUpperCase() !== "NOVO_LEAD") {
    return { processed: false, reason: "status_not_novo_lead" };
  }
  if (!ignoreSchedule && !isWithinAutomationSchedule(config)) {
    return { processed: false, reason: "outside_schedule" };
  }

  const wf2Data = lead?.dadosBrutos?.wf2 || {};
  if (wf2Data.etapa1SentAt) return { processed: false, reason: "already_sent" };

  const template = await resolveTemplateText(
    prisma,
    workflow,
    lead.segmento,
    "etapa1",
    "Oi {nome}, tudo bem? Sou da SMG e analisamos operacoes do segmento de {segmento} para identificar ganhos rapidos de eficiencia. Posso te fazer uma pergunta curta sobre sua rotina hoje?"
  );
  const message = applyTemplateVariables(template, lead, {
    form_link: resolveWf2FormLink(agent?.formLink),
  });

  await sendLeadText({
    agent,
    provider: providerOverride || agent.defaultProvider,
    lead,
    text: message,
    forceTemplateName: textOrEmpty(agent?.providers?.meta?.templates?.initialOutbound),
  });

  const now = new Date();
  await tables.lead.update({
    where: { id: lead.id },
    data: {
      ultimoEnvioIa: now,
      proximoFollowupEm: nextFollowupDate(config, 0, now),
      followupNivel: 0,
      dadosBrutos: mergeDadosBrutos(lead.dadosBrutos, {
        wf2: {
          etapa1SentAt: now.toISOString(),
          etapaAtual: "etapa1",
        },
      }),
    },
  });

  await appendTimeline(prisma, {
    workflow,
    leadId: lead.id,
    tipo: "mensagem_enviada",
    etapa: "etapa1",
    direcao: "outbound",
    mensagem: clipText(message, 500),
    metadata: {
      provider: normalizeProvider(providerOverride || agent.defaultProvider) || agent.defaultProvider,
    },
  });

  return {
    processed: true,
    reason: "outbound_started",
  };
}

async function processLeadFollowup({
  workflow,
  prisma,
  tables,
  config,
  lead,
  agent,
}) {
  if (!env.allowOutboundMessages) {
    return { processed: false, reason: "outbound_disabled" };
  }

  if (!lead.automationActive) return { processed: false, reason: "automation_inactive" };
  const status = String(lead.status || "").toUpperCase();
  if (FINAL_STATUSES.has(status)) return { processed: false, reason: "final_status" };
  if (!lead.proximoFollowupEm) return { processed: false, reason: "no_followup_due" };
  if (new Date(lead.proximoFollowupEm).getTime() > Date.now()) {
    return { processed: false, reason: "followup_not_due" };
  }
  if (!isWithinAutomationSchedule(config)) {
    return { processed: false, reason: "outside_schedule" };
  }

  if (lead.ultimaInteracao && lead.ultimoEnvioIa) {
    const inboundAt = new Date(lead.ultimaInteracao).getTime();
    const outboundAt = new Date(lead.ultimoEnvioIa).getTime();
    if (inboundAt > outboundAt) {
      await tables.lead.update({
        where: { id: lead.id },
        data: {
          followupNivel: 0,
          proximoFollowupEm: null,
        },
      });
      return { processed: false, reason: "lead_replied" };
    }
  }

  const level = Number(lead.followupNivel || 0);
  const stageKey = level <= 0 ? "fup1" : level === 1 ? "fup2" : level === 2 ? "fup3" : "fup_recorrente";
  const defaultTextByStage = {
    fup1:
      "Passando para te lembrar da nossa ultima mensagem. Se fizer sentido, te mostro em 2 minutos como avancar no diagnostico.",
    fup2:
      "Conseguiu ver minha mensagem anterior? Se quiser, seguimos com os proximos passos para sua analise personalizada.",
    fup3:
      "Tentativa final por aqui: se ainda fizer sentido para voce, te ajudo a avancar no diagnostico sem compromisso.",
    fup_recorrente:
      "Mantendo contato porque acredito que conseguimos te ajudar com ganhos operacionais concretos. Quer retomar daqui?",
  };

  const templateText = await resolveTemplateText(
    prisma,
    workflow,
    lead.segmento,
    stageKey,
    defaultTextByStage[stageKey]
  );
  const message = applyTemplateVariables(templateText, lead, {
    form_link: resolveWf2FormLink(agent?.formLink),
  });

  const templateByStage = {
    fup1: textOrEmpty(agent?.providers?.meta?.templates?.followup1),
    fup2: textOrEmpty(agent?.providers?.meta?.templates?.followup2),
    fup3: textOrEmpty(agent?.providers?.meta?.templates?.followup3),
    fup_recorrente: textOrEmpty(agent?.providers?.meta?.templates?.followupRecurring),
  };

  await sendLeadText({
    agent,
    provider: agent.defaultProvider,
    lead,
    text: message,
    forceTemplateName: templateByStage[stageKey],
  });

  const now = new Date();
  const nextDate = nextFollowupDate(config, level + 1, now);
  await tables.lead.update({
    where: { id: lead.id },
    data: {
      ultimoEnvioIa: now,
      followupNivel: level + 1,
      proximoFollowupEm: nextDate,
    },
  });

  await appendTimeline(prisma, {
    workflow,
    leadId: lead.id,
    tipo: "followup_enviado",
    etapa: stageKey,
    direcao: "outbound",
    mensagem: clipText(message, 500),
    metadata: {
      level: level + 1,
      nextFollowupAt: nextDate.toISOString(),
    },
  });

  return {
    processed: true,
    reason: stageKey,
  };
}

async function handleInboundToken({
  workflow,
  prisma,
  tables,
  lead,
  phoneNumber,
  token,
  agentSlug,
}) {
  const form = await prisma.leadDiagnostico.findUnique({
    where: { token },
  });
  if (!form) {
    return {
      tokenFound: false,
      processed: false,
    };
  }

  let targetLead = lead;
  if (!targetLead) {
    const fallbackName = textOrEmpty(form?.rawData?.nome || "Lead Inbound");
    const fallbackEmpresa = textOrEmpty(form?.rawData?.empresa || fallbackName || "Empresa");
    const fallbackSegment = asLeadSegment(form.segmento || form?.rawData?.segmento);
    targetLead = await tables.lead.create({
      data: {
        id: crypto.randomUUID(),
        nome: fallbackName || "Lead Inbound",
        telefone: normalizeE164(phoneNumber) || null,
        empresa: fallbackEmpresa || "Empresa",
        segmento: fallbackSegment,
        endereco: textOrEmpty(form?.rawData?.endereco || "Nao informado"),
        site: textOrEmpty(form?.rawData?.site) || null,
        email: textOrEmpty(form?.rawData?.email) || null,
        fonteOrigem: ScrapeSource.manual,
        agentSlug: textOrEmpty(agentSlug || "default-sdr"),
        status: "FORMULARIO_RESPONDIDO",
        pipelineOrigin: "diagnostico_site",
        canalAquisicao: "inbound_site",
        automationActive: true,
        formularioPreenchido: true,
        diagnosticoFormularioId: form.id,
        ultimaInteracao: new Date(),
        dadosBrutos: {
          wf2: {
            inboundToken: token,
          },
        },
      },
    });

    await appendTimeline(prisma, {
      workflow,
      leadId: targetLead.id,
      tipo: "lead_inbound_criado",
      etapa: "token",
      direcao: "system",
      mensagem: "Lead inbound criado a partir do token recebido no WhatsApp.",
      metadata: {
        token,
      },
    });
  } else {
    targetLead = await tables.lead.update({
      where: { id: targetLead.id },
      data: {
        diagnosticoFormularioId: form.id,
        formularioPreenchido: true,
        status: "FORMULARIO_RESPONDIDO",
        ultimaInteracao: new Date(),
        dadosBrutos: mergeDadosBrutos(targetLead.dadosBrutos, {
          wf2: {
            inboundToken: token,
            inboundTokenAt: new Date().toISOString(),
          },
        }),
      },
    });
  }

  return {
    tokenFound: true,
    processed: true,
    form,
    lead: targetLead,
  };
}

function normalizeInboundProfileName(profileName) {
  const normalized = textOrEmpty(profileName).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (/^[._-]+$/.test(normalized)) return "";
  return normalized;
}

function toShortFirstName(fullName = "") {
  const normalized = textOrEmpty(fullName).replace(/\s+/g, " ").trim();
  if (!normalized) return "tudo bem";
  const first = normalized.split(" ")[0] || "";
  if (!first) return "tudo bem";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function resolveWf2FormLink(value = "") {
  const raw = textOrEmpty(value).replace(/\/+$/, "");
  if (!raw || raw === LEGACY_WF2_FORM_LINK) return DEFAULT_WF2_FORM_LINK;
  return raw;
}

async function rewriteWf2TextWithAi({
  text,
  workflow,
  lead = null,
  purpose = "mensagem_operacional",
  maxChars = AI_TEXT_MAX_CHARS,
  mustInclude = [],
}) {
  const sourceText = textOrEmpty(text);
  if (!sourceText) {
    throw new Error("Texto base vazio para reescrita via OpenAI.");
  }

  const userPrompt = [
    "Reescreva a mensagem abaixo para WhatsApp comercial.",
    "Objetivo: manter a mesma intencao operacional do texto base.",
    "Regras:",
    "- pt-BR natural, humano, consultivo e curto.",
    "- sem markdown, sem listas, sem emoji.",
    `- no maximo ${Number(maxChars || AI_TEXT_MAX_CHARS)} caracteres.`,
    "- nao remover informacoes obrigatorias do texto base.",
    mustInclude.length
      ? `- obrigatorio incluir literalmente: ${mustInclude.map((item) => `"${item}"`).join(", ")}.`
      : "- nao inventar links, horarios, status ou dados.",
    `Contexto: workflow=${textOrEmpty(workflow) || "smg"}, finalidade=${textOrEmpty(purpose)}.`,
    `Lead: nome=${textOrEmpty(lead?.nome) || "-"}, empresa=${textOrEmpty(lead?.empresa) || "-"}, segmento=${
      textOrEmpty(lead?.segmento) || "-"
    }.`,
    "",
    `Texto base: ${sourceText}`,
    "",
    "Retorne apenas a mensagem final.",
  ].join("\n");

  const aiResult = await generateAiReply({
    systemPrompt: WF2_OPERATIONAL_SYSTEM_PROMPT,
    userPrompt,
    fallbackReply: "",
    strictNoFallback: true,
    useLangChain: false,
    allowEnvFallback: true,
    model: env.openaiModel || "gpt-4o-mini",
    apiKey: env.openaiApiKey || "",
  });

  const finalText = textOrEmpty(aiResult?.text);
  if (!finalText) {
    throw new Error("OpenAI retornou mensagem vazia na reescrita operacional.");
  }
  if (Number(maxChars || 0) > 0 && finalText.length > Number(maxChars)) {
    throw new Error("OpenAI retornou texto acima do limite na reescrita operacional.");
  }
  for (const required of mustInclude) {
    const chunk = textOrEmpty(required);
    if (chunk && !finalText.includes(chunk)) {
      throw new Error(`OpenAI removeu informacao obrigatoria na reescrita: ${chunk}`);
    }
  }
  return finalText;
}

async function buildInboundWelcomeMessages({ lead, agent, workflow }) {
  const firstName = toShortFirstName(lead?.nome || "");
  const formLink = resolveWf2FormLink(agent?.formLink);
  const fallbackMsg1 = INBOUND_WELCOME_TEMPLATE.replace("{nome}", firstName);
  const fallbackMsg2 = INBOUND_FORM_LINK_TEMPLATE.replace("{form_link}", formLink);

  const aiPrompt = [
    "Gere duas mensagens curtas de WhatsApp para primeiro contato inbound da Clara (SMG).",
    'Saida obrigatoria em JSON: {"msg1":"...","msg2":"..."}',
    "Regras:",
    "- msg1: boas-vindas com apresentacao da Clara e da SMG.",
    "- msg2: convite direto para preencher formulario com o link oficial.",
    `- msg2 deve conter literalmente este link: ${formLink}.`,
    "- sem agendamento, sem PDF, sem pergunta de qualificacao.",
    "- pt-BR natural, sem emoji e sem markdown.",
    "",
    `Nome do lead: ${firstName}.`,
    `Empresa: ${textOrEmpty(lead?.empresa) || "-"}.`,
    `Fallback msg1: ${fallbackMsg1}`,
    `Fallback msg2: ${fallbackMsg2}`,
  ].join("\n");

  const aiResult = await generateAiReply({
    systemPrompt: WF2_OPERATIONAL_SYSTEM_PROMPT,
    userPrompt: aiPrompt,
    fallbackReply: "{}",
    strictNoFallback: true,
    useLangChain: false,
    allowEnvFallback: true,
    model: env.openaiModel || "gpt-4o-mini",
    apiKey: env.openaiApiKey || "",
  });

  const parsed = parseJsonObjectFromText(aiResult?.text);
  const msg1 = textOrEmpty(parsed?.msg1);
  const msg2 = textOrEmpty(parsed?.msg2);
  if (!msg1 || !msg2) {
    throw new Error("OpenAI retornou JSON invalido para boas-vindas inbound.");
  }
  if (!msg2.includes(formLink)) {
    throw new Error("OpenAI nao incluiu o link oficial do formulario na msg2 inbound.");
  }

  if (msg1.length > 260) {
    throw new Error("OpenAI retornou msg1 de boas-vindas acima do limite de 260 caracteres.");
  }
  if (msg2.length > 360) {
    throw new Error("OpenAI retornou msg2 de boas-vindas acima do limite de 360 caracteres.");
  }

  return [msg1, msg2];
}

async function buildOptOutReplyMessage({ workflow, lead }) {
  const aiResult = await generateAiReply({
    systemPrompt: WF2_OPERATIONAL_SYSTEM_PROMPT,
    userPrompt: [
      "Escreva uma mensagem curta para confirmar opt-out do lead.",
      "Objetivo: confirmar que os contatos serao encerrados agora e que ele pode chamar no futuro se quiser retomar.",
      "Regras: 1 mensagem, ate 220 caracteres, sem emoji, sem markdown.",
      `Lead: nome=${textOrEmpty(lead?.nome) || "-"}, empresa=${textOrEmpty(lead?.empresa) || "-"}.`,
      "Retorne apenas a mensagem final.",
    ].join("\n"),
    fallbackReply: "",
    strictNoFallback: true,
    useLangChain: false,
    allowEnvFallback: true,
    model: env.openaiModel || "gpt-4o-mini",
    apiKey: env.openaiApiKey || "",
  });

  return rewriteWf2TextWithAi({
    text: aiResult?.text || "",
    workflow,
    lead,
    purpose: "opt_out_confirmation",
    maxChars: 220,
  });
}

function buildInboundCompanyName(phoneNumber) {
  const digits = String(phoneNumber || "").replace(/[^\d]/g, "");
  if (!digits) return `Lead Inbound ${crypto.randomUUID().slice(0, 8)}`;
  return `Lead Inbound ${digits.slice(-8)}`;
}

async function createInboundLeadFromMessage({
  workflow,
  prisma,
  tables,
  agentSlug,
  provider,
  phoneNumber,
  messageText,
  profileName,
}) {
  const normalizedPhone = normalizeE164(phoneNumber);
  if (!normalizedPhone) {
    return null;
  }

  const inboundName = normalizeInboundProfileName(profileName) || "Lead Inbound WhatsApp";
  const nowIso = new Date().toISOString();
  const payload = {
    id: crypto.randomUUID(),
    nome: inboundName,
    telefone: normalizedPhone,
    empresa: buildInboundCompanyName(normalizedPhone),
    segmento: asLeadSegment("outro"),
    endereco: "Nao informado",
    site: null,
    email: null,
    fonteOrigem: ScrapeSource.manual,
    agentSlug: textOrEmpty(agentSlug || "default-sdr"),
    status: "NOVO_LEAD",
    pipelineOrigin: "inbound_whatsapp",
    canalAquisicao: "inbound_whatsapp",
    automationActive: true,
    formularioPreenchido: false,
    ultimaInteracao: new Date(),
    dadosBrutos: mergeDadosBrutos(null, {
      wf2: {
        inboundLeadCreatedAt: nowIso,
        firstInboundText: clipText(messageText, 500),
        firstInboundProvider: normalizeProvider(provider) || provider || null,
        firstInboundProfileName: textOrEmpty(profileName),
      },
    }),
  };

  try {
    const lead = await tables.lead.create({
      data: payload,
    });

    await appendTimeline(prisma, {
      workflow,
      leadId: lead.id,
      tipo: "lead_inbound_criado",
      etapa: "inbound",
      direcao: "system",
      mensagem: "Lead criado automaticamente a partir de primeira mensagem inbound no WhatsApp.",
      metadata: {
        phoneNumber: normalizedPhone,
        provider: normalizeProvider(provider) || provider || null,
      },
    });

    return lead;
  } catch (error) {
    if (String(error?.code || "") === "P2002") {
      return findLeadByPhone(tables, normalizedPhone, agentSlug);
    }
    throw error;
  }
}

async function registerInboundMessageEvent({
  agentSlug,
  workflow: workflowInput,
  provider,
  phoneNumber,
  messageText,
  profileName,
}) {
  const workflow = resolveWorkflow(workflowInput);
  const prisma = getPrisma(workflow);
  const tables = getWorkflowTables(prisma, workflow);
  const token = extractInboundToken(messageText);
  logWf2("info", "inbound.message.received", {
    explanation:
      "Evento inbound registrado no WF2 antes de atualizar lead/timeline e regras de opt-out/token.",
    workflow,
    agentSlug: textOrEmpty(agentSlug),
    provider: normalizeProvider(provider) || provider || null,
    phoneNumber: normalizeE164(phoneNumber) || phoneNumber || null,
    messageText: clipText(messageText, 500),
    profileName: textOrEmpty(profileName),
    tokenDetected: Boolean(token),
  });
  let lead = await findLeadByPhone(tables, phoneNumber, agentSlug);

  if (token) {
    const tokenResult = await handleInboundToken({
      workflow,
      prisma,
      tables,
      lead,
      phoneNumber,
      token,
      agentSlug,
    });
    if (tokenResult.processed) {
      lead = tokenResult.lead;
    }
  }

  if (!lead) {
    logWf2("warn", "inbound.message.lead_not_found", {
      explanation:
        "Mensagem inbound recebida, mas nenhum lead foi encontrado para o telefone informado.",
      workflow,
      phoneNumber: normalizeE164(phoneNumber) || phoneNumber || null,
      agentSlug: textOrEmpty(agentSlug),
    });
    lead = await createInboundLeadFromMessage({
      workflow,
      prisma,
      tables,
      agentSlug,
      provider,
      phoneNumber,
      messageText,
      profileName,
    });

    if (!lead) {
      return {
        foundLead: false,
        suppressAi: false,
        reason: "lead_not_found",
      };
    }
    logWf2("info", "inbound.message.lead_created", {
      explanation:
        "Lead nao existia e foi criado automaticamente a partir da mensagem inbound.",
      workflow,
      leadId: lead.id,
      phoneNumber: lead.telefone,
      agentSlug: lead.agentSlug,
      pipelineOrigin: lead.pipelineOrigin,
    });
  }

  const updatedLead = await tables.lead.update({
    where: { id: lead.id },
    data: {
      ultimaInteracao: new Date(),
      dadosBrutos: mergeDadosBrutos(lead.dadosBrutos, {
        wf2: {
          lastInboundText: clipText(messageText, 500),
          lastInboundAt: new Date().toISOString(),
          profileName: textOrEmpty(profileName),
        },
      }),
    },
  });

  await appendTimeline(prisma, {
    workflow,
    leadId: updatedLead.id,
    tipo: "mensagem_recebida",
    etapa: null,
    direcao: "inbound",
    mensagem: clipText(messageText, 500),
    metadata: {
      provider: normalizeProvider(provider) || provider || null,
      profileName: textOrEmpty(profileName),
    },
  });

  if (OPT_OUT_REGEX.test(String(messageText || ""))) {
    const optOutReply = await buildOptOutReplyMessage({
      workflow,
      lead: updatedLead,
    });
    await tables.lead.update({
      where: { id: updatedLead.id },
      data: {
        status: "DESQUALIFICADO",
        automationActive: false,
      },
    });
    await appendTimeline(prisma, {
      workflow,
      leadId: updatedLead.id,
      tipo: "opt_out",
      etapa: null,
      direcao: "system",
      mensagem: "Lead pediu interrupcao de contato.",
      metadata: {},
    });
    logWf2("info", "inbound.message.opt_out", {
      explanation:
        "Lead solicitou encerramento de contato. Automacao foi desativada e status definido como DESQUALIFICADO.",
      workflow,
      leadId: updatedLead.id,
      phoneNumber: updatedLead.telefone,
    });
    return {
      foundLead: true,
      suppressAi: true,
      reason: "opt_out",
      immediateReply: optOutReply,
      lead: updatedLead,
    };
  }

  let leadForNextStep = updatedLead;
  let normalizedStatus = String(leadForNextStep.status || "").toUpperCase();
  let linkedForm = null;
  const recentlyCleared =
    Boolean(leadForNextStep?.dadosBrutos?.wf2?.fullDataCleared) &&
    normalizedStatus === "NOVO_LEAD";

  const currentFormId = textOrEmpty(leadForNextStep.diagnosticoFormularioId);
  const isEmptyNovoLead =
    normalizedStatus === "NOVO_LEAD" &&
    !currentFormId &&
    !leadForNextStep.formularioPreenchido &&
    !token;
  if (currentFormId) {
    linkedForm = await prisma.leadDiagnostico.findUnique({
      where: { id: currentFormId },
    });
  }
  if (!linkedForm && !recentlyCleared && !isEmptyNovoLead) {
    linkedForm = await findLatestDiagnosticoByPhone(
      prisma,
      workflow,
      leadForNextStep.telefone || phoneNumber
    );
  }

  logWf2("info", "inbound.message.form_resolution", {
    explanation:
      "Resultado da resolucao de formulario para o inbound antes dos gates de status/analise.",
    workflow,
    leadId: leadForNextStep.id,
    leadPhone: leadForNextStep.telefone || null,
    currentFormId: currentFormId || null,
    resolvedFormId: linkedForm?.id || null,
    resolvedByPhoneMatch: Boolean(!currentFormId && linkedForm?.id),
    formularioPreenchido: Boolean(leadForNextStep.formularioPreenchido),
    status: normalizedStatus,
    pipelineOrigin: textOrEmpty(leadForNextStep.pipelineOrigin) || null,
  });

  if (linkedForm && linkedForm.id !== currentFormId) {
    const previousFormId = currentFormId || null;
    leadForNextStep = await tables.lead.update({
      where: { id: leadForNextStep.id },
      data: {
        diagnosticoFormularioId: linkedForm.id,
        formularioPreenchido: true,
      },
    });
    normalizedStatus = String(leadForNextStep.status || "").toUpperCase();

    await appendTimeline(prisma, {
      workflow,
      leadId: leadForNextStep.id,
      tipo: "formulario_vinculado_automaticamente",
      etapa: "etapa5",
      direcao: "system",
      mensagem:
        "Formulario vinculado automaticamente ao lead durante inbound via correspondencia de telefone.",
      metadata: {
        previousFormId,
        resolvedFormId: linkedForm.id,
        trigger: "inbound_phone_form_match",
      },
    });
  }

  const hasLinkedForm = Boolean(textOrEmpty(leadForNextStep.diagnosticoFormularioId));
  const shouldSendInboundWelcomeForm =
    !token &&
    !hasLinkedForm &&
    normalizedStatus === "NOVO_LEAD" &&
    !leadForNextStep.formularioPreenchido;

  logWf2("info", "inbound.message.welcome_form_gate", {
    explanation:
      "Gate hardcoded para primeiro contato sem formulario: se true, WF2 envia boas-vindas + link e suprime IA.",
    workflow,
    leadId: leadForNextStep.id,
    phoneNumber: leadForNextStep.telefone || phoneNumber || null,
    status: normalizedStatus,
    hasLinkedForm,
    formularioPreenchido: Boolean(leadForNextStep.formularioPreenchido),
    tokenDetected: Boolean(token),
    recentlyCleared,
    isEmptyNovoLead,
    pipelineOrigin: textOrEmpty(leadForNextStep.pipelineOrigin) || null,
    shouldSendInboundWelcomeForm,
  });

  if (shouldSendInboundWelcomeForm) {
    const agent = await resolveAgentForLead(leadForNextStep);
    const immediateReplies = await buildInboundWelcomeMessages({
      lead: leadForNextStep,
      agent,
      workflow,
    });
    const nowIso = new Date().toISOString();

    logWf2("info", "inbound.message.welcome_form_sending", {
      explanation:
        "WF2 vai enviar mensagens imediatas de boas-vindas e link do formulario, sem chamar IA generativa.",
      workflow,
      leadId: leadForNextStep.id,
      formLink: resolveWf2FormLink(agent?.formLink),
      immediateReplies,
    });

    leadForNextStep = await tables.lead.update({
      where: { id: leadForNextStep.id },
      data: {
        status: "FORMULARIO_ENVIADO",
        pipelineOrigin: "inbound_whatsapp",
        canalAquisicao: "inbound_whatsapp",
        formularioPreenchido: false,
        diagnosticoFormularioId: null,
        dadosBrutos: mergeDadosBrutos(leadForNextStep.dadosBrutos, {
          wf2: {
            inboundWelcomeFormSentAt: nowIso,
            formLinkSentAt: nowIso,
          },
        }),
      },
    });
    normalizedStatus = "FORMULARIO_ENVIADO";

    await appendTimeline(prisma, {
      workflow,
      leadId: leadForNextStep.id,
      tipo: "inbound_formulario_enviado",
      etapa: "etapa5",
      direcao: "outbound",
      mensagem: "Mensagem de boas-vindas inbound enviada com link do formulario.",
      metadata: {
        immediateRepliesCount: immediateReplies.length,
      },
    });

    return {
      foundLead: true,
      suppressAi: true,
      reason: "inbound_welcome_form_sent",
      immediateReplies,
      lead: leadForNextStep,
    };
  }

  const shouldAutoAdvanceFromInbound =
    hasLinkedForm &&
    isInboundLead(leadForNextStep) &&
    (normalizedStatus === "FORMULARIO_ENVIADO" || normalizedStatus === "NOVO_LEAD");

  logWf2("info", "inbound.message.auto_advance_gate", {
    explanation: "Resultado do gate de auto-avanco para FORMULARIO_RESPONDIDO.",
    workflow,
    leadId: leadForNextStep.id,
    hasLinkedForm,
    isInboundLead: isInboundLead(leadForNextStep),
    status: normalizedStatus,
    shouldAutoAdvanceFromInbound,
  });

  if (shouldAutoAdvanceFromInbound) {
    leadForNextStep = await tables.lead.update({
      where: { id: leadForNextStep.id },
      data: {
        status: "FORMULARIO_RESPONDIDO",
        formularioPreenchido: true,
      },
    });
    normalizedStatus = "FORMULARIO_RESPONDIDO";

    await appendTimeline(prisma, {
      workflow,
      leadId: leadForNextStep.id,
      tipo: "status_atualizado",
      etapa: "etapa5",
      direcao: "system",
      mensagem:
        "Lead inbound com formulario vinculado detectado. Status atualizado para FORMULARIO_RESPONDIDO.",
      metadata: {
        trigger: "inbound_message_with_linked_form",
        previousStatus: String(updatedLead.status || "").toUpperCase(),
        diagnosticoFormularioId: textOrEmpty(leadForNextStep.diagnosticoFormularioId) || null,
      },
    });
  }

  const waitingAnalysisReadConfirmation = Boolean(
    leadForNextStep?.dadosBrutos?.wf2?.analysisAwaitingReadConfirmation
  );
  const analysisReadConfirmedNow =
    normalizedStatus === "ANALISE_ENVIADA" &&
    waitingAnalysisReadConfirmation &&
    isAnalysisReadConfirmedMessage(messageText);

  if (analysisReadConfirmedNow) {
    const confirmedAt = new Date().toISOString();
    leadForNextStep = await tables.lead.update({
      where: { id: leadForNextStep.id },
      data: {
        dadosBrutos: mergeDadosBrutos(leadForNextStep.dadosBrutos, {
          wf2: {
            analysisAwaitingReadConfirmation: false,
            analysisReadConfirmedAt: confirmedAt,
            analysisDeliveryStep: "micro_approfundamento_pending",
            analysisPostReadInteractionCount: 0,
          },
        }),
      },
    });
    normalizedStatus = String(leadForNextStep.status || "").toUpperCase();

    await appendTimeline(prisma, {
      workflow,
      leadId: leadForNextStep.id,
      tipo: "analise_leitura_confirmada",
      etapa: "etapa7",
      direcao: "inbound",
      mensagem: "Lead confirmou que conseguiu abrir a Analise de Maturidade.",
      metadata: {
        inboundText: clipText(messageText, 240),
        confirmedAt,
      },
    });

    logWf2("info", "inbound.message.analysis_read_confirmed", {
      explanation:
        "Confirmacao de leitura da analise registrada no contexto WF2 para orientar o proximo passo da IA.",
      workflow,
      leadId: leadForNextStep.id,
      status: normalizedStatus,
      confirmedAt,
    });
  }

  const shouldTrackPostReadInbound =
    normalizedStatus === "ANALISE_ENVIADA" &&
    !analysisReadConfirmedNow &&
    Boolean(leadForNextStep?.dadosBrutos?.wf2?.analysisReadConfirmedAt) &&
    !Boolean(leadForNextStep?.dadosBrutos?.wf2?.analysisAwaitingReadConfirmation);

  if (shouldTrackPostReadInbound) {
    const currentCount = Number(leadForNextStep?.dadosBrutos?.wf2?.analysisPostReadInteractionCount || 0);
    const nextCount = currentCount + 1;
    const nextStep =
      nextCount >= WF2_PERMISSION_POST_READ_INTERACTIONS
        ? "micro_approfundamento_ready_for_scheduling"
        : "micro_approfundamento_pending";

    leadForNextStep = await tables.lead.update({
      where: { id: leadForNextStep.id },
      data: {
        dadosBrutos: mergeDadosBrutos(leadForNextStep.dadosBrutos, {
          wf2: {
            analysisPostReadInteractionCount: nextCount,
            analysisDeliveryStep: nextStep,
          },
        }),
      },
    });
    normalizedStatus = String(leadForNextStep.status || "").toUpperCase();

    logWf2("info", "inbound.message.analysis_post_read_progress", {
      explanation:
        "Contador de interacoes apos leitura da analise atualizado para controlar transicao ao agendamento.",
      workflow,
      leadId: leadForNextStep.id,
      postReadInteractionCount: nextCount,
      analysisDeliveryStep: nextStep,
    });
  }

  const shouldAttemptImmediateAnalysis =
    normalizedStatus === "FORMULARIO_RESPONDIDO" &&
    hasLinkedForm &&
    (Boolean(token) || isInboundLead(leadForNextStep));

  logWf2("info", "inbound.message.analysis_gate", {
    explanation: "Resultado do gate de tentativa imediata de envio da analise.",
    workflow,
    leadId: leadForNextStep.id,
    status: normalizedStatus,
    hasLinkedForm,
    tokenDetected: Boolean(token),
    isInboundLead: isInboundLead(leadForNextStep),
    shouldAttemptImmediateAnalysis,
  });

  if (shouldAttemptImmediateAnalysis) {
    if (!env.allowOutboundMessages) {
      logWf2("warn", "inbound.message.analysis_gate_blocked", {
        explanation: "Gate de analise passou, mas outbound esta desativado.",
        workflow,
        leadId: leadForNextStep.id,
        reason: "outbound_disabled",
      });
      return {
        foundLead: true,
        suppressAi: true,
        reason: "outbound_disabled",
        lead: leadForNextStep,
      };
    }

    const agent = await resolveAgentForLead(leadForNextStep);
    const analysisResult = await triggerAnalysisForLeadAsync({
      workflow,
      agent,
      provider,
      prisma,
      tables,
      lead: leadForNextStep,
      config: await ensureWorkflowConfigRows(prisma, workflow),
      source: token ? "inbound_token" : "inbound_form_match",
    });
    logWf2("info", "inbound.message.token_analysis", {
      explanation:
        "Mensagem inbound com formulario vinculado processada e envio da analise disparado em background.",
      workflow,
      leadId: leadForNextStep.id,
      token: token || null,
      analysisQueued: Boolean(analysisResult.queued),
      reason: analysisResult.reason || null,
    });

    return {
      foundLead: true,
      suppressAi: true,
      reason: token ? "analysis_queued_after_token" : "analysis_queued_after_form_match",
      lead: leadForNextStep,
    };
  }

  logWf2("warn", "inbound.message.analysis_gate_not_met", {
    explanation:
      "Inbound seguiu para IA porque o gate de analise imediata nao foi atendido.",
    workflow,
    leadId: leadForNextStep.id,
    status: normalizedStatus,
    hasLinkedForm,
    tokenDetected: Boolean(token),
    isInboundLead: isInboundLead(leadForNextStep),
  });

  return {
    foundLead: true,
    suppressAi: false,
    reason: "inbound_registered",
    lead: leadForNextStep,
  };
}

async function processWorkflowTick(workflowInput) {
  const workflow = resolveWorkflow(workflowInput);
  const prisma = getPrisma(workflow);
  const tables = getWorkflowTables(prisma, workflow);
  const config = await ensureWorkflowConfigRows(prisma, workflow);
  const agents = listAgents().filter((agent) => resolveWorkflow(agent.workflow) === workflow);

  const stats = {
    workflow,
    outboundStarted: 0,
    analysesSent: 0,
    followupsSent: 0,
  };

  if (!env.wf2EnableOutboundStart) {
    logWf2("info", "outbound.start.disabled", {
      explanation:
        "Disparo automatico de abordagem inicial (outbound.start) desativado por configuracao.",
      workflow,
    });
  }
  if (!env.allowOutboundMessages) {
    logWf2("info", "outbound.messaging.disabled", {
      explanation:
        "Envio outbound do WF2 desativado por configuracao global de somente recebimento.",
      workflow,
    });
  }

  for (const agent of agents) {
    if (env.wf2EnableOutboundStart) {
      const leadsForStart = await tables.lead.findMany({
        where: {
          agentSlug: agent.slug,
          automationActive: true,
          status: "NOVO_LEAD",
        },
        orderBy: { criadoEm: "asc" },
        take: 50,
      });

      for (const lead of leadsForStart) {
        try {
          const result = await processNewOutboundLead({
            workflow,
            prisma,
            tables,
            config,
            lead,
            agent,
          });
          if (result?.processed) {
            stats.outboundStarted += 1;
          }
        } catch (error) {
          logWf2("error", "outbound.start.failed", {
            workflow,
            agentSlug: agent.slug,
            leadId: lead.id,
            message: error?.message || "unknown",
          });
          await appendTimeline(prisma, {
            workflow,
            leadId: lead.id,
            tipo: "erro_envio",
            etapa: "etapa1",
            direcao: "system",
            mensagem: error?.message || "Erro ao enviar abordagem inicial.",
            metadata: {},
          }).catch(() => null);
        }
      }
    }

    if (env.allowOutboundMessages) {
      const leadsForAnalysis = await tables.lead.findMany({
        where: {
          agentSlug: agent.slug,
          automationActive: true,
          status: "FORMULARIO_RESPONDIDO",
        },
        orderBy: { criadoEm: "asc" },
        take: 30,
      });

      for (const lead of leadsForAnalysis) {
        try {
          const result = await processAnalysisForLead({
            workflow,
            agent,
            provider: agent.defaultProvider,
            prisma,
            tables,
            lead,
            config,
          });
          if (result.processed) {
            stats.analysesSent += 1;
          }
        } catch (error) {
          logWf2("error", "analysis.send.failed", {
            workflow,
            agentSlug: agent.slug,
            leadId: lead.id,
            message: error?.message || "unknown",
          });
          await appendTimeline(prisma, {
            workflow,
            leadId: lead.id,
            tipo: "erro_analise",
            etapa: "etapa6",
            direcao: "system",
            mensagem: error?.message || "Erro ao gerar/enviar analise.",
            metadata: {},
          }).catch(() => null);
        }
      }

      // Follow-ups desativados temporariamente (token Meta expirado)
      // const followupLeads = await tables.lead.findMany({
      //   where: {
      //     agentSlug: agent.slug,
      //     automationActive: true,
      //     proximoFollowupEm: {
      //       lte: new Date(),
      //     },
      //   },
      //   orderBy: { proximoFollowupEm: "asc" },
      //   take: 80,
      // });

      // for (const lead of followupLeads) {
      //   try {
      //     const result = await processLeadFollowup({
      //       workflow,
      //       prisma,
      //       tables,
      //       config,
      //       lead,
      //       agent,
      //     });
      //     if (result?.processed) {
      //       stats.followupsSent += 1;
      //     }
      //   } catch (error) {
      //     logWf2("error", "followup.failed", {
      //       workflow,
      //       agentSlug: agent.slug,
      //       leadId: lead.id,
      //       message: error?.message || "unknown",
      //     });
      //     await appendTimeline(prisma, {
      //       workflow,
      //       leadId: lead.id,
      //       tipo: "erro_envio",
      //       etapa: "followup",
      //       direcao: "system",
      //       mensagem: error?.message || "Erro ao enviar follow-up.",
      //       metadata: {},
      //     }).catch(() => null);
      //   }
      // }
    }
  }

  return stats;
}

async function processAllWorkflowTicks() {
  const workflows = listWorkflowConfigs().map((item) => item.id);
  const stats = [];
  for (const workflow of workflows) {
    const result = await processWorkflowTick(workflow);
    stats.push(result);
  }
  return stats;
}

async function createDiagnosticoFromPayload({
  workflow: workflowInput,
  token,
  phoneNumber,
  payload = {},
  leadPayload = {},
  publicBaseUrlOverride = "",
}) {
  const workflow = resolveWorkflow(workflowInput);
  const prisma = getPrisma(workflow);
  const tables = getWorkflowTables(prisma, workflow);

  const normalizedToken = textOrEmpty(token) || `SMG-${crypto.randomUUID().slice(0, 8)}`;
  const normalizedPhone = normalizeE164(phoneNumber);
  if (!normalizedPhone) {
    const error = new Error("Telefone invalido para cadastro inbound.");
    error.statusCode = 400;
    throw error;
  }

  const form = await prisma.leadDiagnostico.upsert({
    where: { token: normalizedToken },
    update: {
      workflow,
      telefone: normalizedPhone,
      segmento: textOrEmpty(payload.segmento) || null,
      faturamentoMensal: textOrEmpty(payload.faturamentoMensal) || null,
      numFuncionarios:
        payload.numFuncionarios === undefined || payload.numFuncionarios === null
          ? null
          : Number(payload.numFuncionarios),
      ferramentas: textOrEmpty(payload.ferramentas) || null,
      tentativaAnterior: textOrEmpty(payload.tentativaAnterior) || null,
      mudancaOperacao: textOrEmpty(payload.mudancaOperacao) || null,
      descricaoOperacao: textOrEmpty(payload.descricaoOperacao) || null,
      urgencia: textOrEmpty(payload.urgencia) || null,
      maiorDesafio: textOrEmpty(payload.maiorDesafio) || null,
      motivacao: textOrEmpty(payload.motivacao) || null,
      expectativa: textOrEmpty(payload.expectativa) || null,
      rawData: payload,
    },
    create: {
      workflow,
      token: normalizedToken,
      telefone: normalizedPhone,
      segmento: textOrEmpty(payload.segmento) || null,
      faturamentoMensal: textOrEmpty(payload.faturamentoMensal) || null,
      numFuncionarios:
        payload.numFuncionarios === undefined || payload.numFuncionarios === null
          ? null
          : Number(payload.numFuncionarios),
      ferramentas: textOrEmpty(payload.ferramentas) || null,
      tentativaAnterior: textOrEmpty(payload.tentativaAnterior) || null,
      mudancaOperacao: textOrEmpty(payload.mudancaOperacao) || null,
      descricaoOperacao: textOrEmpty(payload.descricaoOperacao) || null,
      urgencia: textOrEmpty(payload.urgencia) || null,
      maiorDesafio: textOrEmpty(payload.maiorDesafio) || null,
      motivacao: textOrEmpty(payload.motivacao) || null,
      expectativa: textOrEmpty(payload.expectativa) || null,
      rawData: payload,
    },
  });

  const existingLead = await findLeadByPhone(
    tables,
    normalizedPhone,
    textOrEmpty(leadPayload.agentSlug || "default-sdr")
  );
  let lead = existingLead;

  if (!lead) {
    lead = await tables.lead.create({
      data: {
        id: crypto.randomUUID(),
        nome: textOrEmpty(leadPayload.nome || payload.nome || "Lead Inbound"),
        telefone: normalizedPhone,
        empresa:
          textOrEmpty(leadPayload.empresa || payload.empresa || "Empresa Inbound") ||
          "Empresa Inbound",
        segmento: asLeadSegment(leadPayload.segmento || payload.segmento),
        endereco: textOrEmpty(leadPayload.endereco || payload.endereco || "Nao informado"),
        site: textOrEmpty(leadPayload.site || payload.site) || null,
        email: textOrEmpty(leadPayload.email || payload.email) || null,
        fonteOrigem: ScrapeSource.manual,
        agentSlug: textOrEmpty(leadPayload.agentSlug || "default-sdr"),
        status: "FORMULARIO_RESPONDIDO",
        pipelineOrigin: textOrEmpty(leadPayload.pipelineOrigin || "diagnostico_site"),
        canalAquisicao: textOrEmpty(leadPayload.canalAquisicao || "inbound_site"),
        automationActive: true,
        formularioPreenchido: true,
        diagnosticoFormularioId: form.id,
        dadosBrutos: mergeDadosBrutos(null, {
          wf2: {
            inboundToken: normalizedToken,
            formularioCriadoAt: new Date().toISOString(),
            publicBaseUrlOverride: textOrEmpty(publicBaseUrlOverride) || null,
          },
        }),
      },
    });
  } else {
    lead = await tables.lead.update({
      where: { id: lead.id },
      data: {
        status: "FORMULARIO_RESPONDIDO",
        pipelineOrigin: textOrEmpty(leadPayload.pipelineOrigin || "diagnostico_site"),
        canalAquisicao: textOrEmpty(leadPayload.canalAquisicao || "inbound_site"),
        formularioPreenchido: true,
        diagnosticoFormularioId: form.id,
        ultimaInteracao: new Date(),
        dadosBrutos: mergeDadosBrutos(lead.dadosBrutos, {
          wf2: {
            inboundToken: normalizedToken,
            formularioCriadoAt: new Date().toISOString(),
            publicBaseUrlOverride: textOrEmpty(publicBaseUrlOverride) || null,
          },
        }),
      },
    });
  }

  await appendTimeline(prisma, {
    workflow,
    leadId: lead.id,
    tipo: "formulario_respondido",
    etapa: "etapa5",
    direcao: "system",
    mensagem: "Formulario inbound registrado e lead pronto para envio da analise.",
    metadata: { token: normalizedToken, formId: form.id },
  });

  let analysisDispatch = { queued: false, reason: "not_attempted" };
  try {
    const agent = await resolveAgentForLead(lead);
    analysisDispatch = await triggerAnalysisForLeadAsync({
      workflow,
      agent,
      provider: agent.defaultProvider,
      prisma,
      tables,
      lead,
      config: await ensureWorkflowConfigRows(prisma, workflow),
      source: "form_submit",
      publicBaseUrlOverride: textOrEmpty(publicBaseUrlOverride),
    });
  } catch (error) {
    logWf2("error", "forms.analysis.trigger_failed", {
      explanation:
        "Formulario foi registrado, mas houve falha ao disparar automaticamente a analise para o lead.",
      workflow,
      leadId: lead.id,
      message: error?.message || "unknown",
    });
  }

  return {
    workflow,
    token: normalizedToken,
    formId: form.id,
    lead: leadSummary(lead),
    analysisTriggered: Boolean(analysisDispatch?.queued),
    analysisReason: analysisDispatch?.reason || null,
  };
}

async function startOutboundFromCommand({
  agentSlug = "default-sdr",
  workflow: workflowInput,
  provider = "",
  phoneNumber,
  profileName = "",
  segmentHint = "",
}) {
  const workflow = resolveWorkflow(workflowInput);
  const prisma = getPrisma(workflow);
  const tables = getWorkflowTables(prisma, workflow);
  const normalizedPhone = normalizeE164(phoneNumber);
  if (!normalizedPhone) {
    const immediateReply = await rewriteWf2TextWithAi({
      text: "Nao consegui identificar seu numero para iniciar o teste outbound.",
      workflow,
      lead: null,
      purpose: "start_command_invalid_phone",
      maxChars: 220,
    });
    return {
      processed: false,
      reason: "invalid_phone",
      immediateReply,
    };
  }

  const parsedSegment = resolveStartSegment(segmentHint);
  if (parsedSegment.hasSegmentHint && !parsedSegment.segment) {
    const immediateReply = await rewriteWf2TextWithAi({
      text: "Segmento invalido no /start. Use, por exemplo, /start=dentista, /start=barbearia ou /start=restaurante.",
      workflow,
      lead: null,
      purpose: "start_command_invalid_segment",
      maxChars: 260,
    });
    return {
      processed: false,
      reason: "invalid_segment",
      immediateReply,
    };
  }

  const normalizedAgentSlug = textOrEmpty(agentSlug || "default-sdr") || "default-sdr";
  let lead = await findLeadByPhone(tables, normalizedPhone, normalizedAgentSlug);
  const now = new Date();
  const nowIso = now.toISOString();
  const chosenSegment = parsedSegment.hasSegmentHint
    ? parsedSegment.segment
    : asLeadSegment(lead?.segmento || "outro");

  if (!lead) {
    lead = await tables.lead.create({
      data: {
        id: crypto.randomUUID(),
        nome: textOrEmpty(profileName) || "Lead Teste",
        telefone: normalizedPhone,
        empresa: `Empresa Teste ${normalizedPhone.slice(-4)}`,
        segmento: chosenSegment,
        endereco: "Nao informado",
        site: null,
        email: null,
        fonteOrigem: ScrapeSource.manual,
        agentSlug: normalizedAgentSlug,
        status: "NOVO_LEAD",
        canalAquisicao: "outbound_start_command",
        pipelineOrigin: "automacao",
        automationActive: true,
        formularioPreenchido: false,
        diagnosticoFormularioId: null,
        ultimaInteracao: now,
        ultimoEnvioIa: null,
        proximoFollowupEm: null,
        followupNivel: 0,
        dadosBrutos: mergeDadosBrutos(null, {
          wf2: {
            startedByCommand: true,
            startCommandAt: nowIso,
            startCommandSegment: chosenSegment,
            etapa1SentAt: null,
            etapaAtual: "etapa1_pending",
            analysisAwaitingReadConfirmation: false,
            analysisReadConfirmedAt: null,
            analysisDeliveryStep: null,
          },
        }),
      },
    });
  } else {
    const nextSegment = parsedSegment.hasSegmentHint
      ? chosenSegment
      : asLeadSegment(lead.segmento || chosenSegment, chosenSegment);
    lead = await tables.lead.update({
      where: { id: lead.id },
      data: {
        nome: textOrEmpty(profileName) || lead.nome,
        segmento: nextSegment,
        status: "NOVO_LEAD",
        canalAquisicao: "outbound_start_command",
        pipelineOrigin: "automacao",
        automationActive: true,
        ultimaInteracao: now,
        ultimoEnvioIa: null,
        proximoFollowupEm: null,
        followupNivel: 0,
        dadosBrutos: mergeDadosBrutos(lead.dadosBrutos, {
          wf2: {
            startedByCommand: true,
            startCommandAt: nowIso,
            startCommandSegment: nextSegment,
            previousStatusBeforeStart: String(lead.status || "").toUpperCase() || null,
            etapa1SentAt: null,
            etapaAtual: "etapa1_pending",
            analysisAwaitingReadConfirmation: false,
            analysisReadConfirmedAt: null,
            analysisDeliveryStep: null,
          },
        }),
      },
    });
  }

  await appendTimeline(prisma, {
    workflow,
    leadId: lead.id,
    tipo: "start_command",
    etapa: "etapa1",
    direcao: "system",
    mensagem: "Fluxo outbound iniciado via comando /start.",
    metadata: {
      segmentHint: parsedSegment.hasSegmentHint ? String(chosenSegment) : null,
      provider: normalizeProvider(provider) || provider || null,
    },
  });

  const agent = getAgentOrThrow(normalizedAgentSlug);
  const config = await ensureWorkflowConfigRows(prisma, workflow);
  const outboundResult = await processNewOutboundLead({
    workflow,
    prisma,
    tables,
    config,
    lead,
    agent,
    providerOverride: normalizeProvider(provider) || provider || null,
    ignoreSchedule: true,
  });

  if (!outboundResult?.processed) {
    const baseReply =
      outboundResult?.reason === "outbound_disabled"
        ? "O comando /start foi recebido, mas o envio outbound esta desativado na configuracao."
        : "Recebi o /start, mas nao consegui iniciar o outbound agora. Tenta novamente em instantes.";
    const immediateReply = await rewriteWf2TextWithAi({
      text: baseReply,
      workflow,
      lead,
      purpose: "start_command_not_started",
      maxChars: 240,
    });
    return {
      processed: false,
      reason: outboundResult?.reason || "outbound_not_started",
      lead: leadSummary(lead),
      immediateReply,
    };
  }

  const updatedLead = await tables.lead.findUnique({
    where: { id: lead.id },
  });

  return {
    processed: true,
    reason: "outbound_started_by_command",
    lead: leadSummary(updatedLead || lead),
    segmentApplied: String((updatedLead || lead)?.segmento || chosenSegment),
    immediateReply: null,
  };
}

module.exports = {
  processWorkflowTick,
  processAllWorkflowTicks,
  registerInboundMessageEvent,
  createDiagnosticoFromPayload,
  startOutboundFromCommand,
};
