const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const {
  ensureDirectory,
  sanitizeFilePart,
  absolutePublicFilePath,
  resolvePublicFileUrl,
} = require("./helpers");

function splitParagraphs(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function writePdfFile({ outputPath, title, subtitle, body }) {
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

    doc.font("Helvetica-Bold").fontSize(20).text(title, { align: "left" });
    doc.moveDown(0.3);
    if (subtitle) {
      doc.font("Helvetica").fontSize(11).fillColor("#555555").text(subtitle);
      doc.fillColor("#000000");
      doc.moveDown(0.8);
    }

    const paragraphs = splitParagraphs(body);
    if (!paragraphs.length) {
      paragraphs.push(
        "Nao foi possivel gerar uma analise detalhada com os dados disponiveis. Recomendamos seguir para diagnostico guiado com especialista."
      );
    }

    for (const paragraph of paragraphs) {
      doc.font("Helvetica").fontSize(11).text(paragraph, {
        lineGap: 3,
      });
      doc.moveDown(0.6);
    }

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
