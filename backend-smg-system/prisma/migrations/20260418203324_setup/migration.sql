-- CreateTable
CREATE TABLE "LeadAutomacao" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "empresa" TEXT NOT NULL,
    "segmento" TEXT NOT NULL,
    "endereco" TEXT NOT NULL,
    "site" TEXT,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOVO_LEAD',
    "canalAquisicao" TEXT NOT NULL DEFAULT 'scrap_smg',
    "pipelineOrigin" TEXT NOT NULL DEFAULT 'automacao',
    "automationActive" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fonteOrigem" TEXT NOT NULL,
    "dadosBrutos" JSONB
);

-- CreateTable
CREATE TABLE "DiscardLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fonte" TEXT NOT NULL,
    "motivoDescarte" TEXT NOT NULL,
    "telefoneTentativo" TEXT,
    "segmentoTentativo" TEXT,
    "dadosBrutos" JSONB,
    "mensagem" TEXT
);

-- CreateTable
CREATE TABLE "SegmentConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "segment" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SearchPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "location" TEXT,
    "ll" TEXT,
    "googleDomain" TEXT NOT NULL DEFAULT 'google.com',
    "hl" TEXT NOT NULL DEFAULT 'pt',
    "gl" TEXT NOT NULL DEFAULT 'br',
    "maxResults" INTEGER NOT NULL DEFAULT 20,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "segmentId" TEXT NOT NULL,
    CONSTRAINT "SearchPreset_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "SegmentConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "queueJobId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'running',
    "totalCollected" INTEGER NOT NULL DEFAULT 0,
    "totalApproved" INTEGER NOT NULL DEFAULT 0,
    "totalDiscarded" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "details" JSONB
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadAutomacao_telefone_key" ON "LeadAutomacao"("telefone");

-- CreateIndex
CREATE INDEX "LeadAutomacao_segmento_criadoEm_idx" ON "LeadAutomacao"("segmento", "criadoEm");

-- CreateIndex
CREATE INDEX "LeadAutomacao_status_criadoEm_idx" ON "LeadAutomacao"("status", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "LeadAutomacao_empresa_segmento_key" ON "LeadAutomacao"("empresa", "segmento");

-- CreateIndex
CREATE INDEX "DiscardLog_motivoDescarte_timestamp_idx" ON "DiscardLog"("motivoDescarte", "timestamp");

-- CreateIndex
CREATE INDEX "DiscardLog_fonte_timestamp_idx" ON "DiscardLog"("fonte", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "SegmentConfig_segment_key" ON "SegmentConfig"("segment");

-- CreateIndex
CREATE INDEX "SearchPreset_isActive_source_idx" ON "SearchPreset"("isActive", "source");

-- CreateIndex
CREATE INDEX "SearchPreset_segmentId_isActive_idx" ON "SearchPreset"("segmentId", "isActive");

-- CreateIndex
CREATE INDEX "JobExecution_startedAt_idx" ON "JobExecution"("startedAt");

-- CreateIndex
CREATE INDEX "JobExecution_status_startedAt_idx" ON "JobExecution"("status", "startedAt");
