const { LeadSegment } = require("@prisma/client");

const SEGMENT_KEYWORDS = [
  { segment: LeadSegment.dentista, words: ["dentista", "odont"] },
  { segment: LeadSegment.nutricionista, words: ["nutri"] },
  { segment: LeadSegment.fisioterapeuta, words: ["fisio", "reabilit"] },
  { segment: LeadSegment.dermatologista, words: ["dermato"] },
  { segment: LeadSegment.ortopedista, words: ["ortoped"] },
  {
    segment: LeadSegment.barbearia,
    words: ["barbear", "barber", "salao", "salon", "cabelo", "hair"],
  },
  { segment: LeadSegment.estetica, words: ["estet", "laser", "depil"] },
  { segment: LeadSegment.corretor, words: ["imob", "corret", "creci"] },
  { segment: LeadSegment.restaurante, words: ["restaurante", "pizza", "hamburg", "delivery"] },
  { segment: LeadSegment.automovel, words: ["concession", "veicul", "moto", "carro", "peca"] },
  {
    segment: LeadSegment.construtora,
    words: ["construtora", "construcao civil", "empreendimento", "obra", "edificacao"],
  },
  {
    segment: LeadSegment.engenharia,
    words: ["engenharia", "engenheiro", "engenharia civil", "projeto estrutural"],
  },
  {
    segment: LeadSegment.arquitetura,
    words: ["arquitetura", "arquiteto", "escritorio de arquitetura", "projeto arquitetonico"],
  },
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return "";
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 255);
}

function normalizePhoneE164(rawValue) {
  const digits = String(rawValue || "").replace(/[^\d]/g, "");
  if (!digits) return null;

  let payload = digits;
  if (payload.startsWith("0")) {
    payload = payload.replace(/^0+/, "");
  }

  if (payload.startsWith("55")) {
    if (payload.length === 12 || payload.length === 13) {
      return `+${payload}`;
    }
    return null;
  }

  if (payload.length === 10 || payload.length === 11) {
    return `+55${payload}`;
  }

  return null;
}

function mapSegment(segmentoBruto, fallbackSegment = LeadSegment.outro) {
  const normalized = normalizeText(segmentoBruto).toLowerCase();
  if (!normalized) return fallbackSegment || LeadSegment.outro;

  for (const item of SEGMENT_KEYWORDS) {
    if (item.words.some((word) => normalized.includes(word))) {
      return item.segment;
    }
  }

  if (Object.values(LeadSegment).includes(fallbackSegment)) {
    return fallbackSegment;
  }

  return LeadSegment.outro;
}

function normalizeLeadShape(rawLead, fallbackSegment) {
  const nome = toTitleCase(rawLead.nome || rawLead.empresa || "");
  const empresa = toTitleCase(rawLead.empresa || rawLead.nome || "");
  const endereco = normalizeText(rawLead.endereco || "");
  const site = String(rawLead.site || "").trim() || null;
  const email = String(rawLead.email || "")
    .trim()
    .toLowerCase() || null;

  return {
    nome,
    empresa,
    endereco,
    telefone: normalizePhoneE164(rawLead.telefoneBruto || rawLead.telefone),
    segmento: mapSegment(rawLead.segmentoBruto, fallbackSegment),
    site,
    email,
    fonte: rawLead.fonte,
    dadosBrutos: rawLead.dadosBrutos || rawLead,
  };
}

module.exports = {
  normalizeText,
  toTitleCase,
  normalizePhoneE164,
  mapSegment,
  normalizeLeadShape,
};
