const { spawn } = require("child_process");
const path = require("path");

function spawnService(name, scriptRelativePath) {
  const scriptPath = path.join(__dirname, scriptRelativePath);
  const child = spawn(process.execPath, [scriptPath], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`[start-all] ${name} failed to start:`, error?.message || "unknown");
  });

  return child;
}

const services = [
  { name: "server", child: spawnService("server", "server.js") },
  { name: "worker", child: spawnService("worker", path.join("queue", "worker.js")) },
];

let shuttingDown = false;

function shutdownAll(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const service of services) {
    try {
      if (!service.child.killed) {
        service.child.kill(signal);
      }
    } catch (_error) {
      // Ignore individual shutdown errors and continue stopping other services.
    }
  }
}

for (const service of services) {
  service.child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const exitInfo = signal ? `signal=${signal}` : `code=${code}`;
    console.error(`[start-all] ${service.name} exited unexpectedly (${exitInfo}). Stopping all.`);
    shutdownAll("SIGTERM");
    process.exit(typeof code === "number" ? code : 1);
  });
}

process.on("SIGINT", () => {
  shutdownAll("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdownAll("SIGTERM");
  process.exit(0);
});
