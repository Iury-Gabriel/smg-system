const fs = require("fs");
const path = require("path");
const { textOrEmpty } = require("./helpers");

const MAX_CHUNK_SIZE = 1200;
const DEFAULT_MAX_CONTEXT_CHARS = 4200;
const DEFAULT_MAX_ITEMS = 5;
const MAX_CHUNKS_PER_SOURCE = 2;
const corpusCache = new Map();

const STOPWORDS = new Set([
  "a",
  "o",
  "as",
  "os",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "ou",
  "em",
  "no",
  "na",
  "nos",
  "nas",
  "um",
  "uma",
  "para",
  "por",
  "com",
  "sem",
  "que",
  "se",
  "ao",
  "aos",
  "nao",
  "sua",
  "seu",
  "suas",
  "seus",
  "como",
  "mais",
  "menos",
  "ser",
  "estar",
  "esta",
  "esse",
  "essa",
  "isso",
  "ele",
  "ela",
  "eles",
  "elas",
  "eu",
  "voce",
  "voces",
  "nos",
  "nossa",
  "nosso",
  "nossas",
  "nossos",
  "lhe",
  "sao",
]);

const SEGMENT_KEYWORDS = {
  saude: [
    "saude",
    "dentista",
    "nutricionista",
    "fisioterapeuta",
    "dermatologista",
    "ortopedista",
    "clinica",
    "consulta",
    "paciente",
    "retorno",
  ],
  barbearia: [
    "barbearia",
    "barbeiro",
    "salao",
    "beleza",
    "cadeira",
    "ocupacao",
    "reativacao",
    "movimento",
  ],
  estetica: [
    "estetica",
    "esteticista",
    "procedimento",
    "protocolo",
    "sessao",
    "laser",
    "peeling",
    "drenagem",
  ],
  corretor: [
    "corretor",
    "imovel",
    "imobiliaria",
    "visita",
    "proposta",
    "plantao",
    "fechamento",
    "carteira",
  ],
  restaurante: [
    "restaurante",
    "mesa",
    "reserva",
    "ocupacao",
    "ticket",
    "delivery",
    "cozinha",
    "insumo",
    "salao",
  ],
};

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(/[^a-z0-9_]+/g)
    .map((item) => item.trim())
    .filter((item) => item && item.length > 1 && !STOPWORDS.has(item));
}

function pickSegmentKeywords(segment) {
  const normalized = normalizeText(segment);
  if (!normalized) return [];
  if (
    normalized.includes("dentista") ||
    normalized.includes("nutricionista") ||
    normalized.includes("fisioterapeuta") ||
    normalized.includes("dermatologista") ||
    normalized.includes("ortopedista") ||
    normalized.includes("saude")
  ) {
    return SEGMENT_KEYWORDS.saude;
  }
  if (normalized.includes("barbearia") || normalized.includes("salao")) {
    return SEGMENT_KEYWORDS.barbearia;
  }
  if (normalized.includes("estetica")) {
    return SEGMENT_KEYWORDS.estetica;
  }
  if (normalized.includes("corretor") || normalized.includes("imovel") || normalized.includes("imobiliaria")) {
    return SEGMENT_KEYWORDS.corretor;
  }
  if (normalized.includes("restaurante")) {
    return SEGMENT_KEYWORDS.restaurante;
  }
  return [];
}

function readDirRecursive(targetDir) {
  if (!fs.existsSync(targetDir)) return [];
  const results = [];
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readDirRecursive(fullPath));
      continue;
    }
    results.push(fullPath);
  }
  return results;
}

function buildChunkId(sourceId, index) {
  return `${sourceId}#${index + 1}`;
}

function splitDocumentIntoChunks(sourceId, content) {
  const text = String(content || "").trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const chunks = [];
  let current = "";
  let currentHeading = "";

  function pushChunk() {
    const normalized = current.trim();
    if (!normalized) return;
    const payload = currentHeading
      ? `${currentHeading}\n${normalized}`
      : normalized;
    chunks.push(payload.trim());
    current = "";
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading = /^#{1,6}\s+/.test(trimmed);

    if (isHeading) {
      pushChunk();
      currentHeading = trimmed;
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_CHUNK_SIZE) {
      pushChunk();
      current = line;
    } else {
      current = candidate;
    }
  }

  pushChunk();
  return chunks.map((chunkText, index) => ({
    id: buildChunkId(sourceId, index),
    sourceId,
    text: chunkText,
    tokens: new Set(tokenize(chunkText)),
  }));
}

function parseContextualLearnings(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        return {
          segmento: textOrEmpty(item.segmento).toLowerCase(),
          etapa: textOrEmpty(item.etapa).toUpperCase(),
          padrao: textOrEmpty(item.padrao),
          origem: textOrEmpty(item.origem || "manual"),
          tags: Array.isArray(item.tags)
            ? item.tags.map((tag) => textOrEmpty(tag).toLowerCase()).filter(Boolean)
            : [],
        };
      })
      .filter((item) => item && item.padrao);
  } catch (_error) {
    return [];
  }
}

function computeDirectorySignature(baseDir, files) {
  const payload = files
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      const rel = path.relative(baseDir, filePath).replace(/\\/g, "/");
      return `${rel}:${Number(stat.mtimeMs || 0)}`;
    })
    .sort()
    .join("|");
  return payload;
}

function loadAgentCorpus(agent) {
  const ragDir = path.join(agent?.directoryPath || "", "rag");
  if (!fs.existsSync(ragDir)) {
    return {
      ragDir,
      chunks: [],
      learnings: [],
    };
  }

  const files = readDirRecursive(ragDir).filter((filePath) => {
    if (!/\.(md|txt|text)$/i.test(filePath)) return false;
    const baseName = path.basename(filePath).toLowerCase();
    if (baseName === "readme.md") return false;
    return true;
  });
  const learningsFilePath = path.join(ragDir, "aprendizados_contextuais.json");
  const signature = computeDirectorySignature(ragDir, [
    ...files,
    ...(fs.existsSync(learningsFilePath) ? [learningsFilePath] : []),
  ]);
  const cacheKey = ragDir;
  const cached = corpusCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.payload;
  }

  const chunks = [];
  for (const filePath of files) {
    const sourceId = path.relative(ragDir, filePath).replace(/\\/g, "/");
    const content = fs.readFileSync(filePath, "utf8");
    chunks.push(...splitDocumentIntoChunks(sourceId, content));
  }

  const learnings = parseContextualLearnings(learningsFilePath);
  const payload = {
    ragDir,
    chunks,
    learnings,
  };
  corpusCache.set(cacheKey, {
    signature,
    payload,
  });
  return payload;
}

function scoreChunk(chunk, queryTokens, payload = {}) {
  if (!chunk || !chunk.tokens || !queryTokens.length) return 0;
  let score = 0;

  for (const token of queryTokens) {
    if (chunk.tokens.has(token)) {
      score += 1;
    }
  }

  const leadStatus = textOrEmpty(payload?.lead?.status).toLowerCase();
  const leadSegment = textOrEmpty(payload?.lead?.segmento).toLowerCase();
  const pipelineOrigin = textOrEmpty(payload?.lead?.pipeline_origin).toLowerCase();
  const etapaAtual = textOrEmpty(payload?.config?.etapa_atual).toLowerCase();
  const text = normalizeText(chunk.text);
  const source = normalizeText(chunk.sourceId);

  if (leadStatus && text.includes(leadStatus)) {
    score += 3;
  }
  if (leadSegment && text.includes(leadSegment)) {
    score += 3;
  }
  if (pipelineOrigin && text.includes(pipelineOrigin)) {
    score += 2;
  }
  if (etapaAtual && text.includes(`etapa ${etapaAtual}`)) {
    score += 2;
  }

  const tokenSet = new Set(queryTokens);
  const hasAny = (items) => items.some((item) => tokenSet.has(item));

  if (source.includes("bloco-03-classificacao-intencao")) {
    if (
      hasAny([
        "objecao",
        "objeção",
        "duvida",
        "duvida",
        "interesse",
        "intermediario",
        "opt",
        "optout",
        "classificacao",
      ])
    ) {
      score += 4;
    }
  }

  if (source.includes("bloco-04-qualificacao-bant-spin")) {
    if (
      hasAny([
        "bant",
        "spin",
        "budget",
        "authority",
        "need",
        "timing",
        "faturamento",
        "formulario",
        "urgencia",
        "decisor",
        "diagnostico",
      ])
    ) {
      score += 5;
    }
    const leadStatusUpper = String(payload?.lead?.status || "").toUpperCase();
    if (leadStatusUpper === "FORMULARIO_RESPONDIDO" || leadStatusUpper === "ANALISE_ENVIADA") {
      score += 2;
    }
  }

  if (source.includes("bloco-05-identificacao-decisor")) {
    if (
      hasAny([
        "decisor",
        "intermediario",
        "authority",
        "autoridade",
        "socio",
        "socio",
        "dono",
        "chefia",
        "chefe",
        "bifurcacao",
        "agendamento",
      ])
    ) {
      score += 5;
    }
    const leadStatusUpper = String(payload?.lead?.status || "").toUpperCase();
    if (
      leadStatusUpper === "DECISOR_IDENTIFICADO" ||
      leadStatusUpper === "INTERMEDIARIO_IDENTIFICADO" ||
      leadStatusUpper === "NOVO_LEAD"
    ) {
      score += 2;
    }
    if (etapaAtual === "2" || etapaAtual === "3") {
      score += 2;
    }
  }

  if (source.includes("bloco-06-estrutura-prompt-etapas")) {
    if (
      hasAny([
        "etapa",
        "funil",
        "outbound",
        "inbound",
        "formulario",
        "analise",
        "agendamento",
        "diagnostico",
        "novo_lead",
        "formulario_respondido",
        "analise_enviada",
      ])
    ) {
      score += 5;
    }
    const leadStatusUpper = String(payload?.lead?.status || "").toUpperCase();
    const etapa = String(payload?.config?.etapa_atual || "");
    if (
      [
        "NOVO_LEAD",
        "FORMULARIO_ENVIADO",
        "FORMULARIO_RESPONDIDO",
        "ANALISE_ENVIADA",
        "DIAGNOSTICO_AGENDADO",
      ].includes(leadStatusUpper)
    ) {
      score += 2;
    }
    if (["1", "2", "3", "4", "5", "6", "7", "8"].includes(etapa)) {
      score += 2;
    }
  }

  if (source.includes("bloco-07-diferenciacao-por-segmento")) {
    if (
      hasAny([
        "segmento",
        "vocabulario",
        "objecao",
        "dores",
        "urgencia",
        "gatilho",
        "tom",
        "calibracao",
      ])
    ) {
      score += 3;
    }

    const segmentKeywords = pickSegmentKeywords(leadSegment);
    if (segmentKeywords.length) {
      const queryHasSegmentWord = segmentKeywords.some((word) => tokenSet.has(word));
      const textHasSegmentWord = segmentKeywords.some((word) => text.includes(word));

      if (queryHasSegmentWord) score += 4;
      if (textHasSegmentWord) score += 4;
      if (queryHasSegmentWord && textHasSegmentWord) score += 3;
    }

    if (pipelineOrigin === "automacao") {
      score += 1;
    }
  }

  return score;
}

function buildQueryTokens(payload = {}, messages = []) {
  const formulario = payload?.formulario || {};
  const segments = [
    textOrEmpty(payload?.lead?.status),
    textOrEmpty(payload?.lead?.pipeline_origin),
    textOrEmpty(payload?.lead?.segmento),
    textOrEmpty(payload?.lead?.nome),
    textOrEmpty(payload?.lead?.empresa),
    textOrEmpty(formulario?.segmento),
    textOrEmpty(formulario?.maior_desafio),
    textOrEmpty(formulario?.urgencia),
    textOrEmpty(formulario?.ferramentas_usadas),
    textOrEmpty(formulario?.tentativa_anterior),
    textOrEmpty(formulario?.motivacao),
    textOrEmpty(formulario?.expectativa),
    textOrEmpty(payload?.config?.etapa_atual),
    textOrEmpty(payload?.conversation?.history_summary),
    ...((Array.isArray(messages) ? messages : []).map((item) => textOrEmpty(item?.text))),
  ].filter(Boolean);
  return tokenize(segments.join(" "));
}

function selectContextualLearnings(learnings, payload = {}, limit = 5) {
  const segment = textOrEmpty(payload?.lead?.segmento).toLowerCase();
  const status = textOrEmpty(payload?.lead?.status).toUpperCase();

  const ranked = (Array.isArray(learnings) ? learnings : [])
    .map((item) => {
      let score = 0;
      if (segment && item.segmento === segment) score += 4;
      if (segment && item.segmento === "all") score += 1;
      if (status && item.etapa === status) score += 4;
      if (item.etapa === "ALL") score += 1;
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, Math.max(1, Number(limit) || 5));
}

function buildLearningsBlock(learnings) {
  if (!Array.isArray(learnings) || !learnings.length) return "";
  const lines = learnings.map((item, index) => {
    const tags = Array.isArray(item.tags) && item.tags.length ? ` tags=${item.tags.join(",")}` : "";
    return `${index + 1}. segmento=${item.segmento || "all"} etapa=${item.etapa || "ALL"} origem=${item.origem || "manual"}${tags} | ${item.padrao}`;
  });
  return `Aprendizados contextuais relevantes:\n${lines.join("\n")}`;
}

function retrieveAgentRagContext({
  agent,
  payload = {},
  messages = [],
  maxItems = DEFAULT_MAX_ITEMS,
  maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
}) {
  const corpus = loadAgentCorpus(agent);
  const queryTokens = buildQueryTokens(payload, messages);
  const rankedChunks = corpus.chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(chunk, queryTokens, payload),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const selectedChunks = [];
  const selectedPerSource = new Map();
  let usedChars = 0;
  for (const chunk of rankedChunks) {
    if (selectedChunks.length >= Math.max(1, Number(maxItems) || DEFAULT_MAX_ITEMS)) break;
    const usedFromSource = Number(selectedPerSource.get(chunk.sourceId) || 0);
    if (usedFromSource >= MAX_CHUNKS_PER_SOURCE) continue;
    const chunkText = `[Fonte: ${chunk.sourceId}]\n${chunk.text}`;
    if (usedChars + chunkText.length > Math.max(800, Number(maxContextChars) || DEFAULT_MAX_CONTEXT_CHARS)) {
      continue;
    }
    usedChars += chunkText.length;
    selectedPerSource.set(chunk.sourceId, usedFromSource + 1);
    selectedChunks.push({
      id: chunk.id,
      sourceId: chunk.sourceId,
      score: chunk.score,
      text: chunk.text,
    });
  }

  const contextualLearnings = selectContextualLearnings(corpus.learnings, payload, 5);
  const learningsBlock = buildLearningsBlock(contextualLearnings);
  const chunksBlock = selectedChunks
    .map((item) => `[Fonte: ${item.sourceId}]\n${item.text}`)
    .join("\n\n");
  const contextText = [chunksBlock, learningsBlock].filter(Boolean).join("\n\n");

  return {
    contextText: textOrEmpty(contextText),
    chunks: selectedChunks,
    contextualLearnings,
  };
}

module.exports = {
  retrieveAgentRagContext,
};
