const { randomUUID } = require("crypto");
const { DiscardReason, LeadSegment } = require("@prisma/client");
const env = require("../config/env");
const { WORKFLOW_BSB } = require("../config/workflows");
const {
  normalizeLeadShape,
  normalizeText,
  pickBestCompanyName,
  normalizePhoneE164,
  isPhoneWithAreaCode,
  isGenericCompanyName,
  normalizeInstagramValue,
} = require("./lead-normalizer.service");
const { scrapeWebsiteContacts } = require("./site-scraper.service");

function toDiscardReason(value, fallback = DiscardReason.erro_interno) {
  return Object.values(DiscardReason).includes(value) ? value : fallback;
}

async function registerDiscard({
  tables,
  fonte,
  motivoDescarte,
  telefoneTentativo,
  segmentoTentativo,
  dadosBrutos,
  mensagem,
}) {
  await tables.discard.create({
    data: {
      fonte,
      motivoDescarte: toDiscardReason(motivoDescarte),
      telefoneTentativo: telefoneTentativo || null,
      segmentoTentativo: segmentoTentativo || null,
      dadosBrutos: dadosBrutos || null,
      mensagem: mensagem || null,
    },
  });
}

function isInsideIcp(segment, activeSegments) {
  if (!segment || segment === LeadSegment.outro) return false;
  return activeSegments.has(segment);
}

function buildLeadLogContext(lead) {
  return {
    nome: lead?.nome || null,
    empresa: lead?.empresa || null,
    telefone: lead?.telefone || null,
    segmento: lead?.segmento || null,
    fonte: lead?.fonte || null,
    site: lead?.site || null,
    instagram: lead?.instagram || null,
  };
}

const BSB_FORBIDDEN_KEYWORDS = [
  "paisag",
  "design de interiores",
  "decoracao de interiores",
  "interiores",
];

const BSB_ALLOW_CONSTRUCTION_KEYWORDS = [
  "construtora",
  "construcao",
  "obra",
  "engenharia",
  "arquitet",
  "empreendimento",
];

const BSB_SITE_FIT_KEYWORDS = [
  "execucao de obras",
  "execução de obras",
  "gerenciamento de obras",
  "acompanhamento de obra",
  "acompanhamento de obras",
  "obra civil",
  "obras civis",
  "construcao civil",
  "construção civil",
  "construtora",
  "construtor",
  "engenharia",
  "engenheiro",
  "engenheira",
  "consultoria",
  "consultor",
  "consultora",
  "consultoria tecnica",
  "consultoria técnica",
  "projeto estrutural",
  "projeto arquitetonico",
  "projeto arquitetônico",
  "arquitetura",
  "arquiteto",
  "arquiteta",
  "urbanismo",
  "reforma",
  "reformas",
];

function shouldDiscardBsbLeadByForbiddenKeywords(rawLead, lead) {
  const searchable = [
    lead?.empresa,
    lead?.nome,
    lead?.endereco,
    rawLead?.segmentoBruto,
    rawLead?.descricao,
    rawLead?.description,
    rawLead?.dadosBrutos?.type,
    rawLead?.dadosBrutos?.description,
    rawLead?.dadosBrutos?.snippet,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean)
    .join(" | ");

  if (!searchable) return false;

  const mentionsOnlyIncorporadora =
    searchable.includes("incorporadora") &&
    !BSB_ALLOW_CONSTRUCTION_KEYWORDS.some((keyword) => searchable.includes(keyword));

  if (mentionsOnlyIncorporadora) {
    return true;
  }

  return BSB_FORBIDDEN_KEYWORDS.some((keyword) => searchable.includes(keyword));
}

function buildWebsiteSearchText(inspection = {}) {
  return [
    inspection.title,
    inspection.ogTitle,
    inspection.ogSiteName,
    inspection.description,
    ...(Array.isArray(inspection.h1) ? inspection.h1 : []),
    ...(Array.isArray(inspection.structuredNames) ? inspection.structuredNames : []),
    inspection.bodyText,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean)
    .join(" | ");
}

function isBsbSiteFit(inspection = {}) {
  const searchable = buildWebsiteSearchText(inspection);
  if (!searchable) return false;

  return BSB_SITE_FIT_KEYWORDS.some((keyword) =>
    searchable.includes(normalizeText(keyword).toLowerCase())
  );
}

function resolveBsbPhoneCandidate(rawLead, inspection = {}) {
  const candidates = [
    rawLead?.telefoneBruto,
    rawLead?.telefone,
    ...(Array.isArray(inspection.phones) ? inspection.phones : []),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = normalizePhoneE164(candidate);
    if (normalized && isPhoneWithAreaCode(normalized, "11")) {
      return candidate;
    }
  }

  return null;
}

async function enrichLeadFromWebsite(rawLead, workflowId) {
  if (workflowId === WORKFLOW_BSB) {
    return { ...rawLead, websiteInspection: null };
  }

  if (!env.enableWebsiteEnrichment || !rawLead.site) {
    return { ...rawLead, websiteInspection: null };
  }

  const inspection = await scrapeWebsiteContacts(rawLead.site);
  const websiteCompanyName = pickBestCompanyName(
    inspection.structuredNames,
    inspection.ogSiteName,
    inspection.ogTitle,
    inspection.title,
    inspection.h1
  );

  const nextLead = {
    ...rawLead,
    websiteInspection: inspection,
    siteTitle: inspection.title || "",
    siteDescription: inspection.description || "",
    siteH1: Array.isArray(inspection.h1) ? inspection.h1 : [],
    siteOgTitle: inspection.ogTitle || "",
    siteOgSiteName: inspection.ogSiteName || "",
    siteStructuredNames: Array.isArray(inspection.structuredNames) ? inspection.structuredNames : [],
    siteBodyText: inspection.bodyText || "",
    siteCompanyName: websiteCompanyName,
  };

  if (!nextLead.email && Array.isArray(inspection.emails) && inspection.emails.length > 0) {
    nextLead.email = inspection.emails[0];
  }

  if (!nextLead.instagram) {
    const instagramCandidate =
      (Array.isArray(inspection.instagramUrls) && inspection.instagramUrls[0]) ||
      (Array.isArray(inspection.instagramHandles) && inspection.instagramHandles[0]) ||
      "";
    const instagramFromSite = normalizeInstagramValue(instagramCandidate);
    if (instagramFromSite) {
      nextLead.instagram = instagramFromSite;
    }
  }

  if (workflowId === WORKFLOW_BSB) {
    const bsbPhoneCandidate = resolveBsbPhoneCandidate(rawLead, inspection);
    if (bsbPhoneCandidate) {
      nextLead.telefoneBruto = bsbPhoneCandidate;
    }
  } else if (!nextLead.telefone && Array.isArray(inspection.phones) && inspection.phones.length > 0) {
    nextLead.telefoneBruto = inspection.phones[0];
  }

  if (!nextLead.empresa || isGenericCompanyName(nextLead.empresa)) {
    nextLead.empresa = websiteCompanyName || nextLead.empresa;
  }

  return nextLead;
}

async function validateAndInsertLead({
  tables,
  workflowConfig,
  rawLead,
  fallbackSegment,
  activeSegments,
}) {
  const workflowId = workflowConfig?.id || "smg";
  const enrichedRawLead = await enrichLeadFromWebsite(rawLead, workflowId);
  let lead = normalizeLeadShape(enrichedRawLead, fallbackSegment);
  const requiresPhone = workflowId !== WORKFLOW_BSB;
  const websiteInspection = enrichedRawLead.websiteInspection || null;

  if (!lead.nome || lead.nome.length < 2) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.sem_nome,
      telefoneTentativo: rawLead.telefoneBruto || "",
      segmentoTentativo: rawLead.segmentoBruto || "",
      dadosBrutos: rawLead,
      mensagem: "Campo nome ausente ou invalido.",
    });
    return {
      approved: false,
      reason: DiscardReason.sem_nome,
      lead: buildLeadLogContext(lead),
    };
  }

  if (requiresPhone && !lead.telefone) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.telefone_formato_invalido,
      telefoneTentativo: rawLead.telefoneBruto || "",
      segmentoTentativo: rawLead.segmentoBruto || "",
      dadosBrutos: rawLead,
      mensagem: "Telefone nao convertido para formato E.164.",
    });
    return {
      approved: false,
      reason: DiscardReason.telefone_formato_invalido,
      lead: buildLeadLogContext(lead),
    };
  }

  if (!lead.empresa || lead.empresa.length < 2) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.sem_nome,
      telefoneTentativo: lead.telefone,
      segmentoTentativo: rawLead.segmentoBruto || "",
      dadosBrutos: rawLead,
      mensagem: "Campo empresa ausente ou invalido.",
    });
    return {
      approved: false,
      reason: DiscardReason.sem_nome,
      lead: buildLeadLogContext(lead),
    };
  }

  if (!lead.endereco || lead.endereco.length < 2) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.sem_endereco,
      telefoneTentativo: lead.telefone,
      segmentoTentativo: rawLead.segmentoBruto || "",
      dadosBrutos: rawLead,
      mensagem: "Endereco ausente.",
    });
    return {
      approved: false,
      reason: DiscardReason.sem_endereco,
      lead: buildLeadLogContext(lead),
    };
  }

  if (workflowId === WORKFLOW_BSB) {
    if (!lead.telefone || !isPhoneWithAreaCode(lead.telefone, "11")) {
      await registerDiscard({
        tables,
        fonte: lead.fonte,
        motivoDescarte: DiscardReason.numero_invalido_whatsapp,
        telefoneTentativo: lead.telefone || rawLead.telefoneBruto || "",
        segmentoTentativo: String(lead.segmento),
        dadosBrutos: rawLead,
        mensagem: "LDR BSB exige WhatsApp com DDD 11.",
      });
      return {
        approved: false,
        reason: DiscardReason.numero_invalido_whatsapp,
        lead: buildLeadLogContext(lead),
      };
    }

    if (!lead.empresa || isGenericCompanyName(lead.empresa)) {
      await registerDiscard({
        tables,
        fonte: lead.fonte,
        motivoDescarte: DiscardReason.sem_nome,
        telefoneTentativo: lead.telefone,
        segmentoTentativo: String(lead.segmento),
        dadosBrutos: rawLead,
        mensagem: "LDR BSB exige nome real da empresa, nao um nome generico.",
      });
      return {
        approved: false,
        reason: DiscardReason.sem_nome,
        lead: buildLeadLogContext(lead),
      };
    }
  }



  if (workflowId === WORKFLOW_BSB) {
    const GENERIC_EMAIL_DOMAINS = [
      "gmail.com",
      "hotmail.com",
      "outlook.com",
      "yahoo.com",
      "yahoo.com.br",
      "live.com",
      "msn.com",
      "aol.com",
      "icloud.com",
      "mail.com",
      "protonmail.com",
      "uol.com.br",
      "bol.com.br",
      "terra.com.br",
      "ig.com.br",
      "globo.com",
      "zipmail.com.br",
    ];

    if (!lead.email) {
      await registerDiscard({
        tables,
        fonte: lead.fonte,
        motivoDescarte: DiscardReason.sem_email,
        telefoneTentativo: lead.telefone,
        segmentoTentativo: String(lead.segmento),
        dadosBrutos: rawLead,
        mensagem: "LDR BSB exige email personalizado para entrega do lead.",
      });
      return {
        approved: false,
        reason: DiscardReason.sem_email,
        lead: buildLeadLogContext(lead),
      };
    }

    const emailDomain = (lead.email.split("@")[1] || "").toLowerCase().trim();
    if (GENERIC_EMAIL_DOMAINS.includes(emailDomain)) {
      await registerDiscard({
        tables,
        fonte: lead.fonte,
        motivoDescarte: DiscardReason.sem_email,
        telefoneTentativo: lead.telefone,
        segmentoTentativo: String(lead.segmento),
        dadosBrutos: rawLead,
        mensagem: `LDR BSB exige email personalizado. Dominio generico detectado: ${emailDomain}`,
      });
      return {
        approved: false,
        reason: DiscardReason.sem_email,
        lead: buildLeadLogContext(lead),
      };
    }
  }

  if (!isInsideIcp(lead.segmento, activeSegments)) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.fora_do_icp,
      telefoneTentativo: lead.telefone,
      segmentoTentativo: String(lead.segmento),
      dadosBrutos: rawLead,
      mensagem: "Segmento fora da configuracao ativa de ICP.",
    });
    return {
      approved: false,
      reason: DiscardReason.fora_do_icp,
      lead: buildLeadLogContext(lead),
    };
  }

  if (lead.telefone) {
    const byPhone = await tables.lead.findUnique({
      where: { telefone: lead.telefone },
      select: { id: true },
    });
    if (byPhone) {
      await registerDiscard({
        tables,
        fonte: lead.fonte,
        motivoDescarte: DiscardReason.duplicata_telefone,
        telefoneTentativo: lead.telefone,
        segmentoTentativo: String(lead.segmento),
        dadosBrutos: rawLead,
        mensagem: "Telefone ja existe em leads_automacao.",
      });
      return {
        approved: false,
        reason: DiscardReason.duplicata_telefone,
        lead: buildLeadLogContext(lead),
      };
    }
  }

  if (workflowId === WORKFLOW_BSB && lead.email) {
    const byEmail = await tables.lead.findFirst({
      where: { email: lead.email },
      select: { id: true },
    });

    if (byEmail) {
      await registerDiscard({
        tables,
        fonte: lead.fonte,
        motivoDescarte: DiscardReason.duplicata_email,
        telefoneTentativo: lead.telefone,
        segmentoTentativo: String(lead.segmento),
        dadosBrutos: rawLead,
        mensagem: "Email ja existe em leads_automacao para workflow BSB.",
      });
      return {
        approved: false,
        reason: DiscardReason.duplicata_email,
        lead: buildLeadLogContext(lead),
      };
    }
  }

  const byCompanySegment = await tables.lead.findFirst({
    where: {
      empresa: lead.empresa,
      segmento: lead.segmento,
    },
    select: { id: true },
  });
  if (byCompanySegment) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.duplicata_empresa_segmento,
      telefoneTentativo: lead.telefone,
      segmentoTentativo: String(lead.segmento),
      dadosBrutos: rawLead,
      mensagem: "Empresa + segmento ja existem em leads_automacao.",
    });
    return {
      approved: false,
      reason: DiscardReason.duplicata_empresa_segmento,
      lead: buildLeadLogContext(lead),
    };
  }

  const created = await tables.lead.create({
    data: {
      id: randomUUID(),
      nome: lead.nome,
      telefone: lead.telefone || null,
      empresa: lead.empresa,
      segmento: lead.segmento,
      endereco: lead.endereco,
      site: lead.site || null,
      instagram: lead.instagram || null,
      email: lead.email || null,
      agentSlug: String(workflowConfig?.defaultAgentSlug || "default-sdr"),
      status: "NOVO_LEAD",
      canalAquisicao: workflowConfig?.channel || "scrap_smg",
      pipelineOrigin: "automacao",
      automationActive: true,
      fonteOrigem: lead.fonte,
      dadosBrutos: lead.dadosBrutos || null,
    },
  });

  return {
    approved: true,
    leadId: created.id,
    reason: null,
    lead: buildLeadLogContext(lead),
  };
}

module.exports = {
  validateAndInsertLead,
};
