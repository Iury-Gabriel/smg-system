#!/usr/bin/env node
/* eslint-disable no-console */
const http = require("http");
const crypto = require("crypto");

const args = new Set(process.argv.slice(2));
const keepData = args.has("--keep-data");
const useRealAi =
  args.has("--real-ai") ||
  String(process.env.E2E_USE_REAL_AI || "false").toLowerCase() === "true";
const workflow = "smg";
const agentSlug = "default-sdr";
const provider = "uazapi";
const mockPort = Number(process.env.E2E_UAZAPI_MOCK_PORT || 4899);
const mockToken = process.env.E2E_UAZAPI_TOKEN || "e2e-uazapi-token";

process.env.ALLOW_OUTBOUND_MESSAGES = "true";
process.env.WF2_ENABLE_OUTBOUND_START = "false";
process.env.AGENT_DEFAULT_SDR_BUFFER_SECONDS = "5";
if (!useRealAi) {
  process.env.OPENAI_API_KEY = "";
  process.env.AGENT_DEFAULT_SDR_OPENAI_API_KEY = "";
}
process.env.PUBLIC_WEBHOOK_BASE_URL =
  process.env.PUBLIC_WEBHOOK_BASE_URL || "http://localhost:3344";
process.env.AGENT_DEFAULT_SDR_UAZAPI_BASE_URL = `http://127.0.0.1:${mockPort}`;
process.env.AGENT_DEFAULT_SDR_UAZAPI_INSTANCE_TOKEN = mockToken;
process.env.AGENT_DEFAULT_SDR_UAZAPI_SEND_PATH = "/send/text";
process.env.UAZAPI_BASE_URL = `http://127.0.0.1:${mockPort}`;
process.env.UAZAPI_SEND_MESSAGE_PATH = "/send/text";
process.env.UAZAPI_SEND_MEDIA_PATH = "/send/media";

const { resolveWorkflow } = require("../src/config/workflows");
const { getPrisma, disconnectPrismaClients } = require("../src/lib/prisma");
const { getWorkflowTables } = require("../src/services/workflow-data-access.service");
const { createDiagnosticoFromPayload } = require("../src/services/wf2/wf2.service");
const { processInboundWebhook } = require("../src/services/agents/runtime.service");

function assertOrThrow(condition, message, details = null) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function normalizeDigits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildBrPhone(seed = "") {
  const suffix = String(seed || crypto.randomUUID().slice(0, 8)).replace(/[^\d]/g, "");
  const tail = suffix.padEnd(8, "7").slice(0, 8);
  return `+55119${tail}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonSafe(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (_error) {
    return {};
  }
}

function toEventPayload({ phone, text, messageId }) {
  return {
    EventType: "messages",
    message: {
      messageid: messageId,
      sender_pn: normalizeDigits(phone),
      receiver: "5511999999999",
      fromMe: false,
      text,
      senderName: "E2E Tester",
    },
  };
}

async function startUazapiMockServer(port, expectedToken) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = readJsonSafe(rawBody);
      requests.push({
        at: new Date().toISOString(),
        method: req.method,
        path: req.url || "",
        token: String(req.headers?.token || ""),
        body,
      });

      const status = String(req.headers?.token || "") === expectedToken ? 200 : 401;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: status === 200,
          id: `mock-${Date.now()}`,
          path: req.url || "",
        })
      );
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function filterOutboundRequests(requests, phone) {
  const normalized = normalizeDigits(phone);
  return requests.filter((item) => normalizeDigits(item?.body?.number) === normalized);
}

async function sendInbound({ phone, text, messageId }) {
  return processInboundWebhook({
    agentSlug,
    provider,
    payload: toEventPayload({ phone, text, messageId }),
    headers: {},
  });
}

async function cleanupScenarioData({ prisma, tables, phoneNumbers, tokens }) {
  const phones = phoneNumbers.map((item) => normalizeDigits(item));
  const leads = await tables.lead.findMany({
    where: {
      telefone: {
        in: phones
          .map((phone) => [phone, `+${phone}`])
          .flat(),
      },
    },
    select: { id: true },
  });
  const leadIds = leads.map((item) => item.id);

  if (leadIds.length) {
    await prisma.leadAutomacaoTimeline.deleteMany({
      where: { workflow, leadId: { in: leadIds } },
    });
    await prisma.analiseMaturidade.deleteMany({
      where: { workflow, leadId: { in: leadIds } },
    });
    await prisma.leadCrm.deleteMany({
      where: { workflow, leadId: { in: leadIds } },
    });
    await prisma.agentConversationMessage.deleteMany({
      where: { workflow, agentSlug, phoneNumber: { in: phones } },
    });
    await prisma.agentConversationSession.deleteMany({
      where: { workflow, agentSlug, phoneNumber: { in: phones } },
    });
    await prisma.agentExecutionEvent.deleteMany({
      where: {
        run: {
          workflow,
          agentSlug,
          phoneNumber: { in: phones },
        },
      },
    });
    await prisma.agentExecutionRun.deleteMany({
      where: { workflow, agentSlug, phoneNumber: { in: phones } },
    });
    await tables.lead.deleteMany({
      where: { id: { in: leadIds } },
    });
  }

  if (tokens.length) {
    await prisma.leadDiagnostico.deleteMany({
      where: {
        workflow,
        token: { in: tokens },
      },
    });
  }
}

async function run() {
  const resolvedWorkflow = resolveWorkflow(workflow);
  const prisma = getPrisma(resolvedWorkflow);
  const tables = getWorkflowTables(prisma, resolvedWorkflow);
  const mock = await startUazapiMockServer(mockPort, mockToken);

  const tokenList = [];
  const phoneForm = buildBrPhone();
  const phoneAi = buildBrPhone(String(Date.now()).slice(-8));

  try {
    console.log("[E2E] Iniciando cenario 1 (formulario -> analise imediata)...");

    const token = `SMG-E2E-${crypto.randomUUID().slice(0, 8)}`;
    tokenList.push(token);

    await createDiagnosticoFromPayload({
      workflow: resolvedWorkflow,
      token,
      phoneNumber: phoneForm,
      payload: {
        segmento: "saude",
        maiorDesafio: "perda de follow-up em leads quentes",
        urgencia: "alta",
      },
      leadPayload: {
        agentSlug,
        nome: "Lead E2E Formulario",
        empresa: "Empresa E2E Formulario",
        pipelineOrigin: "diagnostico_site",
        canalAquisicao: "inbound_site",
      },
    });

    const inboundFormResult = await sendInbound({
      phone: phoneForm,
      text: "preenchi o formulario e quero avancar",
      messageId: `e2e-form-${Date.now()}`,
    });

    const formEventResult = inboundFormResult?.results?.[0] || {};
    assertOrThrow(Boolean(inboundFormResult?.accepted), "Webhook do cenario 1 nao foi aceito.");
    assertOrThrow(
      formEventResult?.reason === "analysis_sent_after_form_match",
      "Cenario 1 nao disparou envio imediato da analise.",
      formEventResult
    );

    const formRequests = filterOutboundRequests(mock.requests, phoneForm);
    const formTexts = formRequests
      .filter((item) => item.path.includes("/send/text"))
      .map((item) => String(item?.body?.text || ""));
    const formMedia = formRequests.filter((item) => item.path.includes("/send/media"));

    assertOrThrow(formTexts.length >= 2, "Cenario 1 nao enviou os textos esperados.", formRequests);
    assertOrThrow(formMedia.length >= 1, "Cenario 1 nao enviou o PDF da analise.", formRequests);
    assertOrThrow(
      formTexts.some((text) => /eu sou a Clara/i.test(text)),
      "Cenario 1 nao enviou mensagem de apresentacao da Clara.",
      formTexts
    );
    assertOrThrow(
      formTexts.some((text) => /Acabei de te enviar a Analise/i.test(text)),
      "Cenario 1 nao enviou mensagem de follow-up da analise.",
      formTexts
    );

    const leadAfterForm = await tables.lead.findFirst({
      where: {
        telefone: {
          in: [normalizeDigits(phoneForm), `+${normalizeDigits(phoneForm)}`],
        },
      },
      orderBy: { criadoEm: "desc" },
    });

    assertOrThrow(leadAfterForm, "Lead do cenario 1 nao encontrado apos inbound.");
    assertOrThrow(
      String(leadAfterForm.status || "").toUpperCase() === "ANALISE_ENVIADA",
      "Lead do cenario 1 nao avancou para ANALISE_ENVIADA.",
      { status: leadAfterForm.status }
    );

    console.log("[E2E] Cenario 1 OK.");

    console.log("[E2E] Iniciando cenario 2 (sem formulario -> resposta via IA)...");

    const inboundAiResult = await sendInbound({
      phone: phoneAi,
      text: "oi, tudo bem? queria entender como voces podem me ajudar",
      messageId: `e2e-ai-${Date.now()}`,
    });
    const aiEventResult = inboundAiResult?.results?.[0] || {};

    assertOrThrow(Boolean(inboundAiResult?.accepted), "Webhook do cenario 2 nao foi aceito.");
    assertOrThrow(
      aiEventResult?.reason === "buffered",
      "Cenario 2 nao entrou no fluxo buffered da IA.",
      aiEventResult
    );

    await wait(10000);

    const aiRequests = filterOutboundRequests(mock.requests, phoneAi);
    const aiTexts = aiRequests
      .filter((item) => item.path.includes("/send/text"))
      .map((item) => String(item?.body?.text || "").trim())
      .filter(Boolean);
    assertOrThrow(aiTexts.length >= 1, "Cenario 2 nao enviou nenhuma resposta da IA.", aiRequests);

    const conversationKey = aiEventResult?.conversationKey || null;
    const aiPersistedMessages = conversationKey
      ? await prisma.agentConversationMessage.findMany({
          where: {
            workflow: resolvedWorkflow,
            agentSlug,
            conversationKey,
            role: "ai",
          },
          orderBy: { createdAt: "asc" },
        })
      : [];
    assertOrThrow(
      aiPersistedMessages.length >= 1,
      "Cenario 2 nao persistiu mensagens de IA na conversa.",
      { conversationKey }
    );

    const latestRun = conversationKey
      ? await prisma.agentExecutionRun.findFirst({
          where: {
            workflow: resolvedWorkflow,
            agentSlug,
            conversationKey,
            triggerSource: "buffer:flush",
          },
          orderBy: { createdAt: "desc" },
        })
      : null;

    console.log("");
    console.log("========== E2E PASS ==========");
    console.log(`Cenario 1 reason: ${formEventResult?.reason || "n/a"}`);
    console.log(`Cenario 1 outbound total: ${formRequests.length}`);
    console.log(`Cenario 2 reason: ${aiEventResult?.reason || "n/a"}`);
    console.log(`Cenario 2 outbound total: ${aiRequests.length}`);
    console.log(`Cenario 2 conversa: ${conversationKey || "n/a"}`);
    console.log(`Modo IA real: ${useRealAi ? "sim" : "nao (fallback local forçado)"}`);
    console.log(
      `Cenario 2 modelo/fallback: ${
        latestRun?.outputPayload
          ? JSON.stringify({
              model: latestRun.outputPayload?.model || null,
              usedFallback: Boolean(latestRun.outputPayload?.usedFallback),
            })
          : "n/a"
      }`
    );
    console.log("Texto IA (primeiro chunk):");
    console.log(aiTexts[0] || "(vazio)");
    console.log("================================");
  } finally {
    if (!keepData) {
      await cleanupScenarioData({
        prisma,
        tables,
        phoneNumbers: [phoneForm, phoneAi],
        tokens: tokenList,
      }).catch(() => null);
    }
    await mock.close().catch(() => null);
    await disconnectPrismaClients().catch(() => null);
  }
}

run().catch((error) => {
  console.error("");
  console.error("========== E2E FAIL ==========");
  console.error(error?.message || "Erro desconhecido.");
  if (error?.details) {
    console.error("Detalhes:", JSON.stringify(error.details, null, 2));
  }
  console.error("================================");
  disconnectPrismaClients()
    .catch(() => null)
    .finally(() => {
      process.exit(1);
    });
});
