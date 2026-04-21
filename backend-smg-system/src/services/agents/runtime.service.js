const {
  listAgents,
  getAgentOrThrow,
  getAgentProviderConfig,
  serializeAgent,
} = require("./registry.service");
const { normalizeProvider, textOrEmpty } = require("./helpers");
const {
  parseMetaVerificationQuery,
  parseMetaInboundPayload,
} = require("./parsers/meta.parser");
const { parseUazapiInboundPayload } = require("./parsers/uazapi.parser");
const { sendMetaTextMessage } = require("./providers/meta.provider");
const { sendUazapiTextMessage } = require("./providers/uazapi.provider");
const {
  isAiOrchestratorEnabled,
  queueInboundForOrchestrator,
} = require("./orchestrator.service");
const {
  createExecutionRun,
  appendExecutionEvent,
  finishExecutionRun,
} = require("./execution-tracker.service");
const env = require("../../config/env");

function logAgent(level, event, payload = {}) {
  const stamp = new Date().toISOString();
  const line = `[agents][${stamp}][${event}]`;
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

function safeJson(value, max = 7000) {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > max ? `${raw.slice(0, max)}...<truncated>` : raw;
  } catch (_error) {
    return "<unserializable_payload>";
  }
}

function assertProviderOrThrow(providerInput) {
  const provider = normalizeProvider(providerInput);
  if (!provider) {
    const error = new Error("Provider invalido. Use meta ou uazapi.");
    error.statusCode = 400;
    throw error;
  }
  return provider;
}

function verifyUazapiWebhookSecret(providerConfig, headers = {}) {
  const expected = textOrEmpty(providerConfig?.webhookSecret);
  if (!expected) {
    return {
      valid: true,
      reason: "secret_not_configured",
    };
  }

  const received =
    textOrEmpty(headers?.["x-webhook-secret"]) ||
    textOrEmpty(headers?.["x-uazapi-secret"]) ||
    textOrEmpty(headers?.["x-agent-secret"]);

  if (!received || received !== expected) {
    return {
      valid: false,
      reason: "invalid_webhook_secret",
    };
  }

  return {
    valid: true,
    reason: "ok",
  };
}

function isMetaVerifyTokenValid(expected, received) {
  const expectedToken = textOrEmpty(expected);
  const receivedToken = textOrEmpty(received);

  if (!expectedToken) {
    return true;
  }

  return expectedToken === receivedToken;
}

async function verifyMetaWebhookChallenge(agentSlug, query = {}) {
  const agent = getAgentOrThrow(agentSlug);
  const { config: providerConfig } = getAgentProviderConfig(agent, "meta");
  const verifyToken = textOrEmpty(providerConfig?.verifyToken);
  const parsed = parseMetaVerificationQuery(query);

  if (parsed.mode !== "subscribe") {
    return {
      verified: false,
      statusCode: 400,
      reason: "invalid_mode",
    };
  }

  if (!parsed.challenge) {
    return {
      verified: false,
      statusCode: 400,
      reason: "missing_challenge",
    };
  }

  if (!isMetaVerifyTokenValid(verifyToken, parsed.verifyToken)) {
    return {
      verified: false,
      statusCode: 403,
      reason: "invalid_verify_token",
    };
  }

  return {
    verified: true,
    statusCode: 200,
    challenge: parsed.challenge,
    agentSlug: agent.slug,
  };
}

async function sendMessageForAgent({ agentSlug, provider: providerInput, to, text }) {
  const agent = getAgentOrThrow(agentSlug);
  const provider = assertProviderOrThrow(providerInput || agent.defaultProvider);
  const { config: providerConfig } = getAgentProviderConfig(agent, provider);

  if (!env.allowOutboundMessages) {
    logAgent("warn", "outbound.send.skipped", {
      explanation:
        "Envio outbound suprimido por configuracao global de somente recebimento.",
      agentSlug: agent.slug,
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

  logAgent("info", "outbound.send.request", {
    explanation:
      "Solicitacao de envio de mensagem outbound para provider de WhatsApp.",
    agentSlug: agent.slug,
    provider,
    to,
    textPreview: textOrEmpty(text).slice(0, 500),
  });

  if (provider === "meta") {
    const result = await sendMetaTextMessage(providerConfig, { to, text });
    logAgent("info", "outbound.send.response", {
      explanation: "Mensagem outbound enviada com sucesso via Meta.",
      agentSlug: agent.slug,
      provider,
      to,
      result: safeJson(result),
    });
    return result;
  }

  const result = await sendUazapiTextMessage(providerConfig, { to, text });
  logAgent("info", "outbound.send.response", {
    explanation: "Mensagem outbound enviada com sucesso via Uazapi.",
    agentSlug: agent.slug,
    provider,
    to,
    result: safeJson(result),
  });
  return result;
}

function buildAgentHandlerContext({ agent, event, inboundProvider }) {
  return {
    agent,
    event,
    inboundProvider,
    sendMessage: async ({ provider, to, text }) =>
      sendMessageForAgent({
        agentSlug: agent.slug,
        provider: provider || inboundProvider || agent.defaultProvider,
        to: to || event.from,
        text,
      }),
    log: (level, message, payload = {}) => {
      logAgent(level, "agent.handler", {
        agentSlug: agent.slug,
        message,
        ...payload,
      });
    },
  };
}

async function executeAgentHandler({ agent, event, inboundProvider }) {
  if (typeof agent.onInboundMessage !== "function") {
    return {
      handled: false,
      reason: "no_handler",
    };
  }

  return agent.onInboundMessage(buildAgentHandlerContext({ agent, event, inboundProvider }));
}

async function logExecutionEvent(workflow, runId, payload) {
  if (!runId) return;
  await appendExecutionEvent({
    workflow,
    runId,
    ...payload,
  }).catch(() => null);
}

async function processEventWithAgent({ agent, inboundProvider, event, execution = null }) {
  const workflow = agent.workflow;
  const runId = execution?.runId || null;

  await logExecutionEvent(workflow, runId, {
    stepKey: "event_received",
    title: "Evento recebido pelo runtime",
    nodeType: "trigger",
    status: "success",
    payload: {
      eventType: event.eventType,
      messageId: event.messageId || null,
      from: event.from || null,
      provider: inboundProvider,
    },
  });

  if (event.eventType !== "messages") {
    await logExecutionEvent(workflow, runId, {
      stepKey: "event_ignored_type",
      title: "Evento ignorado por tipo",
      nodeType: "condition",
      status: "warning",
      payload: { eventType: event.eventType },
    });
    return {
      handled: false,
      ignored: true,
      reason: "event_not_supported",
    };
  }

  if (event.fromMe) {
    await logExecutionEvent(workflow, runId, {
      stepKey: "event_ignored_from_me",
      title: "Evento ignorado (fromMe)",
      nodeType: "condition",
      status: "warning",
      payload: { fromMe: true },
    });
    return {
      handled: false,
      ignored: true,
      reason: "from_me_message",
    };
  }

  if (!event.from) {
    await logExecutionEvent(workflow, runId, {
      stepKey: "event_ignored_missing_sender",
      title: "Evento ignorado (sem remetente)",
      nodeType: "condition",
      status: "warning",
      payload: {},
    });
    return {
      handled: false,
      ignored: true,
      reason: "missing_sender",
    };
  }

  if (isAiOrchestratorEnabled(agent)) {
    await logExecutionEvent(workflow, runId, {
      stepKey: "orchestrator_start",
      title: "Orquestrador de IA iniciado",
      nodeType: "process",
      status: "info",
      payload: {
        from: event.from,
        to: event.to || null,
      },
    });
    const output = await queueInboundForOrchestrator({
      agent,
      inboundProvider,
      event,
      execution: execution || null,
    });
    await logExecutionEvent(workflow, runId, {
      stepKey: "orchestrator_result",
      title: "Resultado do orquestrador",
      nodeType: "process",
      status: output?.handled ? "success" : "warning",
      payload: {
        reason: output?.reason || null,
        buffered: Boolean(output?.buffered),
        pausedForHuman: Boolean(output?.pausedForHuman),
        waitSeconds: Number(output?.waitSeconds || 0) || null,
      },
    });
    return {
      handled: output.handled !== false,
      ignored: Boolean(output.ignored),
      reason: output.reason || null,
      buffered: Boolean(output.buffered),
      waitSeconds: Number(output.waitSeconds || 0) || null,
      pausedForHuman: Boolean(output.pausedForHuman),
      cleared: Boolean(output.cleared),
      conversationKey: output.conversationKey || null,
      sentCount: 0,
      sent: [],
    };
  }

  const handlerOutput = await executeAgentHandler({
    agent,
    event,
    inboundProvider,
  });

  const output = handlerOutput && typeof handlerOutput === "object" ? handlerOutput : {};
  const sent = [];

  if (Array.isArray(output.messages)) {
    await logExecutionEvent(workflow, runId, {
      stepKey: "handler_messages",
      title: "Handler retornou mensagens",
      nodeType: "process",
      status: "info",
      payload: {
        total: output.messages.length,
      },
    });
    for (const item of output.messages) {
      const provider = item?.provider || inboundProvider || agent.defaultProvider;
      const to = item?.to || event.from;
      const text = textOrEmpty(item?.text);
      if (!text) continue;
      const result = await sendMessageForAgent({
        agentSlug: agent.slug,
        provider,
        to,
        text,
      });
      if (!result?.suppressed) {
        sent.push(result);
      }
    }
  }

  const replyText = textOrEmpty(output.replyText);
  if (replyText) {
    await logExecutionEvent(workflow, runId, {
      stepKey: "handler_reply_text",
      title: "Handler retornou replyText",
      nodeType: "process",
      status: "info",
      payload: {},
    });
    const result = await sendMessageForAgent({
      agentSlug: agent.slug,
      provider: output.provider || inboundProvider || agent.defaultProvider,
      to: output.to || event.from,
      text: replyText,
    });
    if (!result?.suppressed) {
      sent.push(result);
    }
  }

  await logExecutionEvent(workflow, runId, {
    stepKey: "provider_send_complete",
    title: "Envio de mensagens concluido",
    nodeType: "process",
    status: "success",
    payload: {
      sentCount: sent.length,
    },
  });

  return {
    handled: output.handled !== false,
    ignored: false,
    reason: output.reason || null,
    buffered: false,
    waitSeconds: null,
    pausedForHuman: false,
    cleared: false,
    conversationKey: null,
    sentCount: sent.length,
    sent,
  };
}

function parseInboundByProvider(provider, payload) {
  if (provider === "meta") {
    return parseMetaInboundPayload(payload);
  }
  return parseUazapiInboundPayload(payload);
}

async function processInboundWebhook({ agentSlug, provider: providerInput, payload, headers = {} }) {
  const agent = getAgentOrThrow(agentSlug);
  const provider = assertProviderOrThrow(providerInput || agent.defaultProvider);
  const workflow = agent.workflow;
  const { config: providerConfig } = getAgentProviderConfig(agent, provider);

  logAgent("info", "webhook.received", {
    explanation:
      "Webhook recebido: este log mostra o payload bruto que chegou do provider antes do parser.",
    agentSlug: agent.slug,
    provider,
    workflow,
    headers: {
      userAgent: headers?.["user-agent"] || null,
      contentType: headers?.["content-type"] || null,
      xWebhookSecret: headers?.["x-webhook-secret"] ? "***" : null,
      xUazapiSecret: headers?.["x-uazapi-secret"] ? "***" : null,
      xAgentSecret: headers?.["x-agent-secret"] ? "***" : null,
    },
    payload: safeJson(payload),
  });

  if (provider === "uazapi") {
    const secretValidation = verifyUazapiWebhookSecret(providerConfig, headers);
    if (!secretValidation.valid) {
      const error = new Error("Webhook secret invalido para Uazapi.");
      error.statusCode = 403;
      throw error;
    }
  }

  const events = parseInboundByProvider(provider, payload);
  logAgent("info", "webhook.parsed_events", {
    explanation:
      "Resultado do parser do webhook: quantidade de eventos extraidos para processamento.",
    agentSlug: agent.slug,
    provider,
    parsedCount: Array.isArray(events) ? events.length : 0,
    eventsPreview: safeJson(
      (Array.isArray(events) ? events : []).map((event) => ({
        eventType: event?.eventType,
        messageId: event?.messageId || null,
        from: event?.from || null,
        to: event?.to || null,
        text: textOrEmpty(event?.text || "").slice(0, 300),
      }))
    ),
  });
  if (!Array.isArray(events) || events.length === 0) {
    return {
      accepted: false,
      ignored: true,
      reason: "no_event_found",
      agent: agent.slug,
      provider,
      processed: 0,
    };
  }

  const results = [];
  let sentCount = 0;

  for (const event of events) {
    let executionRun = null;
    try {
      logAgent("info", "webhook.event.start", {
        explanation: "Inicio do processamento de um evento extraido do webhook.",
        agentSlug: agent.slug,
        provider,
        event: {
          eventType: event?.eventType || null,
          messageId: event?.messageId || null,
          from: event?.from || null,
          to: event?.to || null,
          fromMe: Boolean(event?.fromMe),
          text: textOrEmpty(event?.text || "").slice(0, 300),
        },
      });

      executionRun = await createExecutionRun({
        workflow,
        agentSlug: agent.slug,
        provider,
        phoneNumber: event?.from || "",
        triggerSource: `webhook:${provider}`,
        inputPayload: {
          eventType: event?.eventType || null,
          messageId: event?.messageId || null,
          from: event?.from || null,
          to: event?.to || null,
          text: textOrEmpty(event?.text).slice(0, 500),
        },
      });

      const result = await processEventWithAgent({
        agent,
        inboundProvider: provider,
        event,
        execution: executionRun ? { runId: executionRun.id } : null,
      });
      sentCount += Number(result.sentCount || 0);
      results.push({
        eventType: event.eventType,
        messageId: event.messageId || null,
        from: event.from || null,
        ...result,
      });

      logAgent("info", "webhook.event.finish", {
        explanation: "Fim do processamento do evento extraido do webhook.",
        agentSlug: agent.slug,
        provider,
        messageId: event?.messageId || null,
        result: {
          handled: Boolean(result?.handled),
          ignored: Boolean(result?.ignored),
          reason: result?.reason || null,
          buffered: Boolean(result?.buffered),
          waitSeconds: result?.waitSeconds || null,
          conversationKey: result?.conversationKey || null,
          sentCount: Number(result?.sentCount || 0),
        },
      });

      if (executionRun?.id) {
        await finishExecutionRun({
          workflow,
          runId: executionRun.id,
          status: result?.handled ? "success" : "warning",
          outputPayload: {
            handled: Boolean(result?.handled),
            ignored: Boolean(result?.ignored),
            reason: result?.reason || null,
            buffered: Boolean(result?.buffered),
            conversationKey: result?.conversationKey || null,
            sentCount: Number(result?.sentCount || 0),
          },
        }).catch(() => null);
      }
    } catch (error) {
      logAgent("error", "inbound.event_failed", {
        agentSlug: agent.slug,
        provider,
        eventType: event.eventType,
        messageId: event.messageId || null,
        message: error?.message || "unknown",
      });
      results.push({
        eventType: event.eventType,
        messageId: event.messageId || null,
        from: event.from || null,
        handled: false,
        ignored: false,
        reason: "handler_error",
        error: error?.message || "unknown",
      });

      if (executionRun?.id) {
        await appendExecutionEvent({
          workflow,
          runId: executionRun.id,
          stepKey: "runtime_error",
          title: "Falha no processamento do evento",
          nodeType: "process",
          status: "error",
          payload: {
            message: error?.message || "unknown",
          },
        }).catch(() => null);

        await finishExecutionRun({
          workflow,
          runId: executionRun.id,
          status: "error",
          errorMessage: error?.message || "unknown",
          outputPayload: {
            handled: false,
            ignored: false,
            reason: "handler_error",
          },
        }).catch(() => null);
      }
    }
  }

  return {
    accepted: true,
    ignored: false,
    agent: agent.slug,
    provider,
    processed: events.length,
    sentCount,
    results,
  };
}

function listAgentsForApi(origin = "") {
  return listAgents().map((agent) => serializeAgent(agent, origin));
}

function getAgentForApi(agentSlug, origin = "") {
  const agent = getAgentOrThrow(agentSlug);
  return serializeAgent(agent, origin);
}

module.exports = {
  verifyMetaWebhookChallenge,
  processInboundWebhook,
  sendMessageForAgent,
  listAgentsForApi,
  getAgentForApi,
};
