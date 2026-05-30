const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const {
  ensureDirectory,
  sanitizeFilePart,
  absolutePublicFilePath,
  resolvePublicFileUrl,
} = require("./helpers");

function normalizePdfLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => String(line || "").trim());
}

function isSectionHeading(line) {
  const value = String(line || "").trim();
  if (!value) return false;
  if (/^SECAO\s+\d+\b/i.test(value)) return true;
  if (/^CAPA\b/i.test(value)) return true;
  if (/^RODAPE\b/i.test(value)) return true;
  if (/^MATURIDADE GERAL\b/i.test(value)) return true;
  return false;
}

function isBulletLine(line) {
  return /^[-*]\s+/.test(String(line || "").trim());
}

function formatDatePtBr(date = new Date()) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function renderCover(doc, { title, subtitle, lead, workflow }) {
  const companyName = String(lead?.empresa || lead?.nome || "Empresa").trim() || "Empresa";
  const responsibleName = String(lead?.nome || "Responsavel").trim() || "Responsavel";

  doc.font("Helvetica-Bold").fontSize(24).fillColor("#111111").text(title, {
    align: "left",
  });
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(12).fillColor("#333333").text(subtitle, {
    align: "left",
  });
  doc.moveDown(1.2);

  doc.font("Helvetica-Bold").fontSize(14).fillColor("#000000").text("Empresa", {
    align: "left",
  });
  doc.font("Helvetica").fontSize(12).text(companyName);
  doc.moveDown(0.4);

  doc.font("Helvetica-Bold").fontSize(14).text("Responsavel", {
    align: "left",
  });
  doc.font("Helvetica").fontSize(12).text(responsibleName);
  doc.moveDown(0.4);

  doc.font("Helvetica-Bold").fontSize(14).text("Data de Geracao", {
    align: "left",
  });
  doc.font("Helvetica").fontSize(12).text(formatDatePtBr(new Date()));
  doc.moveDown(0.4);

  doc.font("Helvetica-Bold").fontSize(14).text("Workflow", {
    align: "left",
  });
  doc.font("Helvetica").fontSize(12).text(String(workflow || "").toUpperCase() || "-");

  doc.moveDown(1.4);
  doc
    .strokeColor("#DADADA")
    .lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(1.1);
}

function renderBody(doc, body) {
  const lines = normalizePdfLines(body).filter(Boolean);
  if (!lines.length) {
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#000000")
      .text(
        "Nao foi possivel gerar uma analise detalhada com os dados disponiveis. Recomendamos seguir para diagnostico guiado com especialista.",
        { lineGap: 3 }
      );
    return;
  }

  for (const line of lines) {
    if (isSectionHeading(line)) {
      doc.moveDown(0.8);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#111111").text(line, {
        align: "left",
      });
      doc.moveDown(0.25);
      continue;
    }

    if (isBulletLine(line)) {
      const bulletText = line.replace(/^[-*]\s+/, "").trim();
      doc.font("Helvetica").fontSize(11).fillColor("#000000").text(`- ${bulletText}`, {
        lineGap: 3,
        indent: 10,
      });
      continue;
    }

    doc.font("Helvetica").fontSize(11).fillColor("#000000").text(line, {
      lineGap: 3,
      align: "left",
    });
    doc.moveDown(0.25);
  }
}

async function writePdfFile({ outputPath, title, subtitle, body, lead, workflow }) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: title,
        Author: "SMG OS",
      },
    });

    const stream = fs.createWriteStream(outputPath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);

    doc.pipe(stream);

    renderCover(doc, { title, subtitle, lead, workflow });
    renderBody(doc, body);

    doc.end();
  });
}

async function generateAnalysisPdf({
  projectRoot,
  publicBaseUrl,
  workflow,
  lead,
  analysisText,
}) {
  const relativeDir = path.join("public", "analises", workflow);
  const absoluteDir = absolutePublicFilePath(projectRoot, relativeDir);
  ensureDirectory(absoluteDir);

  const companyPart = sanitizeFilePart(lead?.empresa || lead?.nome || "lead");
  const filename = `${Date.now()}-${companyPart || "analise"}-smg.pdf`;
  const absolutePath = path.join(absoluteDir, filename);
  const relativePath = path.join(relativeDir, filename).replace(/\\/g, "/");

  await writePdfFile({
    outputPath: absolutePath,
    title: "Analise de Maturidade Operacional - SMG",
    subtitle: `${lead?.empresa || lead?.nome || "Empresa"} | ${workflow.toUpperCase()}`,
    body: analysisText,
    lead,
    workflow,
  });

  const publicUrl = resolvePublicFileUrl(publicBaseUrl, relativePath);

  return {
    absolutePath,
    relativePath,
    publicUrl,
    filename,
  };
}

module.exports = {
  generateAnalysisPdf,
};
