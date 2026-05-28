const fs = require("fs");
const path = require("path");

function readBuildSha() {
  const fromEnv = String(process.env.BUILD_SHA || "").trim();
  if (fromEnv) return fromEnv;

  try {
    return fs
      .readFileSync(path.join(__dirname, "..", "..", "BUILD_VERSION"), "utf8")
      .trim();
  } catch (_error) {
    return "local-dev";
  }
}

module.exports = {
  buildSha: readBuildSha(),
};
