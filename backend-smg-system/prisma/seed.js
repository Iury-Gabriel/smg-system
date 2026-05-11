const dotenv = require("dotenv");
const { PrismaClient, LeadSegment, ScrapeSource } = require("@prisma/client");
const { getWorkflowTables } = require("../src/services/workflow-data-access.service");

dotenv.config();

const WORKFLOW_SMG = "smg";
const WORKFLOW_BSB = "bsb";

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.DATABASE_URL_SMG ||
  "postgresql://smg:smg123@localhost:5432/smg?schema=public";

const SMG_SEGMENTS = [
  { segment: LeadSegment.dentista, displayName: "Dentistas" },
  { segment: LeadSegment.nutricionista, displayName: "Nutricionistas" },
  { segment: LeadSegment.fisioterapeuta, displayName: "Fisioterapeutas" },
  { segment: LeadSegment.dermatologista, displayName: "Dermatologistas" },
  { segment: LeadSegment.ortopedista, displayName: "Ortopedistas" },
  { segment: LeadSegment.barbearia, displayName: "Barbearias e Saloes" },
  { segment: LeadSegment.estetica, displayName: "Clinicas de Estetica" },
  { segment: LeadSegment.corretor, displayName: "Corretores de Imoveis" },
  { segment: LeadSegment.restaurante, displayName: "Restaurantes" },
  { segment: LeadSegment.automovel, displayName: "Automobilistico" },
];

const SMG_LOCATION = "Sao Paulo, State of Sao Paulo, Brazil";
const SMG_LL = "@-23.5505,-46.6333,14z";

const SMG_PRESETS = [
  {
    name: "Dentistas Google Search SP",
    source: ScrapeSource.google_search,
    query: "Dentista",
    location: SMG_LOCATION,
    segment: LeadSegment.dentista,
  },
  {
    name: "Dentistas Google Maps SP",
    source: ScrapeSource.google_maps,
    query: "Dentista",
    ll: SMG_LL,
    segment: LeadSegment.dentista,
  },
  {
    name: "Barbearias Google Search SP",
    source: ScrapeSource.google_search,
    query: "Barbearia",
    location: SMG_LOCATION,
    segment: LeadSegment.barbearia,
  },
  {
    name: "Barbearias Google Maps SP",
    source: ScrapeSource.google_maps,
    query: "Barbearia",
    ll: SMG_LL,
    segment: LeadSegment.barbearia,
  },
  {
    name: "Estetica Google Search SP",
    source: ScrapeSource.google_search,
    query: "Clinica de Estetica",
    location: SMG_LOCATION,
    segment: LeadSegment.estetica,
  },
  {
    name: "Estetica Google Maps SP",
    source: ScrapeSource.google_maps,
    query: "Clinica de Estetica",
    ll: SMG_LL,
    segment: LeadSegment.estetica,
  },
  {
    name: "Corretores Google Search SP",
    source: ScrapeSource.google_search,
    query: "Imobiliaria",
    location: SMG_LOCATION,
    segment: LeadSegment.corretor,
  },
  {
    name: "Restaurantes Google Maps SP",
    source: ScrapeSource.google_maps,
    query: "Restaurante",
    ll: SMG_LL,
    segment: LeadSegment.restaurante,
  },
  {
    name: "Automovel Google Maps SP",
    source: ScrapeSource.google_maps,
    query: "Concessionaria",
    ll: SMG_LL,
    segment: LeadSegment.automovel,
  },
];

const BSB_SEGMENTS = [
  { segment: LeadSegment.construtora, displayName: "Construtoras e Incorporadoras" },
  { segment: LeadSegment.engenharia, displayName: "Empresas de Engenharia" },
  { segment: LeadSegment.arquitetura, displayName: "Arquitetura e Arquitetos" },
];

const BSB_LOCATION = "Sao Paulo, State of Sao Paulo, Brazil";
const BSB_LL = "@-23.5505,-46.6333,14z";

const BSB_PRESETS = [
  {
    name: "Construtora Google Search BSB",
    source: ScrapeSource.google_search,
    query: "Construtora",
    location: BSB_LOCATION,
    segment: LeadSegment.construtora,
  },
  {
    name: "Construtora Google Maps BSB",
    source: ScrapeSource.google_maps,
    query: "Construtora",
    ll: BSB_LL,
    segment: LeadSegment.construtora,
  },
  {
    name: "Empresa de Engenharia Google Search BSB",
    source: ScrapeSource.google_search,
    query: "Empresa de engenharia",
    location: BSB_LOCATION,
    segment: LeadSegment.engenharia,
  },
  {
    name: "Empresa de Engenharia Google Maps BSB",
    source: ScrapeSource.google_maps,
    query: "Empresa de engenharia",
    ll: BSB_LL,
    segment: LeadSegment.engenharia,
  },
  {
    name: "Escritorio de Engenharia Google Search BSB",
    source: ScrapeSource.google_search,
    query: "Escritorio de engenharia",
    location: BSB_LOCATION,
    segment: LeadSegment.engenharia,
  },
  {
    name: "Escritorio de Engenharia Google Maps BSB",
    source: ScrapeSource.google_maps,
    query: "Escritorio de engenharia",
    ll: BSB_LL,
    segment: LeadSegment.engenharia,
  },
  {
    name: "Consultoria de Engenharia Google Search BSB",
    source: ScrapeSource.google_search,
    query: "Consultoria de engenharia",
    location: BSB_LOCATION,
    segment: LeadSegment.engenharia,
  },
  {
    name: "Consultoria de Engenharia Google Maps BSB",
    source: ScrapeSource.google_maps,
    query: "Consultoria de engenharia",
    ll: BSB_LL,
    segment: LeadSegment.engenharia,
  },
  {
    name: "Escritorio de Arquitetura Google Search BSB",
    source: ScrapeSource.google_search,
    query: "Escritorio de arquitetura",
    location: BSB_LOCATION,
    segment: LeadSegment.arquitetura,
  },
  {
    name: "Escritorio de Arquitetura Google Maps BSB",
    source: ScrapeSource.google_maps,
    query: "Escritorio de arquitetura",
    ll: BSB_LL,
    segment: LeadSegment.arquitetura,
  },
  {
    name: "Consultoria de Arquitetura Google Search BSB",
    source: ScrapeSource.google_search,
    query: "Consultoria de arquitetura",
    location: BSB_LOCATION,
    segment: LeadSegment.arquitetura,
  },
  {
    name: "Consultoria de Arquitetura Google Maps BSB",
    source: ScrapeSource.google_maps,
    query: "Consultoria de arquitetura",
    ll: BSB_LL,
    segment: LeadSegment.arquitetura,
  },
  {
    name: "Arquiteto Google Search BSB",
    source: ScrapeSource.google_search,
    query: "Arquiteto",
    location: BSB_LOCATION,
    segment: LeadSegment.arquitetura,
  },
  {
    name: "Arquiteto Google Maps BSB",
    source: ScrapeSource.google_maps,
    query: "Arquiteto",
    ll: BSB_LL,
    segment: LeadSegment.arquitetura,
  },
];

const WORKFLOW_PROFILES = {
  [WORKFLOW_SMG]: {
    segments: SMG_SEGMENTS,
    presets: SMG_PRESETS,
  },
  [WORKFLOW_BSB]: {
    segments: BSB_SEGMENTS,
    presets: BSB_PRESETS,
  },
};

const WF2_TEMPLATE_DEFAULTS = [
  {
    etapa: "etapa1",
    templateText:
      "Oi {nome}, tudo bem? Aqui e da SMG. Analisei seu segmento ({segmento}) e acredito que da para ganhar eficiencia com alguns ajustes simples. Posso te fazer uma pergunta rapida sobre a operacao?",
  },
  {
    etapa: "fup1",
    templateText:
      "Passando para reforcar nosso contato anterior. Se fizer sentido para voce, seguimos com um diagnostico rapido e pratico.",
  },
  {
    etapa: "fup2",
    templateText:
      "Conseguiu olhar minha mensagem? Tenho um caminho objetivo para mapear gargalos e priorizar melhorias.",
  },
  {
    etapa: "fup3",
    templateText:
      "Tentativa final por aqui: se quiser, seguimos com os proximos passos para sua analise personalizada sem compromisso.",
  },
  {
    etapa: "fup_recorrente",
    templateText:
      "Mantendo contato porque acredito que conseguimos te ajudar com ganhos operacionais concretos. Quer retomar?",
  },
];

function parseWorkflowArg(argv) {
  const arg = argv.find((item) => item.startsWith("--workflow="));
  if (!arg) return "all";
  const rawValue = String(arg.split("=", 2)[1] || "all")
    .trim()
    .toLowerCase();
  if (rawValue === "smg" || rawValue === "bsb" || rawValue === "all") {
    return rawValue;
  }
  return "all";
}

async function seedWorkflow(prisma, workflow) {
  const profile = WORKFLOW_PROFILES[workflow];
  if (!profile) return;

  const tables = getWorkflowTables(prisma, workflow);
  const presetMaxResults = workflow === WORKFLOW_BSB ? 67 : 34;
  const segmentMap = new Map();

  for (const segmentConfig of profile.segments) {
    const record = await tables.segment.upsert({
      where: { segment: segmentConfig.segment },
      update: {
        displayName: segmentConfig.displayName,
        isActive: true,
      },
      create: {
        segment: segmentConfig.segment,
        displayName: segmentConfig.displayName,
        isActive: true,
      },
    });
    segmentMap.set(segmentConfig.segment, record.id);
  }

  for (const preset of profile.presets) {
    const segmentId = segmentMap.get(preset.segment);
    if (!segmentId) continue;

    const existing = await tables.preset.findFirst({
      where: { name: preset.name, source: preset.source },
      select: { id: true },
    });

    const data = {
      query: preset.query,
      location: preset.location || null,
      ll: preset.ll || null,
      segmentId,
      isActive: true,
      maxResults: presetMaxResults,
    };

    if (existing) {
      await tables.preset.update({
        where: { id: existing.id },
        data,
      });
      continue;
    }

    await tables.preset.create({
      data: {
        name: preset.name,
        source: preset.source,
        query: preset.query,
        startOffset: 0,
        location: preset.location || null,
        ll: preset.ll || null,
        googleDomain: "google.com.br",
        hl: "pt",
        gl: "br",
        maxResults: presetMaxResults,
        segmentId,
        isActive: true,
      },
    });
  }

  await prisma.configAutomacao.upsert({
    where: { workflow },
    update: {},
    create: {
      workflow,
      horarioInicio: "08:00",
      horarioFim: "20:00",
      diasPersonalizados: ["seg", "ter", "qua", "qui", "sex"],
      tempoRespostaMin: 1,
      tempoRespostaMax: 3,
      timezone: "America/Sao_Paulo",
      followupHorasFup1: 24,
      followupHorasFup2: 48,
      followupDiasFup3: 7,
      followupRecorrenteHx: 84,
    },
  });

  await prisma.configNotificacao.upsert({
    where: {
      workflow_canal: {
        workflow,
        canal: "log",
      },
    },
    update: {},
    create: {
      workflow,
      canal: "log",
      enabled: true,
      target: "",
    },
  });

  for (const template of WF2_TEMPLATE_DEFAULTS) {
    await prisma.configTemplate.upsert({
      where: {
        workflow_segmento_etapa: {
          workflow,
          segmento: "default",
          etapa: template.etapa,
        },
      },
      update: {
        templateText: template.templateText,
        isActive: true,
      },
      create: {
        workflow,
        segmento: "default",
        etapa: template.etapa,
        templateText: template.templateText,
        isActive: true,
      },
    });
  }

  console.log(
    `[seed] workflow=${workflow} concluido com sucesso em ${DEFAULT_DATABASE_URL}`
  );
}

async function main() {
  const workflowArg = parseWorkflowArg(process.argv.slice(2));
  const workflows = workflowArg === "all" ? [WORKFLOW_SMG, WORKFLOW_BSB] : [workflowArg];
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: DEFAULT_DATABASE_URL,
      },
    },
  });

  try {
    for (const workflow of workflows) {
      await seedWorkflow(prisma, workflow);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Falha no seed:", error);
  process.exit(1);
});
