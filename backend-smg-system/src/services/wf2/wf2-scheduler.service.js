const env = require("../../config/env");
const { processAllWorkflowTicks } = require("./wf2.service");

let schedulerTimer = null;
let running = false;

async function runTick() {
  if (running) return;
  running = true;
  try {
    const result = await processAllWorkflowTicks();
    console.log("[wf2-scheduler] tick", result);
  } catch (error) {
    console.error("[wf2-scheduler] tick failed", {
      message: error?.message || "unknown",
      stack: error?.stack || null,
    });
  } finally {
    running = false;
  }
}

function startWf2Scheduler() {
  if (schedulerTimer) return;
  const intervalMs = Math.max(10000, Number(env.wf2PollIntervalSeconds || 30) * 1000);
  schedulerTimer = setInterval(() => {
    runTick().catch(() => null);
  }, intervalMs);
  if (typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref();
  }
  runTick().catch(() => null);
  console.log(`[wf2-scheduler] started intervalMs=${intervalMs}`);
}

function stopWf2Scheduler() {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  console.log("[wf2-scheduler] stopped");
}

module.exports = {
  startWf2Scheduler,
  stopWf2Scheduler,
  runTick,
};
