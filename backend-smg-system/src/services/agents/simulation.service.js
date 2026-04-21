const fs = require("fs");
const env = require("../../config/env");
const { resolveWorkflow } = require("../../config/workflows");
const { getPrisma } = require("../../lib/prisma");
const { generateAiReply } = require("../../lib/ai-client");
const { textOrEmpty } = require("./helpers");
const { getAgentOrThrow } = require("./registry.service");

const SIMULATED_PROVIDER = "simulator";

const BASE_SCENARIOS = [
  {
    title: "Preco inicial para campanha",
    persona: "dono de clinica odontologica",
    business: "Clinica Sorriso Prime",
    opening: "Oi, boa tarde! Vi voces no Instagram. Quanto custa para captar pacientes novos?",
    humanFallbacks: [
      "Entendi. Em quanto tempo normalmente comeca a gerar resultado?",
      "Se eu fechar hoje, o que voces precisam de mim para iniciar?",
      "Perfeito. Pode me resumir os proximos passos em mensagem curta?",
    ],
    agentFallbacks: [
      "Boa tarde! Posso te explicar os planos e montar uma proposta alinhada ao seu momento. Quer me dizer seu objetivo principal e cidade?",
      "Normalmente comecamos com diagnostico e ajuste de oferta. Dependendo do nicho, os primeiros sinais aparecem nas primeiras semanas.",
      "Para iniciar, precisamos do briefing comercial e acesso basico de canais. Depois alinhamos cronograma e metas.",
    ],
  },
  {
    title: "Lead desconfiado de promessa",
    persona: "gestora de clinica de estetica",
    business: "Studio Pele Viva",
    opening: "Voces garantem resultado? Ja contratei agencia e nao veio nada.",
    humanFallbacks: [
      "Como voces evitam lead sem qualidade?",
      "Tem algum exemplo parecido com meu nicho?",
      "Qual seria um teste inicial sem compromisso longo?",
    ],
    agentFallbacks: [
      "Entendo sua preocupacao. Nao prometemos milagre, trabalhamos com processo e meta clara para reduzir risco.",
      "Filtramos publico, oferta e abordagem para aumentar qualidade dos contatos e diminuir curiosos.",
      "Podemos iniciar com um plano piloto de curto prazo para validar canal e mensagem.",
    ],
  },
  {
    title: "Urgencia para agenda vazia",
    persona: "fisioterapeuta autonomo",
    business: "Fisio Movimento",
    opening: "Minha agenda da semana que vem esta vazia, preciso encher rapido. Voces conseguem ajudar?",
    humanFallbacks: [
      "Qual canal voces usariam primeiro no meu caso?",
      "Eu consigo acompanhar isso sem ficar perdido?",
      "Se der certo, da para escalar para outras especialidades?",
    ],
    agentFallbacks: [
      "Sim, conseguimos montar uma acao rapida focada em conversao para as proximas semanas.",
      "Geralmente comecamos pelo canal com menor tempo de ativacao e melhor historico para servicos locais.",
      "Voce acompanha por relatorios simples e checkpoints curtos. Se validar, escalamos com seguranca.",
    ],
  },
  {
    title: "Objeccao de orcamento apertado",
    persona: "nutricionista de consultorio pequeno",
    business: "Nutri Equilibrio",
    opening: "Tenho verba curta, tipo bem limitada. Ainda assim faz sentido conversar?",
    humanFallbacks: [
      "Qual minimo para testar sem travar meu caixa?",
      "Tem como priorizar so um servico por enquanto?",
      "Como voces medem se vale a pena continuar?",
    ],
    agentFallbacks: [
      "Faz sentido sim. Podemos montar uma estrategia enxuta e valida-la por etapas.",
      "Com verba limitada, priorizamos um servico principal e uma oferta bem objetiva.",
      "Acompanhamos custo por lead e conversao para decidir rapidamente se continuamos ou ajustamos.",
    ],
  },
  {
    title: "Comparacao com concorrente",
    persona: "socio de escritorio de arquitetura",
    business: "Trazo Urbano Arquitetura",
    opening: "Recebi proposta de outra empresa tambem. Por que eu escolheria voces?",
    humanFallbacks: [
      "E no atendimento, como funciona no dia a dia?",
      "Quem vai tocar minha conta na pratica?",
      "Da para fazer uma reuniao curta ainda essa semana?",
    ],
    agentFallbacks: [
      "Boa pergunta. Nosso diferencial e combinar execucao com acompanhamento comercial real, nao so entrega de relatorio.",
      "Mantemos rotina objetiva, com responsavel definido e ajustes baseados em resultado de negocio.",
      "Posso te ajudar a agendar uma reuniao curta para comparar cenarios com transparencia.",
    ],
  },
  {
    title: "Dvida tecnica sobre CRM",
    persona: "coordenador comercial de clinica medica",
    business: "Centro Medico Horizonte",
    opening: "Voces integram com CRM? Sem isso complica pra gente.",
    humanFallbacks: [
      "Se nao integrar de cara, qual plano B voces sugerem?",
      "Conseguem padronizar tags e estagios do funil?",
      "Preciso envolver meu time de TI nesse inicio?",
    ],
    agentFallbacks: [
      "Trabalhamos com integracao quando o ambiente permite e tambem com fluxos intermediarios para nao travar operacao.",
      "No comeco, podemos operar com um processo simples e depois evoluir para integracao completa.",
      "Ajudamos a organizar etapas e nomenclatura de funil para facilitar acompanhamento do time.",
    ],
  },
  {
    title: "Lead frio pedindo prova social",
    persona: "empresaria de barbearia premium",
    business: "Barbearia Alfa Club",
    opening: "Nao te conheco ainda. Voces tem casos reais ou depoimentos?",
    humanFallbacks: [
      "Quero algo objetivo, sem enrolacao de agencia.",
      "Se eu topar, quando comecaria a primeira acao?",
      "Pode me mandar um resumo simples agora?",
    ],
    agentFallbacks: [
      "Totalmente valido pedir prova social. Posso compartilhar referencias e abordagem aplicada em negocios parecidos.",
      "Nosso foco e praticidade: plano curto, metas claras e ajustes rapidos com base em dados.",
      "A primeira acao pode iniciar apos alinhamento de oferta e publico, sem burocracia desnecessaria.",
    ],
  },
  {
    title: "Janela curta para promocao",
    persona: "gerente de clinica dermatologica",
    business: "Derma Plus",
    opening: "Tenho promocao so ate o fim do mes. Da tempo de rodar algo?",
    humanFallbacks: [
      "Qual seria o plano para essa janela curta?",
      "Como voces tratam resposta de leads fora de horario?",
      "Se eu aprovar hoje, quando comeca?",
    ],
    agentFallbacks: [
      "Da tempo, sim. Podemos montar uma acao focada em velocidade para aproveitar essa janela.",
      "Nesse cenario, simplificamos criativo e oferta para entrar em producao mais rapido.",
      "Aprovando hoje, ja organizamos briefing e etapa inicial de configuracao.",
    ],
  },
  {
    title: "Lead com dor de atendimento",
    persona: "dona de clinica de ortopedia",
    business: "Orto Vida",
    opening: "Meu problema nem e so gerar lead, e responder todo mundo. Voces ajudam nisso?",
    humanFallbacks: [
      "Quero evitar perder lead por demora no WhatsApp.",
      "Da para separar quem esta quente de quem so pediu informacao?",
      "Voces conseguem orientar meu time comercial tambem?",
    ],
    agentFallbacks: [
      "Sim, ajudamos bastante nesse ponto. A ideia e organizar fluxo de resposta e prioridade de atendimento.",
      "Podemos estruturar triagem para destacar contatos com maior intencao de fechamento.",
      "Tambem alinhamos rotina com o time comercial para manter consistencia no atendimento.",
    ],
  },
  {
    title: "Retorno de lead antigo",
    persona: "proprietario de restaurante regional",
    business: "Sabor da Serra",
    opening: "Falei com voces ha meses e parei. Agora quero voltar. Como recomecamos?",
    humanFallbacks: [
      "Da para reaproveitar algo do que eu tinha antes?",
      "Quero algo simples no inicio, sem muita complexidade.",
      "Me manda um passo a passo rapido para eu aprovar internamente.",
    ],
    agentFallbacks: [
      "Perfeito, vamos retomar de forma organizada e sem complicar. Primeiro revisamos objetivo atual.",
      "Se houver dados antigos, reaproveitamos o que fizer sentido para acelerar a retomada.",
      "Comecamos simples, validamos resultado e so depois adicionamos mais camadas.",
    ],
  },
];

function normalizeCount(value) {
  return Math.max(1, Math.min(Number(value) || 10, 25));
}

function normalizeTurns(value) {
  return Math.max(2, Math.min(Number(value) || 3, 6));
}

function randomDigits(length) {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += String(Math.floor(Math.random() * 10));
  }
  return output;
}

function buildPhoneNumber(index) {
  const dddPool = ["11", "21", "31", "41", "47", "51", "61", "71", "81", "85"];
  const ddd = dddPool[index % dddPool.length];
  return `55${ddd}9${randomDigits(8)}`;
}

function buildConversationKey(agentSlug, phoneNumber, index) {
  const stamp = Date.now();
  const sequence = String(index + 1).padStart(2, "0");
  return `simulator:${agentSlug}:${phoneNumber}:${stamp}-${sequence}`;
}

function loadAgentPromptText(agent) {
  const promptFile = textOrEmpty(agent?.promptFile);
  if (!promptFile) return "";

  try {
    return String(fs.readFileSync(promptFile, "utf8") || "").trim();
  } catch (_error) {
    return "";
  }
}

function formatTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "Sem historico.";
  }

  return messages
    .map((item, index) => {
      const role = item.role === "ai" ? "Agente" : "Cliente";
      return `${index + 1}. ${role}: ${String(item.content || "").trim()}`;
    })
    .join("\n");
}

function toShortText(value, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, 650);
}

function fallbackHumanTurn(scenario, turnIndex) {
  const fallback = scenario.humanFallbacks[turnIndex - 1] || scenario.humanFallbacks[scenario.humanFallbacks.length - 1];
  return toShortText(fallback, "Pode me explicar melhor como isso funciona na pratica?");
}

function fallbackAgentTurn(scenario, turnIndex) {
  const fallback = scenario.agentFallbacks[turnIndex] || scenario.agentFallbacks[scenario.agentFallbacks.length - 1];
  return toShortText(fallback, "Perfeito. Vamos seguir com um plano objetivo e alinhado ao seu contexto.");
}

async function generateHumanTurn({
  scenario,
  turnIndex,
  transcript,
  model,
  apiKey,
  useLangChain,
}) {
  const fallback = fallbackHumanTurn(scenario, turnIndex);
  const response = await generateAiReply({
    systemPrompt: [
      "Voce esta simulando um cliente humano em conversa de WhatsApp.",
      "Fale de forma natural, curta e objetiva.",
      "Nao use formato de lista, nao use emojis, nao aja como assistente.",
      "Seja coerente com seu contexto de negocio e com o historico recebido.",
    ].join("\n"),
    userPrompt: [
      `Contexto: ${scenario.title}.`,
      `Perfil: ${scenario.persona}. Negocio: ${scenario.business}.`,
      "Historico atual da conversa:",
      transcript,
      "Escreva apenas a proxima mensagem do cliente (uma unica mensagem).",
    ].join("\n\n"),
    fallbackReply: fallback,
    useLangChain,
    apiKey,
    allowEnvFallback: true,
    model,
  });

  if (response?.usedFallback) {
    return fallback;
  }

  return toShortText(response?.text, fallback);
}

async function generateAgentTurn({
  agent,
  scenario,
  turnIndex,
  transcript,
  model,
  apiKey,
  useLangChain,
  promptText,
}) {
  const fallback = fallbackAgentTurn(scenario, turnIndex);
  const response = await generateAiReply({
    systemPrompt: [
      "Voce e um agente comercial no WhatsApp.",
      "Responda com clareza, objetividade e tom consultivo.",
      "Nao invente informacoes e nao prometa resultados garantidos.",
      `Agente: ${textOrEmpty(agent?.name || agent?.slug || "agente")}.`,
      textOrEmpty(agent?.description) ? `Descricao: ${textOrEmpty(agent.description)}.` : "",
      promptText ? `Prompt base:\n${promptText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    userPrompt: [
      `Contexto de simulacao: ${scenario.title}.`,
      "Conversa ate agora:",
      transcript,
      "Escreva somente a proxima resposta do agente.",
    ].join("\n\n"),
    fallbackReply: fallback,
    useLangChain,
    apiKey,
    allowEnvFallback: true,
    model,
  });

  if (response?.usedFallback) {
    return {
      text: fallback,
      usedFallback: true,
    };
  }

  return {
    text: toShortText(response?.text, fallback),
    usedFallback: false,
  };
}

function buildScenarioAt(index) {
  const base = BASE_SCENARIOS[index % BASE_SCENARIOS.length];
  if (!base) return BASE_SCENARIOS[0];
  if (index < BASE_SCENARIOS.length) return base;

  const repeatNumber = Math.floor(index / BASE_SCENARIOS.length) + 1;
  return {
    ...base,
    title: `${base.title} (variante ${repeatNumber})`,
  };
}

async function runAgentConversationSimulation(agentSlug, options = {}) {
  const agent = getAgentOrThrow(agentSlug);
  const workflow = resolveWorkflow(agent.workflow);
  const prisma = getPrisma(workflow);
  const count = normalizeCount(options.count);
  const turns = normalizeTurns(options.turns);
  const model = textOrEmpty(env.openaiModel || "gpt-4o-mini");
  const apiKey = textOrEmpty(agent?.ai?.apiKey || env.openaiApiKey);
  const useLangChain = agent?.ai?.useLangChain !== false;
  const promptText = loadAgentPromptText(agent);
  const warnings = [];
  const generatedItems = [];
  let totalFallbackReplies = 0;

  for (let index = 0; index < count; index += 1) {
    const scenario = buildScenarioAt(index);
    const phoneNumber = buildPhoneNumber(index);
    const conversationKey = buildConversationKey(agent.slug, phoneNumber, index);
    const transcript = [];
    const persistedMessages = [];
    const conversationStartAt = new Date(Date.now() - (count - index) * 15 * 60 * 1000);

    for (let turnIndex = 0; turnIndex < turns; turnIndex += 1) {
      let humanMessage = "";
      if (turnIndex === 0) {
        humanMessage = toShortText(scenario.opening, "Oi, tudo bem?");
      } else {
        const historyText = formatTranscript(transcript);
        humanMessage = await generateHumanTurn({
          scenario,
          turnIndex,
          transcript: historyText,
          model,
          apiKey,
          useLangChain,
        });
      }

      const humanAt = new Date(conversationStartAt.getTime() + turnIndex * 2 * 60 * 1000);
      transcript.push({
        role: "human",
        content: humanMessage,
      });
      persistedMessages.push({
        workflow,
        agentSlug: agent.slug,
        provider: SIMULATED_PROVIDER,
        conversationKey,
        phoneNumber,
        role: "human",
        content: humanMessage,
        createdAt: humanAt,
      });

      const historyText = formatTranscript(transcript);
      const agentTurn = await generateAgentTurn({
        agent,
        scenario,
        turnIndex,
        transcript: historyText,
        model,
        apiKey,
        useLangChain,
        promptText,
      });

      if (agentTurn.usedFallback) {
        totalFallbackReplies += 1;
      }

      const aiAt = new Date(humanAt.getTime() + 45 * 1000);
      transcript.push({
        role: "ai",
        content: agentTurn.text,
      });
      persistedMessages.push({
        workflow,
        agentSlug: agent.slug,
        provider: SIMULATED_PROVIDER,
        conversationKey,
        phoneNumber,
        role: "ai",
        content: agentTurn.text,
        createdAt: aiAt,
      });
    }

    const lastMessageAt = persistedMessages[persistedMessages.length - 1]?.createdAt || new Date();

    await prisma.agentConversationSession.upsert({
      where: {
        workflow_agentSlug_conversationKey: {
          workflow,
          agentSlug: agent.slug,
          conversationKey,
        },
      },
      update: {
        provider: SIMULATED_PROVIDER,
        phoneNumber,
        aiPaused: false,
        pausedReason: null,
        pausedAt: null,
        lastMessageAt,
      },
      create: {
        workflow,
        agentSlug: agent.slug,
        provider: SIMULATED_PROVIDER,
        conversationKey,
        phoneNumber,
        aiPaused: false,
        lastMessageAt,
      },
    });

    await prisma.agentConversationMessage.createMany({
      data: persistedMessages,
    });

    generatedItems.push({
      conversationKey,
      phoneNumber,
      scenario: scenario.title,
      totalMessages: persistedMessages.length,
      lastMessageAt,
    });
  }

  if (!apiKey) {
    warnings.push("OPENAI_API_KEY nao configurada. Conversas foram geradas com fallback local.");
  } else if (totalFallbackReplies > 0) {
    warnings.push(
      `Algumas respostas usaram fallback local (${totalFallbackReplies}). Verifique limite/modelo da API.`
    );
  }

  return {
    workflow,
    agentSlug: agent.slug,
    generated: generatedItems.length,
    turns,
    warnings,
    items: generatedItems,
  };
}

module.exports = {
  runAgentConversationSimulation,
};
