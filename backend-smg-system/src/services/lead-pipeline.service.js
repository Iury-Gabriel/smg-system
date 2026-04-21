const { randomUUID } = require("crypto");
const { DiscardReason, LeadSegment } = require("@prisma/client");
const env = require("../config/env");
const { WORKFLOW_BSB } = require("../config/workflows");
const { normalizeLeadShape, normalizeText } = require("./lead-normalizer.service");
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

async function enrichLeadFromWebsite(lead) {
  if (!env.enableWebsiteEnrichment) return lead;
  if (!lead.site) return lead;

  const enrichment = await scrapeWebsiteContacts(lead.site);
  const nextLead = { ...lead };

  if (!nextLead.email && Array.isArray(enrichment.emails) && enrichment.emails.length > 0) {
    nextLead.email = enrichment.emails[0];
  }

  if (!nextLead.telefone && Array.isArray(enrichment.phones) && enrichment.phones.length > 0) {
    const probe = normalizeLeadShape(
      {
        nome: nextLead.nome,
        empresa: nextLead.empresa,
        endereco: nextLead.endereco,
        telefoneBruto: enrichment.phones[0],
        site: nextLead.site,
        email: nextLead.email,
        segmentoBruto: nextLead.segmento,
        fonte: nextLead.fonte,
      },
      nextLead.segmento
    );
    nextLead.telefone = probe.telefone;
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
  let lead = normalizeLeadShape(rawLead, fallbackSegment);
  lead = await enrichLeadFromWebsite(lead);
  const workflowId = workflowConfig?.id || "smg";
  const requiresPhone = workflowId !== WORKFLOW_BSB;

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

  if (workflowId === WORKFLOW_BSB && shouldDiscardBsbLeadByForbiddenKeywords(rawLead, lead)) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.fora_do_icp,
      telefoneTentativo: lead.telefone,
      segmentoTentativo: String(lead.segmento),
      dadosBrutos: rawLead,
      mensagem: "Lead descartado por palavras-chave de segmentos proibidos no LDR BSB.",
    });
    return {
      approved: false,
      reason: DiscardReason.fora_do_icp,
      lead: buildLeadLogContext(lead),
    };
  }

  if (workflowId === WORKFLOW_BSB && !lead.email) {
    await registerDiscard({
      tables,
      fonte: lead.fonte,
      motivoDescarte: DiscardReason.sem_email,
      telefoneTentativo: lead.telefone,
      segmentoTentativo: String(lead.segmento),
      dadosBrutos: rawLead,
      mensagem: "LDR BSB exige email valido para entrega do lead.",
    });
    return {
      approved: false,
      reason: DiscardReason.sem_email,
      lead: buildLeadLogContext(lead),
    };
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
