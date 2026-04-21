const env = require("../../config/env");

function normalizeProvider(input) {
  const value = String(input || "")
    .trim()
    .toLowerCase();

  if (value === "meta" || value === "meta_official" || value === "metaofficial") {
    return "meta";
  }

  if (value === "uazapi" || value === "uaza") {
    return "uazapi";
  }

  return "";
}

function normalizePhone(rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) return "";

  if (value.includes("@")) {
    value = value.split("@")[0];
  }

  return value.replace(/[^\d]/g, "");
}

function textOrEmpty(value) {
  const text = String(value || "").trim();
  return text || "";
}

function getRequestOrigin(req) {
  const fromEnv = String(env.publicWebhookBaseUrl || "").trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").trim();
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function isNonEmptyString(value) {
  return String(value || "").trim().length > 0;
}

function maskCredential(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (normalized.length <= 8) return "********";
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

module.exports = {
  normalizeProvider,
  normalizePhone,
  textOrEmpty,
  getRequestOrigin,
  isNonEmptyString,
  maskCredential,
};
