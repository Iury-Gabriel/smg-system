const { getPrisma } = require("../../lib/prisma");
const { getWorkflowTables } = require("../workflow-data-access.service");
const { getAgentOrThrow } = require("./registry.service");
const { resolveWorkflow } = require("../../config/workflows");
const { textOrEmpty } = require("./helpers");
const { buildPhoneCandidates } = require("../wf2/helpers");

function normalizeLimit(limit, { min = 1, max = 100, fallback = 30 } = {}) {
  return Math.max(min, Math.min(Number(limit) || fallback, max));
}

async function findLeadByPhone({ workflow, prisma, phoneNumber }) {
  const normalized = textOrEmpty(phoneNumber);
  if (!normalized) return null;
  const candidates = buildPhoneCandidates(normalized);
  if (!candidates.length) return null;

  const tables = getWorkflowTables(prisma, workflow);
  const lead = await tables.lead.findFirst({
    where: {
      telefone: {
        in: candidates,
      },
    },
    orderBy: {
      criadoEm: "desc",
    },
  });
  if (!lead) return null;

  return {
    id: lead.id,
    nome: lead.nome,
    telefone: lead.telefone,
    empresa: lead.empresa,
    status: lead.status,
    pipelineOrigin: lead.pipelineOrigin,
    canalAquisicao: lead.canalAquisicao,
    automationActive: Boolean(lead.automationActive),
    ultimaInteracao: lead.ultimaInteracao,
  };
}

async function listAgentConversations(agentSlug, options = {}) {
  const agent = getAgentOrThrow(agentSlug);
  const workflow = resolveWorkflow(agent.workflow);
  const prisma = getPrisma(workflow);
  const limit = normalizeLimit(options.limit, { max: 120, fallback: 40 });
  const search = textOrEmpty(options.search).toLowerCase();

  const sessions = await prisma.agentConversationSession.findMany({
    where: {
      workflow,
      agentSlug: agent.slug,
    },
    orderBy: {
      updatedAt: "desc",
    },
    take: limit,
  });

  const enriched = [];
  for (const session of sessions) {
    const matchesSearch =
      !search ||
      String(session.phoneNumber || "").toLowerCase().includes(search) ||
      String(session.conversationKey || "").toLowerCase().includes(search);
    if (!matchesSearch) continue;

    const [lastHuman, lastAi, totalMessages, lead] = await Promise.all([
      prisma.agentConversationMessage.findFirst({
        where: {
          workflow,
          agentSlug: agent.slug,
          conversationKey: session.conversationKey,
          role: "human",
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.agentConversationMessage.findFirst({
        where: {
          workflow,
          agentSlug: agent.slug,
          conversationKey: session.conversationKey,
          role: "ai",
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      prisma.agentConversationMessage.count({
        where: {
          workflow,
          agentSlug: agent.slug,
          conversationKey: session.conversationKey,
        },
      }),
      findLeadByPhone({
        workflow,
        prisma,
        phoneNumber: session.phoneNumber,
      }),
    ]);

    enriched.push({
      conversationKey: session.conversationKey,
      provider: session.provider,
      phoneNumber: session.phoneNumber,
      aiPaused: Boolean(session.aiPaused),
      pausedReason: session.pausedReason || null,
      pausedAt: session.pausedAt || null,
      lastMessageAt: session.lastMessageAt || null,
      updatedAt: session.updatedAt,
      totalMessages,
      preview: {
        human: lastHuman?.content || null,
        ai: lastAi?.content || null,
      },
      lead,
    });
  }

  return {
    workflow,
    agentSlug: agent.slug,
    count: enriched.length,
    items: enriched,
  };
}

async function getAgentConversationMessages(agentSlug, conversationKeyInput, options = {}) {
  const agent = getAgentOrThrow(agentSlug);
  const workflow = resolveWorkflow(agent.workflow);
  const prisma = getPrisma(workflow);
  const limit = normalizeLimit(options.limit, { max: 400, fallback: 120 });
  const conversationKey = textOrEmpty(conversationKeyInput);
  if (!conversationKey) {
    const error = new Error("conversationKey obrigatorio.");
    error.statusCode = 400;
    throw error;
  }

  const session = await prisma.agentConversationSession.findUnique({
    where: {
      workflow_agentSlug_conversationKey: {
        workflow,
        agentSlug: agent.slug,
        conversationKey,
      },
    },
  });

  const messages = await prisma.agentConversationMessage.findMany({
    where: {
      workflow,
      agentSlug: agent.slug,
      conversationKey,
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const lead = await findLeadByPhone({
    workflow,
    prisma,
    phoneNumber: session?.phoneNumber || "",
  });

  return {
    workflow,
    agentSlug: agent.slug,
    conversationKey,
    session: session
      ? {
          provider: session.provider,
          phoneNumber: session.phoneNumber,
          aiPaused: Boolean(session.aiPaused),
          pausedReason: session.pausedReason || null,
          pausedAt: session.pausedAt || null,
          lastMessageAt: session.lastMessageAt || null,
          updatedAt: session.updatedAt,
        }
      : null,
    lead,
    messages: messages.map((item) => ({
      id: item.id,
      role: item.role,
      content: item.content,
      createdAt: item.createdAt,
    })),
  };
}

async function listAgentExecutionRuns(agentSlug, options = {}) {
  const agent = getAgentOrThrow(agentSlug);
  const workflow = resolveWorkflow(agent.workflow);
  const prisma = getPrisma(workflow);
  const limit = normalizeLimit(options.limit, { max: 200, fallback: 50 });
  const conversationKey = textOrEmpty(options.conversationKey);

  const runs = await prisma.agentExecutionRun.findMany({
    where: {
      workflow,
      agentSlug: agent.slug,
      ...(conversationKey ? { conversationKey } : {}),
    },
    include: {
      events: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
  });

  return {
    workflow,
    agentSlug: agent.slug,
    count: runs.length,
    items: runs.map((run) => ({
      id: run.id,
      provider: run.provider,
      conversationKey: run.conversationKey,
      phoneNumber: run.phoneNumber,
      triggerSource: run.triggerSource,
      status: run.status,
      errorMessage: run.errorMessage || null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      totalEvents: run.events.length,
      latestEvent: run.events.length ? run.events[run.events.length - 1] : null,
    })),
  };
}

async function getAgentExecutionRun(agentSlug, runIdInput) {
  const agent = getAgentOrThrow(agentSlug);
  const workflow = resolveWorkflow(agent.workflow);
  const prisma = getPrisma(workflow);
  const runId = textOrEmpty(runIdInput);
  if (!runId) {
    const error = new Error("runId obrigatorio.");
    error.statusCode = 400;
    throw error;
  }

  const run = await prisma.agentExecutionRun.findFirst({
    where: {
      id: runId,
      workflow,
      agentSlug: agent.slug,
    },
    include: {
      events: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!run) {
    const error = new Error(`Execucao "${runId}" nao encontrada para agente "${agent.slug}".`);
    error.statusCode = 404;
    throw error;
  }

  return {
    id: run.id,
    workflow: run.workflow,
    agentSlug: run.agentSlug,
    provider: run.provider,
    conversationKey: run.conversationKey,
    phoneNumber: run.phoneNumber,
    triggerSource: run.triggerSource,
    status: run.status,
    errorMessage: run.errorMessage || null,
    inputPayload: run.inputPayload || null,
    outputPayload: run.outputPayload || null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    events: run.events.map((event) => ({
      id: event.id,
      stepKey: event.stepKey,
      title: event.title,
      nodeType: event.nodeType,
      status: event.status,
      payload: event.payload || null,
      createdAt: event.createdAt,
    })),
  };
}

module.exports = {
  listAgentConversations,
  getAgentConversationMessages,
  listAgentExecutionRuns,
  getAgentExecutionRun,
};
