const DEFAULT_MAX_CHUNK_LENGTH = 420;
const MIN_MAX_CHUNK_LENGTH = 120;
const MAX_MAX_CHUNK_LENGTH = 1000;
const DEFAULT_PREFERRED_CHUNK_LENGTH = 180;
const MIN_PREFERRED_CHUNK_LENGTH = 60;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveChunkConfig(options = {}) {
  const maxChunkLength = clamp(
    Number(options.maxChunkLength) || DEFAULT_MAX_CHUNK_LENGTH,
    MIN_MAX_CHUNK_LENGTH,
    MAX_MAX_CHUNK_LENGTH
  );

  const preferredChunkLength = clamp(
    Number(options.preferredChunkLength) ||
      Math.min(DEFAULT_PREFERRED_CHUNK_LENGTH, Math.floor(maxChunkLength * 0.6)),
    MIN_PREFERRED_CHUNK_LENGTH,
    maxChunkLength
  );

  return {
    maxChunkLength,
    preferredChunkLength,
  };
}

function normalizeRawMessage(rawText) {
  return String(rawText || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitByWords(text, maxChunkLength, preferredChunkLength = maxChunkLength) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];

  if (normalized.length <= preferredChunkLength) {
    return [normalized];
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const chunks = [];
  let current = "";

  for (const word of words) {
    if (word.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }

      for (let index = 0; index < word.length; index += maxChunkLength) {
        chunks.push(word.slice(index, index + maxChunkLength));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
      }
      current = word;
    } else if (
      candidate.length > preferredChunkLength &&
      current &&
      current.length >= Math.floor(preferredChunkLength * 0.4)
    ) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongSentenceByPhrases(text, maxChunkLength, preferredChunkLength) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];

  const phraseParts = normalized.split(/(?<=[,;:])\s+/g).filter(Boolean);
  if (phraseParts.length <= 1) {
    return splitByWords(normalized, maxChunkLength, preferredChunkLength);
  }

  const chunks = [];
  let current = "";

  for (const phrase of phraseParts) {
    const part = String(phrase || "").trim();
    if (!part) continue;

    if (part.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitByWords(part, maxChunkLength, preferredChunkLength));
      continue;
    }

    const candidate = current ? `${current} ${part}` : part;
    if (
      candidate.length > preferredChunkLength &&
      current &&
      current.length >= Math.floor(preferredChunkLength * 0.4)
    ) {
      chunks.push(current);
      current = part;
    } else if (candidate.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
      }
      current = part;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitBySentences(text, maxChunkLength, preferredChunkLength = maxChunkLength) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];

  const sentenceLikeParts = normalized.match(/[^.!?\n]+[.!?]*/g) || [];
  if (sentenceLikeParts.length === 0) {
    return splitByWords(normalized, maxChunkLength, preferredChunkLength);
  }

  const chunks = [];
  let current = "";

  for (const rawPart of sentenceLikeParts) {
    const part = String(rawPart || "").trim();
    if (!part) continue;

    if (part.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const wordParts = splitLongSentenceByPhrases(part, maxChunkLength, preferredChunkLength);
      chunks.push(...wordParts);
      continue;
    }

    const candidate = current ? `${current} ${part}` : part;
    if (
      candidate.length > preferredChunkLength &&
      current &&
      current.length >= Math.floor(preferredChunkLength * 0.4)
    ) {
      chunks.push(current);
      current = part;
    } else if (candidate.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
      }
      current = part;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitMessageForWhatsapp(rawText, options = {}) {
  const normalized = normalizeRawMessage(rawText);
  if (!normalized) return [];

  const { maxChunkLength, preferredChunkLength } = resolveChunkConfig(options);

  if (normalized.length <= preferredChunkLength) {
    return [normalized];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  const chunks = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= preferredChunkLength) {
      chunks.push(paragraph);
      continue;
    }

    const lines = paragraph
      .split(/\n+/)
      .map((line) => String(line || "").trim())
      .filter(Boolean);

    if (lines.length === 0) {
      chunks.push(...splitBySentences(paragraph, maxChunkLength, preferredChunkLength));
      continue;
    }

    for (const line of lines) {
      if (line.length <= preferredChunkLength) {
        chunks.push(line);
      } else {
        chunks.push(...splitBySentences(line, maxChunkLength, preferredChunkLength));
      }
    }
  }

  const compacted = [];
  for (const chunk of chunks) {
    const value = String(chunk || "").trim();
    if (!value) continue;

    const previous = compacted[compacted.length - 1];
    const canMerge =
      previous &&
      !/[.!?]$/.test(previous) &&
      previous.length + value.length + 1 <= Math.floor(preferredChunkLength * 0.75);

    if (canMerge) {
      compacted[compacted.length - 1] = `${previous} ${value}`;
    } else {
      compacted.push(value);
    }
  }

  return compacted;
}

function estimateTypingDelayMs(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return 600;

  const charCount = normalized.length;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const punctuationCount = (normalized.match(/[.,;:!?]/g) || []).length;

  const computed = 650 + charCount * 18 + wordCount * 22 + punctuationCount * 90;

  return clamp(computed, 700, 6500);
}

function buildTypingChunks(rawText, options = {}) {
  const chunks = splitMessageForWhatsapp(rawText, options);
  const output = [];

  chunks.forEach((chunkText, index) => {
    output.push({
      text: chunkText,
      index: index + 1,
      total: chunks.length,
      delayMs: estimateTypingDelayMs(chunkText),
    });
  });

  return output;
}

module.exports = {
  splitMessageForWhatsapp,
  estimateTypingDelayMs,
  buildTypingChunks,
};
