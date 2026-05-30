const crypto = require("crypto");
const path = require("path");
const { getWorkflowTables } = require("../../services/workflow-data-access.service");

const FORM_LINK =
  process.env.AGENT_DEFAULT_SDR_FORM_LINK === "https://smg.com.br/diagnostico"
    ? "https://sistema.smgcompany.com.br/diagnostico"
    : process.env.AGENT_DEFAULT_SDR_FORM_LINK ||
      "https://sistema.smgcompany.com.br/diagnostico";
const DEFAULT_PIPELINE_ORIGIN = process.env.AGENT_DEFAULT_SDR_PIPELINE_ORIGIN || "automacao";
const DEFAULT_CHANNEL = process.env.AGENT_DEFAULT_SDR_CHANNEL || "scrap_smg";
const WF2_MIN_POST_READ_INTERACTIONS = Math.max(
  0,
  Number(process.env.WF2_MIN_POST_READ_INTERACTIONS || 2)
);

function normalizeDigits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildPhoneCandidates(rawPhone) {
  const digits = normalizeDigits(rawPhone);
  if (!digits) return [];

  const candidates = new Set([digits, `+${digits}`]);
  if (!digits.startsWith("55") && digits.length >= 10) {
    candidates.add(`55${digits}`);
    candidates.add(`+55${digits}`);
  }
  if (digits.startsWith("55")) {
    const withoutCountry = digits.slice(2);
    if (withoutCountry.length >= 10) {
      candidates.add(withoutCountry);
      candidates.add(`+${withoutCountry}`);
    }
  }

  return [...candidates];
}

function mergeDadosBrutos(existing, patch) {
  const current =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  return {
    ...current,
    ...patch,
    wf2: {
      ...(current.wf2 && typeof current.wf2 === "object" ? current.wf2 : {}),
      ...(patch.wf2 && typeof patch.wf2 === "object" ? patch.wf2 : {}),
    },
  };
}

async function findLeadByPhone(tables, rawPhone) {
  const candidates = buildPhoneCandidates(rawPhone);
  if (!candidates.length) return null;
  return tables.lead.findFirst({
    where: {
      telefone: {
        in: candidates,
      },
    },
    orderBy: { criadoEm: "desc" },
  });
}

function buildLeadSummary(lead) {
  if (!lead) return null;
  return {
    id: lead.id,
    nome: lead.nome,
    telefone: lead.telefone,
    empresa: lead.empresa,
    segmento: lead.segmento,
    email: lead.email || "",
    status: lead.status,
    canalAquisicao: lead.canalAquisicao || "",
    pipelineOrigin: lead.pipelineOrigin || "",
    automationActive: Boolean(lead.automationActive),
    criadoEm: lead.criadoEm,
    wf2: lead?.dadosBrutos?.wf2 || {},
  };
}

function inferEntryStage(lead) {
  if (!lead) return "sem_lead";
  const status = String(lead.status || "").trim().toUpperCase();

  if (status === "FORMULARIO_RESPONDIDO" || status === "ANALISE_ENVIADA") {
    return "etapa_6_8";
  }

  if (status === "FORMULARIO_ENVIADO") {
    return "etapa_5";
  }

  if (status === "INTERMEDIARIO_IDENTIFICADO") {
    return "bifurcacao_intermediario";
  }

  if (status === "DIAGNOSTICO_AGENDADO") {
    return "agendado";
  }

  if (status === "DESQUALIFICADO") {
    return "desqualificado";
  }

  return "etapa_1_5";
}

function parseValidDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseNaturalScheduleDate(rawValue = "", baseDate = new Date()) {
  const raw = normalizeIntentText(rawValue);
  if (!raw) return null;

  const timeMatch = raw.match(/\b(?:as\s*)?([01]?\d|2[0-3])(?:[:h]([0-5]\d))?\s*h?\b/);
  const hour = timeMatch ? Number(timeMatch[1]) : null;
  const minute = timeMatch && timeMatch[2] !== undefined ? Number(timeMatch[2]) : 0;
  if (hour === null || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  const candidate = new Date(baseDate);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);

  const explicitDate = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (explicitDate) {
    const day = Number(explicitDate[1]);
    const month = Number(explicitDate[2]);
    const yearRaw = explicitDate[3] ? Number(explicitDate[3]) : baseDate.getFullYear();
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  if (/\bamanha\b/.test(raw)) {
    candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }
  if (/\bhoje\b/.test(raw)) {
    if (candidate.getTime() <= baseDate.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  const weekdayMap = {
    segunda: 1,
    seg: 1,
    terca: 2,
    ter: 2,
    quarta: 3,
    qua: 3,
    quinta: 4,
    qui: 4,
    sexta: 5,
    sex: 5,
    sabado: 6,
    sab: 6,
    domingo: 0,
    dom: 0,
  };

  const weekdayToken =
    Object.keys(weekdayMap).find((token) => new RegExp(`\\b${token}\\b`).test(raw)) || "";
  if (!weekdayToken) return null;

  const targetDow = weekdayMap[weekdayToken];
  const currentDow = baseDate.getDay();
  let deltaDays = (targetDow - currentDow + 7) % 7;
  if (deltaDays === 0 && candidate.getTime() <= baseDate.getTime()) {
    deltaDays = 7;
  }
  candidate.setDate(candidate.getDate() + deltaDays);
  return candidate;
}

function normalizeIntentText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function hasExplicitScheduleConsent(messageText = "") {
  const text = normalizeIntentText(messageText);
  if (!text) return false;

  const hasNegativeIntent = /\b(nao|nao agora|depois|talvez|prefiro depois|sem agendar)\b/.test(
    text
  );
  if (hasNegativeIntent) return false;

  const directConsent =
    /\b(pode agendar|pode marcar|quero agendar|vamos agendar|fechado|manda|pode ser)\b/.test(
      text
    );
  if (directConsent) return true;

  const hasDayOrDate =
    /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)\b/.test(text) ||
    /\b\d{1,2}\/\d{1,2}\b/.test(text) ||
    /\b\d{1,2}\s+de\s+[a-z]+\b/.test(text);
  const hasTime = /\b([01]?\d|2[0-3])(:[0-5]\d)?\s*h?\b/.test(text);

  return hasDayOrDate && hasTime;
}

module.exports = {
  slug: "default-sdr",
  name: "Clara",
  description:
    "Clara, agente de IA do WF2 para qualificacao e agendamento de diagnostico via WhatsApp.",
  workflow: process.env.AGENT_DEFAULT_SDR_WORKFLOW || "smg",
  wf2: {
    enabled: true,
  },
  formLink: FORM_LINK,
  defaultProvider: "meta",
  promptFile: path.join(__dirname, "prompt.md"),
  ai: {
    enabled:
      String(process.env.AGENT_DEFAULT_SDR_AI_ENABLED || "true").toLowerCase() !==
      "false",
    apiKey:
      process.env.AGENT_DEFAULT_SDR_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
    model:
      process.env.AGENT_DEFAULT_SDR_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    bufferSeconds:
      Number(process.env.AGENT_DEFAULT_SDR_BUFFER_SECONDS || process.env.AGENT_DEFAULT_BUFFER_SECONDS || 15) ||
      15,
    historyLimit:
      Number(process.env.AGENT_DEFAULT_SDR_HISTORY_LIMIT || process.env.AGENT_CONVERSATION_HISTORY_LIMIT || 20) ||
      20,
    humanHandoffEnabled:
      String(process.env.AGENT_DEFAULT_SDR_HUMAN_HANDOFF || "true").toLowerCase() !==
      "false",
    clearMemoryCommandEnabled:
      String(process.env.AGENT_DEFAULT_SDR_CLEAR_MEMORY_COMMAND || "true").toLowerCase() !==
      "false",
    strictOpenAiResponses:
      String(process.env.AGENT_DEFAULT_SDR_STRICT_OPENAI_RESPONSES || "true").toLowerCase() !==
      "false",
    fallbackReply:
      "Recebi suas mensagens. Obrigado pelo contato, ja vou te ajudar com isso.",
  },
  providers: {
    meta: {
      verifyToken:
        process.env.AGENT_DEFAULT_SDR_META_VERIFY_TOKEN ||
        process.env.META_WEBHOOK_VERIFY_TOKEN ||
        "",
      accessToken: process.env.AGENT_DEFAULT_SDR_META_ACCESS_TOKEN || "",
      phoneNumberId: process.env.AGENT_DEFAULT_SDR_META_PHONE_NUMBER_ID || "",
      wabaId: process.env.AGENT_DEFAULT_SDR_META_WABA_ID || "",
      graphBaseUrl:
        process.env.AGENT_DEFAULT_SDR_META_GRAPH_BASE_URL ||
        process.env.META_GRAPH_BASE_URL ||
        "https://graph.facebook.com/v23.0",
      templates: {
        initialOutbound: process.env.AGENT_DEFAULT_SDR_META_TEMPLATE_INITIAL_OUTBOUND || "",
        followup1: process.env.AGENT_DEFAULT_SDR_META_TEMPLATE_FUP1 || "",
        followup2: process.env.AGENT_DEFAULT_SDR_META_TEMPLATE_FUP2 || "",
        followup3: process.env.AGENT_DEFAULT_SDR_META_TEMPLATE_FUP3 || "",
        followupRecurring: process.env.AGENT_DEFAULT_SDR_META_TEMPLATE_FUP_RECORRENTE || "",
        analiseFollowup: process.env.AGENT_DEFAULT_SDR_META_TEMPLATE_ANALISE || "",
      },
    },
    uazapi: {
      baseUrl:
        process.env.AGENT_DEFAULT_SDR_UAZAPI_BASE_URL ||
        process.env.UAZAPI_BASE_URL ||
        "",
      instanceToken: process.env.AGENT_DEFAULT_SDR_UAZAPI_INSTANCE_TOKEN || "",
      webhookSecret: process.env.AGENT_DEFAULT_SDR_UAZAPI_WEBHOOK_SECRET || "",
      sendMessagePath:
        process.env.AGENT_DEFAULT_SDR_UAZAPI_SEND_PATH ||
        process.env.UAZAPI_SEND_MESSAGE_PATH ||
        "/send/text",
    },
  },
  async buildTools({ workflow, senderNumber, prisma, log }) {
    const tables = getWorkflowTables(prisma, workflow);
    const appendTimeline = async ({
      leadId,
      tipo,
      etapa = null,
      direcao = "system",
      mensagem = "",
      metadata = {},
    }) => {
      if (!leadId) return;
      await prisma.leadAutomacaoTimeline.create({
        data: {
          workflow,
          leadId,
          tipo,
          etapa,
          direcao,
          mensagem: String(mensagem || "").trim() || null,
          metadata: metadata || {},
        },
      });
    };

    log("info", "agent.tools.loaded", {
      agentSlug: "default-sdr",
      workflow,
      senderNumber,
    });

    return [
      {
        name: "wf2_get_lead_context",
        description:
          "Carrega o contexto do lead pelo telefone da conversa e retorna origem (outbound/inbound), status e etapa recomendada do WF2.",
        schema: {
          phone_number: {
            type: "string",
            required: false,
            description:
              "Telefone do lead em qualquer formato. Se omitido, usa o telefone atual da conversa.",
          },
        },
        handler: async ({ phone_number }) => {
          const phone = String(phone_number || senderNumber || "").trim();
          const lead = await findLeadByPhone(tables, phone);

          if (!lead) {
            return {
              found: false,
              message:
                "Lead nao encontrado para este telefone em leads_automacao. Solicite confirmacao do numero.",
              phoneCandidates: buildPhoneCandidates(phone),
            };
          }

          const pipelineOrigin = String(lead.pipelineOrigin || "").trim().toLowerCase();
          const originType =
            pipelineOrigin === "diagnostico_site" || pipelineOrigin.startsWith("inbound")
              ? "inbound"
              : "outbound";

          return {
            found: true,
            lead: buildLeadSummary(lead),
            originType,
            entryStage: inferEntryStage(lead),
            rules: {
              inboundStartsAt: "FORMULARIO_RESPONDIDO -> etapa 6",
              outboundStartsAt: "NOVO_LEAD -> etapa 1",
              critical: "Nunca tratar inbound como lead frio de etapa 1.",
            },
          };
        },
      },
      {
        name: "wf2_update_lead_status",
        description:
          "Atualiza status e automacao do lead atual (ou por lead_id), registrando contexto de WF2 em dadosBrutos.",
        schema: {
          lead_id: {
            type: "string",
            required: false,
            description: "ID do lead (opcional). Se omitido, resolve por telefone da conversa.",
          },
          status: {
            type: "string",
            required: true,
            description:
              "Novo status. Exemplos: NOVO_LEAD, INTERMEDIARIO_IDENTIFICADO, FORMULARIO_ENVIADO, FORMULARIO_RESPONDIDO, ANALISE_ENVIADA, DECISOR_IDENTIFICADO, DIAGNOSTICO_AGENDADO, DESQUALIFICADO.",
          },
          automation_active: {
            type: "boolean",
            required: false,
            description: "Ativa/desativa automacao para o lead.",
          },
          reason: {
            type: "string",
            required: false,
            description: "Motivo operacional da mudanca de status.",
          },
          next_step: {
            type: "string",
            required: false,
            description: "Proximo passo esperado do WF2.",
          },
        },
        handler: async ({
          lead_id,
          status,
          automation_active,
          reason,
          next_step,
        }) => {
          const normalizedStatus = String(status || "").trim().toUpperCase();
          if (!normalizedStatus) {
            return { ok: false, error: "status obrigatorio." };
          }
          if (normalizedStatus === "DIAGNOSTICO_AGENDADO") {
            return {
              ok: false,
              error:
                "Atualizacao manual para DIAGNOSTICO_AGENDADO bloqueada. Use wf2_schedule_diagnosis.",
            };
          }

          let lead = null;
          if (String(lead_id || "").trim()) {
            lead = await tables.lead.findUnique({ where: { id: String(lead_id).trim() } });
          } else {
            lead = await findLeadByPhone(tables, senderNumber);
          }

          if (!lead) {
            return { ok: false, error: "Lead nao encontrado para atualizar status." };
          }

          const mergedDados = mergeDadosBrutos(lead.dadosBrutos, {
            wf2: {
              lastStatusReason: String(reason || "").trim() || null,
              nextStep: String(next_step || "").trim() || null,
              updatedBy: "agent_default_sdr_wf2",
              updatedAt: new Date().toISOString(),
            },
          });

          const updated = await tables.lead.update({
            where: { id: lead.id },
            data: {
              status: normalizedStatus,
              ...(automation_active === undefined
                ? {}
                : { automationActive: Boolean(automation_active) }),
              dadosBrutos: mergedDados,
            },
          });
          await appendTimeline({
            leadId: updated.id,
            tipo: "status_atualizado",
            etapa: "wf2_tool",
            mensagem: `Status atualizado para ${normalizedStatus}.`,
            metadata: {
              reason: String(reason || "").trim() || null,
              nextStep: String(next_step || "").trim() || null,
            },
          });

          return {
            ok: true,
            lead: buildLeadSummary(updated),
          };
        },
      },
      {
        name: "wf2_register_inbound_token",
        description:
          "Registra token inbound (SMG-xxxx) no lead e avanca para FORMULARIO_RESPONDIDO quando aplicavel.",
        schema: {
          token: {
            type: "string",
            required: true,
            description: "Token recebido pelo WhatsApp, normalmente no formato SMG-{token}.",
          },
        },
        handler: async ({ token }) => {
          const normalizedToken = String(token || "").trim();
          if (!normalizedToken) {
            return { ok: false, error: "token obrigatorio." };
          }

          const lead = await findLeadByPhone(tables, senderNumber);
          if (!lead) {
            return {
              ok: false,
              error:
                "Lead nao encontrado para vincular token. Confirmar telefone do contato.",
            };
          }

          const currentStatus = String(lead.status || "").trim().toUpperCase();
          const nextStatus =
            currentStatus === "FORMULARIO_ENVIADO" ? "FORMULARIO_RESPONDIDO" : currentStatus;

          const mergedDados = mergeDadosBrutos(lead.dadosBrutos, {
            wf2: {
              inboundToken: normalizedToken,
              inboundTokenAt: new Date().toISOString(),
            },
          });

          const updated = await tables.lead.update({
            where: { id: lead.id },
            data: {
              status: nextStatus,
              dadosBrutos: mergedDados,
            },
          });
          await appendTimeline({
            leadId: updated.id,
            tipo: "token_processado",
            etapa: "etapa5",
            mensagem: "Token inbound registrado no lead.",
            metadata: {
              token: normalizedToken,
              nextStatus,
            },
          });

          return {
            ok: true,
            message:
              nextStatus === "FORMULARIO_RESPONDIDO"
                ? "Token registrado e status avancado para FORMULARIO_RESPONDIDO."
                : "Token registrado no contexto do lead.",
            lead: buildLeadSummary(updated),
          };
        },
      },
      {
        name: "wf2_register_decision_maker",
        description:
          "Quando contato atual e intermediario, pausa lead original e cria novo lead do decisor para reiniciar WF2.",
        schema: {
          decision_maker_phone: {
            type: "string",
            required: true,
            description: "Telefone do decisor.",
          },
          decision_maker_name: {
            type: "string",
            required: false,
            description: "Nome do decisor (opcional).",
          },
        },
        handler: async ({ decision_maker_phone, decision_maker_name }) => {
          const originalLead = await findLeadByPhone(tables, senderNumber);
          if (!originalLead) {
            return {
              ok: false,
              error: "Lead original nao encontrado para criar lead do decisor.",
            };
          }

          const decisorDigits = normalizeDigits(decision_maker_phone);
          if (decisorDigits.length < 10) {
            return {
              ok: false,
              error: "Telefone do decisor invalido. Informe com DDD.",
            };
          }

          const decisorPhone = `+${decisorDigits.startsWith("55") ? decisorDigits : `55${decisorDigits}`}`;
          const duplicate = await findLeadByPhone(tables, decisorPhone);
          if (duplicate) {
            await tables.lead.update({
              where: { id: originalLead.id },
              data: {
                status: "INTERMEDIARIO_IDENTIFICADO",
                automationActive: false,
                dadosBrutos: mergeDadosBrutos(originalLead.dadosBrutos, {
                  wf2: {
                    intermediaryForwardedToLeadId: duplicate.id,
                    intermediaryForwardedPhone: decisorPhone,
                    updatedAt: new Date().toISOString(),
                  },
                }),
              },
            });
            await appendTimeline({
              leadId: originalLead.id,
              tipo: "intermediario_identificado",
              etapa: "etapa3",
              mensagem:
                "Lead original pausado e encaminhado para decisor ja existente na base.",
              metadata: {
                forwardedLeadId: duplicate.id,
                decisionMakerPhone: decisorPhone,
              },
            });
            return {
              ok: true,
              reusedLead: true,
              decisionMakerLead: buildLeadSummary(duplicate),
              message:
                "Lead do decisor ja existia. Lead original foi pausado como INTERMEDIARIO_IDENTIFICADO.",
            };
          }

          const created = await tables.lead.create({
            data: {
              id: crypto.randomUUID(),
              nome: String(decision_maker_name || "").trim() || "Decisor",
              telefone: decisorPhone,
              empresa: originalLead.empresa,
              segmento: originalLead.segmento,
              endereco: originalLead.endereco,
              site: originalLead.site || null,
              email: null,
              agentSlug: String(originalLead.agentSlug || "default-sdr"),
              status: "NOVO_LEAD",
              canalAquisicao: originalLead.canalAquisicao || DEFAULT_CHANNEL,
              pipelineOrigin: originalLead.pipelineOrigin || DEFAULT_PIPELINE_ORIGIN,
              automationActive: true,
              fonteOrigem: originalLead.fonteOrigem,
              dadosBrutos: mergeDadosBrutos(originalLead.dadosBrutos, {
                wf2: {
                  createdFromIntermediaryLeadId: originalLead.id,
                  createdAt: new Date().toISOString(),
                },
              }),
            },
          });
          await appendTimeline({
            leadId: created.id,
            tipo: "lead_criado_decisor",
            etapa: "etapa3",
            mensagem: "Novo lead do decisor criado para reiniciar WF2.",
            metadata: {
              sourceLeadId: originalLead.id,
            },
          });

          await tables.lead.update({
            where: { id: originalLead.id },
            data: {
              status: "INTERMEDIARIO_IDENTIFICADO",
              automationActive: false,
              dadosBrutos: mergeDadosBrutos(originalLead.dadosBrutos, {
                wf2: {
                  intermediaryForwardedToLeadId: created.id,
                  intermediaryForwardedPhone: decisorPhone,
                  updatedAt: new Date().toISOString(),
                },
              }),
            },
          });
          await appendTimeline({
            leadId: originalLead.id,
            tipo: "intermediario_identificado",
            etapa: "etapa3",
            mensagem: "Lead original pausado e novo lead do decisor criado.",
            metadata: {
              forwardedLeadId: created.id,
              decisionMakerPhone: decisorPhone,
            },
          });

          return {
            ok: true,
            reusedLead: false,
            decisionMakerLead: buildLeadSummary(created),
            message:
              "Lead original pausado como INTERMEDIARIO_IDENTIFICADO e novo lead do decisor criado em NOVO_LEAD.",
          };
        },
      },
      {
        name: "wf2_schedule_diagnosis",
        description:
          "Registra agendamento de diagnostico no contexto do lead, atualiza status para DIAGNOSTICO_AGENDADO, cria/atualiza leads_crm e gera tarefa comercial.",
        schema: {
          scheduled_at_iso: {
            type: "string",
            required: true,
            description:
              "Data/hora do diagnostico. Preferir ISO-8601, mas aceita texto natural como 'segunda 10h' ou 'amanha 14h'.",
          },
          note: {
            type: "string",
            required: false,
            description: "Observacoes do agendamento.",
          },
        },
        handler: async ({ scheduled_at_iso, note }) => {
          const lead = await findLeadByPhone(tables, senderNumber);
          if (!lead) {
            log("warn", "wf2.schedule.blocked.lead_not_found", {
              senderNumber,
            });
            return { ok: false, error: "Lead nao encontrado para registrar agendamento." };
          }

          const wf2 = lead?.dadosBrutos?.wf2 || {};
          const readConfirmed = Boolean(wf2.analysisReadConfirmedAt);
          const waitingRead = Boolean(wf2.analysisAwaitingReadConfirmation);
          const postReadCount = Number(wf2.analysisPostReadInteractionCount || 0);
          if (String(lead.status || "").toUpperCase() !== "ANALISE_ENVIADA") {
            log("warn", "wf2.schedule.blocked.invalid_status", {
              leadId: lead.id,
              status: String(lead.status || "").toUpperCase(),
            });
            return {
              ok: false,
              error:
                "Agendamento bloqueado: so pode registrar diagnostico quando o lead estiver em ANALISE_ENVIADA.",
            };
          }
          if (!readConfirmed || waitingRead) {
            log("warn", "wf2.schedule.blocked.read_confirmation_missing", {
              leadId: lead.id,
              readConfirmed,
              waitingRead,
            });
            return {
              ok: false,
              error:
                "Agendamento bloqueado: confirme primeiro que o lead abriu a analise antes de sugerir horarios.",
            };
          }
          if (postReadCount < WF2_MIN_POST_READ_INTERACTIONS) {
            log("warn", "wf2.schedule.blocked.post_read_depth", {
              leadId: lead.id,
              postReadCount,
              minRequired: WF2_MIN_POST_READ_INTERACTIONS,
            });
            return {
              ok: false,
              error:
                `Agendamento bloqueado: faca micro-aprofundamento com pelo menos ${WF2_MIN_POST_READ_INTERACTIONS} interacoes relevantes apos a leitura da analise.`,
            };
          }

          const phoneCandidates = buildPhoneCandidates(senderNumber);
          const recentHumanMessage = await prisma.agentConversationMessage.findFirst({
            where: {
              workflow,
              agentSlug: module.exports.slug,
              role: "human",
              phoneNumber: {
                in: phoneCandidates,
              },
            },
            orderBy: { createdAt: "desc" },
          });
          const recentHumanText = String(recentHumanMessage?.content || "").trim();
          if (!hasExplicitScheduleConsent(recentHumanText)) {
            log("warn", "wf2.schedule.blocked.no_explicit_consent", {
              leadId: lead.id,
              recentHumanText,
            });
            return {
              ok: false,
              error:
                "Agendamento bloqueado: falta confirmacao explicita do lead para marcar data/horario.",
            };
          }

          const scheduledAtRaw = String(scheduled_at_iso || "").trim();
          if (!scheduledAtRaw) {
            return { ok: false, error: "scheduled_at_iso obrigatorio." };
          }
          const now = new Date();
          const scheduledAtDate =
            parseValidDate(scheduledAtRaw) ||
            parseNaturalScheduleDate(scheduledAtRaw, now) ||
            parseNaturalScheduleDate(recentHumanText, now);
          if (!scheduledAtDate) {
            log("warn", "wf2.schedule.blocked.invalid_datetime_input", {
              leadId: lead.id,
              scheduledAtRaw,
              recentHumanText,
            });
            return {
              ok: false,
              error:
                "Data/hora invalida. Envie em ISO-8601 (ex: 2026-04-24T15:00:00-03:00) ou texto como 'segunda 10h'.",
            };
          }
          if (scheduledAtDate.getTime() <= now.getTime()) {
            return {
              ok: false,
              error:
                "Horario informado esta no passado. Confirme um horario futuro para registrar o diagnostico.",
            };
          }
          const noteText = String(note || "").trim();

          const mergedDados = mergeDadosBrutos(lead.dadosBrutos, {
            wf2: {
              diagnosisScheduledAt: scheduledAtDate.toISOString(),
              diagnosisScheduleNote: noteText || null,
              updatedAt: new Date().toISOString(),
            },
          });

          const updated = await tables.lead.update({
            where: { id: lead.id },
            data: {
              status: "DIAGNOSTICO_AGENDADO",
              automationActive: false,
              dadosBrutos: mergedDados,
            },
          });
          const crm = await prisma.leadCrm.upsert({
            where: {
              workflow_leadId: {
                workflow,
                leadId: updated.id,
              },
            },
            update: {
              horarioReuniao: scheduledAtDate,
              dataPrevista: scheduledAtDate,
              observacoes: noteText || null,
            },
            create: {
              workflow,
              leadId: updated.id,
              horarioReuniao: scheduledAtDate,
              dataPrevista: scheduledAtDate,
              observacoes: noteText || null,
            },
          });

          const notifications = await prisma.configNotificacao.findMany({
            where: {
              workflow,
              enabled: true,
            },
          });
          if (notifications.length) {
            const summary = [
              "Novo diagnostico agendado",
              `Lead: ${updated.nome}`,
              `Empresa: ${updated.empresa}`,
              `Telefone: ${updated.telefone || "-"}`,
              `Horario: ${scheduledAtDate.toISOString()}`,
              noteText ? `Obs: ${noteText}` : null,
            ]
              .filter(Boolean)
              .join(" | ");

            for (const notification of notifications) {
              await prisma.taskComercial.create({
                data: {
                  workflow,
                  leadId: updated.id,
                  tipo: "diagnostico_agendado",
                  descricao: `[${notification.canal}] ${summary}`,
                  status: "pendente",
                },
              });
            }
          }

          await appendTimeline({
            leadId: updated.id,
            tipo: "diagnostico_agendado",
            etapa: "etapa8",
            mensagem: "Diagnostico agendado pelo agente via tool.",
            metadata: {
              scheduledAt: scheduledAtDate.toISOString(),
              crmId: crm.id,
              notificationsCreated: notifications.length,
            },
          });

          return {
            ok: true,
            lead: buildLeadSummary(updated),
            crm: {
              id: crm.id,
              horarioReuniao: crm.horarioReuniao,
              dataPrevista: crm.dataPrevista,
            },
            notificationsCreated: notifications.length,
            scheduledAtIso: scheduledAtDate.toISOString(),
          };
        },
      },
      {
        name: "wf2_get_form_link",
        description:
          "Retorna o link oficial do formulario de diagnostico para etapa 4 do outbound.",
        schema: {},
        handler: async () => ({
          ok: true,
          formLink: FORM_LINK,
        }),
      },
    ];
  },
};
