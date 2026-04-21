const path = require("path");
const fs = require("fs");

function textOrEmpty(value) {
  const text = String(value || "").trim();
  return text || "";
}

function normalizePhone(rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) return "";
  if (value.includes("@")) {
    value = value.split("@")[0];
  }
  return value.replace(/[^\d]/g, "");
}

function normalizeE164(rawValue) {
  const digits = normalizePhone(rawValue);
  if (!digits) return "";
  if (digits.startsWith("55")) {
    return `+${digits}`;
  }
  if (digits.length >= 10) {
    return `+55${digits}`;
  }
  return "";
}

function buildPhoneCandidates(rawPhone) {
  const digits = normalizePhone(rawPhone);
  if (!digits) return [];

  const candidates = new Set([digits, `+${digits}`]);
  if (!digits.startsWith("55") && digits.length >= 10) {
    candidates.add(`55${digits}`);
    candidates.add(`+55${digits}`);
  }
  if (digits.startsWith("55")) {
    const withoutCountry = digits.slice(2);
    if (withoutCountry.length >= 10) {
      candidates.add(withoutCountry);
      candidates.add(`+${withoutCountry}`);
    }
  }

  return [...candidates];
}

function mergeDadosBrutos(existing, patch) {
  const current =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  return {
    ...current,
    ...patch,
    wf2: {
      ...(current.wf2 && typeof current.wf2 === "object" ? current.wf2 : {}),
      ...(patch.wf2 && typeof patch.wf2 === "object" ? patch.wf2 : {}),
    },
  };
}

function clipText(value, max = 240) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function extractInboundToken(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const match = raw.match(/\bSMG-([A-Za-z0-9_-]{4,})\b/i);
  if (!match) return "";
  return `SMG-${match[1]}`;
}

function toPtWeekday(value) {
  const short = String(value || "").trim().toLowerCase();
  if (short.startsWith("mon")) return "seg";
  if (short.startsWith("tue")) return "ter";
  if (short.startsWith("wed")) return "qua";
  if (short.startsWith("thu")) return "qui";
  if (short.startsWith("fri")) return "sex";
  if (short.startsWith("sat")) return "sab";
  if (short.startsWith("sun")) return "dom";
  return "";
}

function getTimePartsInTimezone(date = new Date(), timezone = "America/Sao_Paulo") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  return {
    weekday: toPtWeekday(map.weekday || ""),
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
  };
}

function normalizeAllowedDays(rawDays) {
  if (!rawDays) return ["seg", "ter", "qua", "qui", "sex"];
  if (Array.isArray(rawDays)) {
    const cleaned = rawDays
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean);
    return cleaned.length ? cleaned : ["seg", "ter", "qua", "qui", "sex"];
  }
  if (typeof rawDays === "string") {
    try {
      const parsed = JSON.parse(rawDays);
      return normalizeAllowedDays(parsed);
    } catch (_error) {
      return normalizeAllowedDays(rawDays.split(","));
    }
  }
  return ["seg", "ter", "qua", "qui", "sex"];
}

function parseTimeToMinutes(rawTime, fallback = "08:00") {
  const source = textOrEmpty(rawTime || fallback) || fallback;
  const [hourText, minuteText] = source.split(":");
  const hour = Math.max(0, Math.min(23, Number(hourText || 0)));
  const minute = Math.max(0, Math.min(59, Number(minuteText || 0)));
  return hour * 60 + minute;
}

function isWithinAutomationSchedule(config = {}, now = new Date()) {
  const timezone = textOrEmpty(config.timezone) || "America/Sao_Paulo";
  const allowedDays = normalizeAllowedDays(config.diasPersonalizados);
  const { weekday, hour, minute } = getTimePartsInTimezone(now, timezone);

  if (!allowedDays.includes(weekday)) {
    return false;
  }

  const nowMinutes = hour * 60 + minute;
  const startMinutes = parseTimeToMinutes(config.horarioInicio, "08:00");
  const endMinutes = parseTimeToMinutes(config.horarioFim, "20:00");

  if (endMinutes >= startMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

function addHours(date, hours) {
  return new Date(date.getTime() + Number(hours || 0) * 60 * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeFilePart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function resolvePublicFileUrl(baseUrl, relativePath) {
  const base = textOrEmpty(baseUrl).replace(/\/+$/, "");
  const rel = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!base) return "";
  return `${base}/${rel}`;
}

function absolutePublicFilePath(projectRoot, relativePath) {
  return path.join(projectRoot, relativePath);
}

module.exports = {
  textOrEmpty,
  normalizePhone,
  normalizeE164,
  buildPhoneCandidates,
  mergeDadosBrutos,
  clipText,
  extractInboundToken,
  normalizeAllowedDays,
  parseTimeToMinutes,
  getTimePartsInTimezone,
  isWithinAutomationSchedule,
  addHours,
  addDays,
  ensureDirectory,
  sanitizeFilePart,
  resolvePublicFileUrl,
  absolutePublicFilePath,
};
