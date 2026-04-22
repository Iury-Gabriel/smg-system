const crypto = require("crypto");
const path = require("path");
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
  sendMetaTemplateMessage,
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
const OPT_OUT_REGEX = /\b(parar|sair|remover|nao quero|não quero|stop|cancelar|opt[\s-]?out)\b/i;

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

async function resolveAgentForLead(lead) {
  const slug = textOrEmpty(lead?.agentSlug || "default-sdr");
  return getAgentOrThrow(slug);
}

async function sendLeadText({ agent, provider, lead, text, forceTemplateName = "" }) {
  if (!env.allowOutboundMessages) {
    return {
      suppressed: true,
      reason: "outbound_disabled",
    };
  }

  const normalizedProvider = normalizeProvider(provider || agent.defaultProvider) || agent.defaultProvider;
  const safeText = textOrEmpty(text);
  const destination = lead.telefone;
  if (!destination || !safeText) {
    throw new Error("Lead sem telefone ou texto vazio para envio.");
  }

  const { config: providerConfig } = getAgentProviderConfig(agent, normalizedProvider);
  if (normalizedProvider === "meta") {
    const templateName = textOrEmpty(forceTemplateName);
    const insideWindow = isInside24hWindow(lead);

    if (!insideWindow && templateName) {
      return sendMetaTemplateMessage(providerConfig, {
        to: destination,
        templateName,
        parameters: [lead.nome || "Cliente"],
      });
    }

    try {
      return await sendMetaTextMessage(providerConfig, { to: destination, text: safeText });
    } catch (error) {
      if (!insideWindow && templateName) {
        return sendMetaTemplateMessage(providerConfig, {
          to: destination,
          templateName,
          parameters: [lead.nome || "Cliente"],
        });
      }
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
  return [
    "Voce e especialista em diagnostico operacional para negocios SMB.",
    "Gere uma Analise de Maturidade Operacional no framework SIG (Sistema, Inteligencia, Gestao).",
    "Formato esperado:",
    "1) Resumo executivo",
    "2) Pilar Sistema",
    "3) Pilar Inteligencia",
    "4) Pilar Gestao",
    "5) Top 3 gargalos",
    "6) Pre-diagnostico",
    "7) Proximos passos",
    "",
    `Empresa: ${lead?.empresa || "-"}`,
    `Segmento: ${form?.segmento || lead?.segmento || "-"}`,
    `Faturamento mensal: ${form?.faturamentoMensal || "-"}`,
    `Numero de funcionarios: ${form?.numFuncionarios ?? "-"}`,
    `Ferramentas atuais: ${form?.ferramentas || "-"}`,
    `Tentativa anterior: ${form?.tentativaAnterior || "-"}`,
    `Mudanca desejada na operacao: ${form?.mudancaOperacao || "-"}`,
    `Descricao da operacao: ${form?.descricaoOperacao || "-"}`,
    `Urgencia: ${form?.urgencia || "-"}`,
    `Maior desafio: ${form?.maiorDesafio || "-"}`,
    `Motivacao: ${form?.motivacao || "-"}`,
    `Expectativa: ${form?.expectativa || "-"}`,
    "",
    "Escreva em pt-BR objetivo, sem floreio e com clareza executiva.",
  ].join("\n");
}

async function processAnalysisForLead({
  workflow,
  agent,
  provider,
  prisma,
  tables,
  lead,
  config = null,
}) {
  if (!env.allowOutboundMessages) {
    return { processed: false, reason: "outbound_disabled" };
  }

  if (!lead?.automationActive) return { processed: false, reason: "automation_inactive" };
  if (String(lead.status || "").toUpperCase() !== "FORMULARIO_RESPONDIDO") {
    return { processed: false, reason: "status_not_ready" };
  }

  const formId = textOrEmpty(lead.diagnosticoFormularioId);
  if (!formId) {
    await appendTimeline(prisma, {
      workflow,
      leadId: lead.id,
      tipo: "erro_analise",
      etapa: "etapa6",
      direcao: "system",
      mensagem: "Lead sem diagnostico_formulario_id para gerar analise.",
      metadata: {},
    });
    return { processed: false, reason: "missing_form_id" };
  }

  const form = await prisma.leadDiagnostico.findUnique({
    where: { id: formId },
  });
  if (!form) {
    await appendTimeline(prisma, {
      workflow,
      leadId: lead.id,
      tipo: "erro_analise",
      etapa: "etapa6",
      direcao: "system",
      mensagem: "Formulario de diagnostico nao encontrado.",
      metadata: { formId },
    });
    return { processed: false, reason: "form_not_found" };
  }

  const userPrompt = buildAnalysisPrompt(form, lead);
  const aiResult = await generateAiReply({
    systemPrompt:
      "Voce cria analises de maturidade operacional profundas e praticas para PMEs no Brasil.",
    userPrompt,
    fallbackReply:
      "Analise preliminar: existem oportunidades de melhoria em processos, uso de dados e governanca operacional. Recomendamos diagnostico aprofundado para plano de implementacao.",
    useLangChain: false,
    allowEnvFallback: true,
    model: env.openaiModel || "gpt-4o-mini",
    apiKey: env.openaiApiKey || "",
  });

  const analysisText = textOrEmpty(aiResult.text);
  const publicBaseUrl =
    textOrEmpty(env.publicWebhookBaseUrl) || `http://localhost:${env.port}`;
  const file = await generateAnalysisPdf({
    projectRoot: process.cwd(),
    publicBaseUrl,
    workflow,
    lead,
    analysisText,
  });
  if (!file.publicUrl) {
    throw new Error(
      "PUBLIC_WEBHOOK_BASE_URL nao configurado para envio de documento PDF publico."
    );
  }

  const inboundLead = isInboundLead(lead);
  const introText = inboundLead
    ? `Oi ${lead?.nome || "tudo bem"}, eu sou a Clara, do time comercial da SMG. Vou te enviar agora sua Analise de Maturidade em PDF para voce revisar com calma.`
    : "Perfeito. Vou te enviar agora sua Analise de Maturidade em PDF.";

  await sendLeadText({
    agent,
    provider,
    lead,
    text: introText,
  });

  await sendLeadDocument({
    agent,
    provider,
    lead,
    documentUrl: file.publicUrl,
    caption: "Sua Analise de Maturidade Operacional da SMG.",
    filename: file.filename,
  });

  await sendLeadText({
    agent,
    provider,
    lead,
    text:
      "Acabei de te enviar a Analise de Maturidade em PDF. Se fizer sentido para voce, ja podemos alinhar o diagnostico guiado.",
    forceTemplateName: textOrEmpty(agent?.providers?.meta?.templates?.analiseFollowup),
  });

  const now = new Date();
  const effectiveConfig = config || (await ensureWorkflowConfigRows(prisma, workflow));
  await prisma.analiseMaturidade.create({
    data: {
      workflow,
      leadId: lead.id,
      formularioId: form.id,
      arquivoPath: file.relativePath,
      arquivoUrl: file.publicUrl,
      resumo: clipText(analysisText, 600),
    },
  });

  const updated = await tables.lead.update({
    where: { id: lead.id },
    data: {
      status: "ANALISE_ENVIADA",
      ultimoEnvioIa: now,
      followupNivel: 0,
      proximoFollowupEm: nextFollowupDate(effectiveConfig, 0, now),
      dadosBrutos: mergeDadosBrutos(lead.dadosBrutos, {
        wf2: {
          analysisSentAt: now.toISOString(),
          analysisFileUrl: file.publicUrl,
        },
      }),
    },
  });

  await appendTimeline(prisma, {
    workflow,
    leadId: lead.id,
    tipo: "analise_enviada",
    etapa: "etapa6",
    direcao: "outbound",
    mensagem: "Analise de maturidade enviada em PDF.",
    metadata: {
      arquivoUrl: file.publicUrl,
      model: aiResult.model || null,
      usedFallback: Boolean(aiResult.usedFallback),
    },
  });

  return {
    processed: true,
    lead: updated,
    analysisUrl: file.publicUrl,
  };
}

async function processNewOutboundLead({
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
  if (isInboundLead(lead)) return { processed: false, reason: "inbound_lead" };
  if (String(lead.status || "").toUpperCase() !== "NOVO_LEAD") {
    return { processed: false, reason: "status_not_novo_lead" };
  }
  if (!isWithinAutomationSchedule(config)) {
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
    form_link: textOrEmpty(agent?.formLink || "https://smg.com.br/diagnostico"),
  });

  await sendLeadText({
    agent,
    provider: agent.defaultProvider,
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
      provider: agent.defaultProvider,
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
    form_link: textOrEmpty(agent?.formLink || "https://smg.com.br/diagnostico"),
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
      immediateReply:
        "Perfeito, vou encerrar os contatos por aqui. Se quiser retomar no futuro, e so me chamar.",
      lead: updatedLead,
    };
  }

  let leadForNextStep = updatedLead;
  let normalizedStatus = String(leadForNextStep.status || "").toUpperCase();
  const hasLinkedForm =
    Boolean(textOrEmpty(leadForNextStep.diagnosticoFormularioId)) ||
    Boolean(leadForNextStep.formularioPreenchido);
  const shouldAutoAdvanceFromInbound =
    hasLinkedForm &&
    isInboundLead(leadForNextStep) &&
    (normalizedStatus === "FORMULARIO_ENVIADO" || normalizedStatus === "NOVO_LEAD");

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

  const shouldAttemptImmediateAnalysis =
    normalizedStatus === "FORMULARIO_RESPONDIDO" &&
    hasLinkedForm &&
    (Boolean(token) || isInboundLead(leadForNextStep));

  if (shouldAttemptImmediateAnalysis) {
    if (!env.allowOutboundMessages) {
      return {
        foundLead: true,
        suppressAi: true,
        reason: "outbound_disabled",
        lead: leadForNextStep,
      };
    }

    const agent = await resolveAgentForLead(leadForNextStep);
    const analysisResult = await processAnalysisForLead({
      workflow,
      agent,
      provider,
      prisma,
      tables,
      lead: leadForNextStep,
      config: await ensureWorkflowConfigRows(prisma, workflow),
    });
    logWf2("info", "inbound.message.token_analysis", {
      explanation:
        "Mensagem inbound com formulario vinculado processada e tentativa de envio da analise iniciada automaticamente.",
      workflow,
      leadId: leadForNextStep.id,
      token: token || null,
      analysisProcessed: Boolean(analysisResult.processed),
      reason: analysisResult.reason || null,
    });
    return {
      foundLead: true,
      suppressAi: Boolean(analysisResult.processed),
      reason: analysisResult.processed
        ? token
          ? "analysis_sent_after_token"
          : "analysis_sent_after_form_match"
        : token
          ? "token_processed"
          : "inbound_form_matched",
      lead: leadForNextStep,
    };
  }

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

      const followupLeads = await tables.lead.findMany({
        where: {
          agentSlug: agent.slug,
          automationActive: true,
          proximoFollowupEm: {
            lte: new Date(),
          },
        },
        orderBy: { proximoFollowupEm: "asc" },
        take: 80,
      });

      for (const lead of followupLeads) {
        try {
          const result = await processLeadFollowup({
            workflow,
            prisma,
            tables,
            config,
            lead,
            agent,
          });
          if (result?.processed) {
            stats.followupsSent += 1;
          }
        } catch (error) {
          logWf2("error", "followup.failed", {
            workflow,
            agentSlug: agent.slug,
            leadId: lead.id,
            message: error?.message || "unknown",
          });
          await appendTimeline(prisma, {
            workflow,
            leadId: lead.id,
            tipo: "erro_envio",
            etapa: "followup",
            direcao: "system",
            mensagem: error?.message || "Erro ao enviar follow-up.",
            metadata: {},
          }).catch(() => null);
        }
      }
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
        status: "FORMULARIO_ENVIADO",
        pipelineOrigin: textOrEmpty(leadPayload.pipelineOrigin || "diagnostico_site"),
        canalAquisicao: textOrEmpty(leadPayload.canalAquisicao || "inbound_site"),
        automationActive: true,
        formularioPreenchido: true,
        diagnosticoFormularioId: form.id,
        dadosBrutos: mergeDadosBrutos(null, {
          wf2: {
            inboundToken: normalizedToken,
            formularioCriadoAt: new Date().toISOString(),
          },
        }),
      },
    });
  } else {
    lead = await tables.lead.update({
      where: { id: lead.id },
      data: {
        status: "FORMULARIO_ENVIADO",
        pipelineOrigin: textOrEmpty(leadPayload.pipelineOrigin || "diagnostico_site"),
        canalAquisicao: textOrEmpty(leadPayload.canalAquisicao || "inbound_site"),
        formularioPreenchido: true,
        diagnosticoFormularioId: form.id,
        ultimaInteracao: new Date(),
        dadosBrutos: mergeDadosBrutos(lead.dadosBrutos, {
          wf2: {
            inboundToken: normalizedToken,
            formularioCriadoAt: new Date().toISOString(),
          },
        }),
      },
    });
  }

  await appendTimeline(prisma, {
    workflow,
    leadId: lead.id,
    tipo: "formulario_enviado",
    etapa: "etapa5",
    direcao: "system",
    mensagem: "Formulario inbound registrado para o lead.",
    metadata: { token: normalizedToken, formId: form.id },
  });

  return {
    workflow,
    token: normalizedToken,
    formId: form.id,
    lead: leadSummary(lead),
  };
}

module.exports = {
  processWorkflowTick,
  processAllWorkflowTicks,
  registerInboundMessageEvent,
  createDiagnosticoFromPayload,
};
