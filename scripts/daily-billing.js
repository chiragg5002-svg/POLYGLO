const { createPlatform } = require("../dbaas");

async function runDailyBilling() {
  const platform = createPlatform();
  const today = new Date();
  const snapshotDate = today.toISOString().slice(0, 10);
  const reconcileDate = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1,
  )).toISOString().slice(0, 10);
  try {
    await platform.cp.init();
    const projects = await platform.cp.listProjects();
    let unavailable = 0;
    for (const project of projects) {
      const result = await platform.usage({ projectId: project.projectId });
      const storageBytes = result.usage.storageBytes;
      const available = Number.isSafeInteger(storageBytes) && storageBytes >= 0;
      if (!available) unavailable += 1;
      await platform.store.recordStorageSnapshot({
        projectId: project.projectId,
        date: snapshotDate,
        storageBytes: available ? storageBytes : null,
        available,
        reason: available ? null : (result.warnings || []).join(" ") || "Project storage measurement unavailable.",
      });
    }
    await platform.store.reconcileDailyUsage({ start: reconcileDate, end: reconcileDate });
    process.stdout.write(
      `Billing capture completed. Snapshot date UTC: ${snapshotDate}; projects: ${projects.length}; unavailable storage measurements: ${unavailable}; reconciled usage date UTC: ${reconcileDate}.\n`,
    );
  } finally {
    await platform.cp.close();
  }
}

runDailyBilling().catch((error) => {
  console.error("Daily billing capture failed.", { code: error && error.code || "unknown" });
  process.exitCode = 1;
});
