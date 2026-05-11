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

const GENERIC_COMPANY_CANDIDATES = [
  "home",
  "inicio",
  "pagina inicial",
  "site oficial",
  "official site",
  "empresa",
  "empresa de engenharia",
  "construtora",
  "arquitetura",
  "engenharia",
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCompanyName(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s|:;,./-]+|[\s|:;,./-]+$/g, "")
    .trim();

  if (!cleaned) return "";
  if (/^https?:\/\//i.test(cleaned) || /^www\./i.test(cleaned)) return "";

  const separators = [/\s*\|\s*/, /\s+::\s+/, /\s+\/\s+/, /\s+-\s+/];
  for (const separator of separators) {
    const parts = cleaned.split(separator);
    if (parts.length > 1 && parts[0].trim()) {
      return parts[0].trim().slice(0, 255);
    }
  }

  return cleaned.slice(0, 255);
}

function normalizeInstagramValue(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";

  if (/^https?:\/\/(?:www\.)?instagram\.com\//i.test(cleaned)) {
    return cleaned.replace(/\/+$/, "");
  }

  const handle = cleaned.replace(/^@+/, "");
  if (/^[A-Za-z0-9._-]{1,30}$/.test(handle)) {
    return `https://instagram.com/${handle}`;
  }

  return "";
}

function isGenericCompanyName(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return true;
  return GENERIC_COMPANY_CANDIDATES.some((candidate) => normalized === candidate);
}

function pickBestCompanyName(...candidates) {
  const cleanedCandidates = candidates
    .flat()
    .map((candidate) => cleanCompanyName(candidate))
    .filter(Boolean);

  const preferred = cleanedCandidates.find((candidate) => !isGenericCompanyName(candidate));
  if (preferred) return preferred;

  return cleanedCandidates[0] || "";
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

function normalizePhoneDigits(rawValue) {
  return String(rawValue || "").replace(/[^\d]/g, "");
}

function isPhoneWithAreaCode(phoneValue, areaCode = "11") {
  const digits = normalizePhoneDigits(phoneValue);
  if (!digits) return false;

  const normalized = digits.startsWith("55") ? digits.slice(2) : digits;
  return normalized.startsWith(String(areaCode)) && (normalized.length === 10 || normalized.length === 11);
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
  const empresa = pickBestCompanyName(
    rawLead.siteCompanyName,
    rawLead.empresa,
    rawLead.nome,
    rawLead.siteTitle,
    rawLead.siteOgTitle,
    rawLead.siteOgSiteName,
    Array.isArray(rawLead.siteH1) ? rawLead.siteH1[0] : rawLead.siteH1
  );
  const endereco = normalizeText(rawLead.endereco || "");
  const site = String(rawLead.site || "").trim() || null;
  const instagram = normalizeInstagramValue(
    rawLead.instagram ||
      rawLead.siteInstagram ||
      rawLead.siteInstagramUrl ||
      (Array.isArray(rawLead.instagramUrls) ? rawLead.instagramUrls[0] : "") ||
      (Array.isArray(rawLead.instagramHandles) ? rawLead.instagramHandles[0] : "")
  ) || null;
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
    instagram,
    email,
    fonte: rawLead.fonte,
    dadosBrutos: rawLead.dadosBrutos || rawLead,
  };
}

module.exports = {
  normalizeText,
  cleanCompanyName,
  normalizeInstagramValue,
  pickBestCompanyName,
  isGenericCompanyName,
  toTitleCase,
  normalizePhoneE164,
  normalizePhoneDigits,
  isPhoneWithAreaCode,
  mapSegment,
  normalizeLeadShape,
};
