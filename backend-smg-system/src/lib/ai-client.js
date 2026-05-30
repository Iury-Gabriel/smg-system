const env = require("../config/env");

function clipText(value, max = 2000) {
  const text = String(value || "");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...<truncated>` : text;
}

function safeJson(value, max = 4000) {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > max ? `${raw.slice(0, max)}...<truncated>` : raw;
  } catch (_error) {
    return "<unserializable_payload>";
  }
}

function logAi(level, event, payload = {}) {
  const stamp = new Date().toISOString();
  const line = `[ai-client][${stamp}][${event}]`;
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

function createAppError(message, statusCode = 500, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function extractResponseText(payload) {
  if (!payload) return "";

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const contentItem of contents) {
      const textValue =
        contentItem?.text ||
        contentItem?.output_text ||
        contentItem?.value ||
        "";
      if (typeof textValue === "string" && textValue.trim()) {
        return textValue.trim();
      }
    }
  }

  return "";
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (typeof item.text === "string") return item.text;
        if (typeof item.output_text === "string") return item.output_text;
        if (typeof item.value === "string") return item.value;
        return "";
      })
      .filter(Boolean);

    return parts.join("\n").trim();
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim();
    if (typeof content.output_text === "string") {
      return content.output_text.trim();
    }
  }

  return "";
}

function toSchemaObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function resolveApiKey(rawApiKey = "", options = {}) {
  const customApiKey = String(rawApiKey || "").trim();
  if (customApiKey) {
    return customApiKey;
  }

  if (options?.allowEnvFallback === false) {
    return "";
  }

  return String(env.openaiApiKey || "").trim();
}

function buildFieldSchema(z, fieldConfig = {}) {
  const type = String(fieldConfig.type || "string").toLowerCase();
  let schema = null;

  if (type === "number") {
    schema = z.coerce.number();
    if (fieldConfig.min !== undefined) {
      schema = schema.min(Number(fieldConfig.min));
    }
    if (fieldConfig.max !== undefined) {
      schema = schema.max(Number(fieldConfig.max));
    }
  } else if (type === "boolean") {
    schema = z.coerce.boolean();
  } else {
    schema = z.coerce.string();
    if (fieldConfig.minLength !== undefined) {
      schema = schema.min(Number(fieldConfig.minLength));
    }
    if (fieldConfig.maxLength !== undefined) {
      schema = schema.max(Number(fieldConfig.maxLength));
    }
  }

  if (fieldConfig.description) {
    schema = schema.describe(String(fieldConfig.description));
  }

  if (fieldConfig.required === false) {
    schema = schema.optional();
  }

  return schema;
}

function buildToolSchema(z, schemaConfig) {
  const fields = toSchemaObject(schemaConfig);
  const shape = {};

  for (const [fieldName, fieldConfig] of Object.entries(fields)) {
    shape[fieldName] = buildFieldSchema(z, toSchemaObject(fieldConfig));
  }

  return z.object(shape);
}

async function generateAiReplyWithLangChain({
  systemPrompt,
  userPrompt,
  fallbackReply,
  strictNoFallback = true,
  apiKey = "",
  allowEnvFallback = true,
  model = "",
  toolsConfig = {},
  externalTools = [],
  onHumanHandoff,
}) {
  logAi("info", "langchain.request.start", {
    explanation: "Inicio de requisicao para IA via LangChain.",
    model: String(model || env.openaiModel || "gpt-4o-mini").trim(),
    hasApiKey: Boolean(String(apiKey || "").trim() || String(env.openaiApiKey || "").trim()),
    toolsEnabled: Array.isArray(externalTools) ? externalTools.map((tool) => tool?.name) : [],
    systemPrompt: clipText(systemPrompt, 1200),
    userPrompt: clipText(userPrompt, 1200),
  });

  const resolvedApiKey = resolveApiKey(apiKey, { allowEnvFallback });
  if (!resolvedApiKey) {
    if (strictNoFallback) {
      throw createAppError(
        "OPENAI_API_KEY ausente. Modo estrito ativo: fallback local bloqueado.",
        503,
        {
          source: "langchain",
          reason: "missing_api_key",
          strictNoFallback: true,
        }
      );
    }
    logAi("warn", "langchain.request.fallback_no_key", {
      explanation: "Fallback acionado porque nao existe chave de API para LangChain.",
    });
    return {
      text: fallbackReply,
      model: null,
      usedFallback: true,
      usedLangChain: true,
      handoffTriggered: false,
      handoffReason: null,
      usedTools: [],
    };
  }

  const { ChatOpenAI } = await import("@langchain/openai");
  const { DynamicStructuredTool } = await import("@langchain/core/tools");
  const { HumanMessage, SystemMessage, ToolMessage } = await import(
    "@langchain/core/messages"
  );
  const { z } = await import("zod");

  const modelName = String(model || env.openaiModel || "gpt-4o-mini").trim();
  const usedTools = [];
  let handoffTriggered = false;
  let handoffReason = null;

  const modelClient = new ChatOpenAI({
    apiKey: resolvedApiKey,
    model: modelName,
    temperature: 0.2,
    ...(env.openaiBaseUrl
      ? {
          configuration: {
            baseURL: env.openaiBaseUrl,
          },
        }
      : {}),
  });

  const tools = [];

  if (Boolean(toolsConfig?.humanHandoffEnabled)) {
    const transferToHumanTool = new DynamicStructuredTool({
      name: "transfer_to_human",
      description:
        "Use esta tool quando o cliente pedir para falar com humano ou quando voce nao souber responder com seguranca.",
      schema: z.object({
        reason: z
          .string()
          .min(3)
          .max(500)
          .describe("Motivo da transferencia para humano"),
      }),
      func: async ({ reason }) => {
        handoffTriggered = true;
        handoffReason = String(reason || "Solicitacao do cliente");

        if (typeof onHumanHandoff === "function") {
          await onHumanHandoff({
            reason: handoffReason,
          });
        }

        return JSON.stringify({
          success: true,
          transferred: true,
          reason: handoffReason,
        });
      },
    });

    tools.push(transferToHumanTool);
  }

  const normalizedExternalTools = Array.isArray(externalTools)
    ? externalTools
    : [];

  for (const externalToolConfig of normalizedExternalTools) {
    const toolName = String(externalToolConfig?.name || "").trim();
    if (!toolName) {
      continue;
    }

    const toolDescription = String(
      externalToolConfig?.description || "Tool externa"
    ).trim();
    const toolHandler =
      typeof externalToolConfig?.handler === "function"
        ? externalToolConfig.handler
        : null;

    if (!toolHandler) {
      continue;
    }

    const schema = buildToolSchema(z, externalToolConfig?.schema || {});
    const externalTool = new DynamicStructuredTool({
      name: toolName,
      description: toolDescription,
      schema,
      func: async (input) => {
        const result = await toolHandler(input || {});
        if (typeof result === "string") {
          return result;
        }
        return JSON.stringify(result);
      },
    });

    tools.push(externalTool);
  }

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const modelWithTools = tools.length > 0 ? modelClient.bindTools(tools) : modelClient;

  const messages = [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)];

  for (let step = 0; step < 4; step += 1) {
    const aiMessage = await modelWithTools.invoke(messages);
    messages.push(aiMessage);

    const toolCalls = Array.isArray(aiMessage.tool_calls) ? aiMessage.tool_calls : [];

    if (toolCalls.length === 0) {
      let text = normalizeMessageContent(aiMessage.content);

      if (!text && handoffTriggered) {
        text = "Entendi. Vou transferir seu atendimento para um humano agora.";
      }

      if (!text) {
        if (strictNoFallback) {
          throw createAppError(
            "LangChain retornou resposta vazia. Modo estrito ativo: fallback bloqueado.",
            502,
            {
              source: "langchain",
              reason: "empty_text",
              strictNoFallback: true,
            }
          );
        }
        return {
          text: fallbackReply,
          model: modelName,
          usedFallback: true,
          usedLangChain: true,
          handoffTriggered,
          handoffReason,
          usedTools,
        };
      }

      return {
        text,
        model: modelName,
        usedFallback: false,
        usedLangChain: true,
        handoffTriggered,
        handoffReason,
        usedTools,
      };
    }

    for (const call of toolCalls) {
      const toolName = String(call?.name || "unknown_tool");
      usedTools.push(toolName);

      const targetTool = toolMap.get(toolName);
      const argsObject = call?.args && typeof call.args === "object" ? call.args : {};

      let toolResult = "";
      if (!targetTool) {
        toolResult = JSON.stringify({
          success: false,
          message: `Tool nao encontrada: ${toolName}`,
        });
      } else {
        try {
          toolResult = await targetTool.invoke(argsObject);
        } catch (error) {
          console.error("[ai][tool.error]", {
            toolName,
            args: argsObject,
            message: error?.message || "unknown",
            stack: error?.stack || null,
          });
          toolResult = JSON.stringify({
            success: false,
            message: error?.message || "Falha na execucao da tool.",
          });
        }
      }

      messages.push(
        new ToolMessage({
          content:
            typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
          tool_call_id: call?.id || call?.tool_call_id || `${toolName}-${Date.now()}`,
        })
      );
    }
  }

  if (strictNoFallback) {
    throw createAppError(
      "LangChain excedeu o limite de iteracoes sem resposta final. Modo estrito ativo.",
      502,
      {
        source: "langchain",
        reason: "max_iterations_reached",
        strictNoFallback: true,
      }
    );
  }

  return {
    text: handoffTriggered
      ? "Entendi. Vou transferir seu atendimento para um humano agora."
      : fallbackReply,
    model: modelName,
    usedFallback: true,
    usedLangChain: true,
    handoffTriggered,
    handoffReason,
    usedTools,
  };
}

async function generateAiReply({
  systemPrompt,
  userPrompt,
  fallbackReply = "Recebi sua mensagem. Ja vou te responder com mais detalhes.",
  strictNoFallback = true,
  useLangChain = false,
  apiKey = "",
  allowEnvFallback = true,
  model = "",
  toolsConfig = null,
  externalTools = [],
  onHumanHandoff = null,
}) {
  logAi("info", "request.start", {
    explanation: "Inicio da geracao de resposta da IA.",
    mode: useLangChain ? "langchain" : "responses_api",
    model: String(model || env.openaiModel || "gpt-4o-mini").trim(),
    allowEnvFallback: Boolean(allowEnvFallback),
    externalTools: Array.isArray(externalTools) ? externalTools.map((tool) => tool?.name) : [],
    systemPrompt: clipText(systemPrompt, 1200),
    userPrompt: clipText(userPrompt, 1200),
  });

  const resolvedApiKey = resolveApiKey(apiKey, { allowEnvFallback });
  if (!resolvedApiKey) {
    if (strictNoFallback) {
      throw createAppError(
        "OPENAI_API_KEY ausente. Modo estrito ativo: fallback local bloqueado.",
        503,
        {
          source: useLangChain ? "langchain" : "responses_api",
          reason: "missing_api_key",
          strictNoFallback: true,
        }
      );
    }
    logAi("warn", "request.fallback_no_key", {
      explanation: "Fallback acionado porque nao existe chave de API configurada.",
    });
    return {
      text: fallbackReply,
      model: null,
      usedFallback: true,
      usedLangChain: Boolean(useLangChain),
      handoffTriggered: false,
      handoffReason: null,
      usedTools: [],
    };
  }

  if (useLangChain) {
    try {
      const result = await generateAiReplyWithLangChain({
        systemPrompt,
        userPrompt,
        fallbackReply,
        strictNoFallback,
        apiKey: resolvedApiKey,
        allowEnvFallback,
        model,
        toolsConfig: toolsConfig || {},
        externalTools: Array.isArray(externalTools) ? externalTools : [],
        onHumanHandoff,
      });

      logAi("info", "langchain.request.success", {
        explanation: "Resposta da IA gerada com sucesso via LangChain.",
        model: result?.model || null,
        usedFallback: Boolean(result?.usedFallback),
        handoffTriggered: Boolean(result?.handoffTriggered),
        handoffReason: result?.handoffReason || null,
        usedTools: Array.isArray(result?.usedTools) ? result.usedTools : [],
        responseText: clipText(result?.text, 1200),
      });
      return result;
    } catch (error) {
      logAi("error", "langchain.request.error", {
        explanation: "Falha na geracao de resposta via LangChain.",
        message: error?.message || "unknown",
        details: safeJson(error?.details || null),
      });
      throw createAppError(
        error?.message || "Falha ao processar resposta com LangChain.",
        502,
        {
          source: "langchain",
          details: error?.details || null,
        }
      );
    }
  }

  const selectedModel = String(model || env.openaiModel || "gpt-4o-mini").trim();
  const base = String(env.openaiBaseUrl || "https://api.openai.com/v1").replace(
    /\/+$/,
    ""
  );
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolvedApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: selectedModel,
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    }),
  });

  const payload = await parseJsonSafe(response);
  logAi(response.ok ? "info" : "warn", "responses_api.http_response", {
    explanation: "Resposta HTTP da OpenAI Responses API.",
    status: response.status,
    payload: safeJson(payload),
  });
  if (!response.ok) {
    throw createAppError(
      payload?.error?.message || "Falha ao processar resposta com IA.",
      502,
      payload
    );
  }

  const text = extractResponseText(payload);
  if (!text) {
    if (strictNoFallback) {
      throw createAppError(
        "OpenAI Responses API retornou texto vazio. Modo estrito ativo: fallback bloqueado.",
        502,
        {
          source: "responses_api",
          reason: "empty_text",
          strictNoFallback: true,
          payload,
        }
      );
    }
    logAi("warn", "responses_api.empty_text_fallback", {
      explanation: "Resposta sem texto, fallback acionado.",
      model: selectedModel,
    });
    return {
      text: fallbackReply,
      model: selectedModel,
      usedFallback: true,
      usedLangChain: false,
      handoffTriggered: false,
      handoffReason: null,
      usedTools: [],
    };
  }

  logAi("info", "responses_api.success", {
    explanation: "Resposta da IA gerada com sucesso via Responses API.",
    model: selectedModel,
    responseText: clipText(text, 1200),
  });

  return {
    text,
    model: selectedModel,
    usedFallback: false,
    usedLangChain: false,
    handoffTriggered: false,
    handoffReason: null,
    usedTools: [],
  };
}

module.exports = {
  generateAiReply,
};
