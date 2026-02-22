export function runDailyRefreshPipeline({
  clearCaches,
  shouldRefreshStoryArc,
  refreshStoryArc,
  refreshTownMission,
  refreshRoutineNudges,
  refreshEconomy,
  refreshWorldEvents,
  refreshFactionPulse,
  refreshReactiveMissions,
  onStepDone
}) {
  if (typeof clearCaches === "function") clearCaches();

  const queue = [];
  const runStep = (promiseFactory) => {
    if (typeof promiseFactory !== "function") return;
    const p = Promise.resolve()
      .then(promiseFactory)
      .then(() => {
        if (typeof onStepDone === "function") onStepDone();
      })
      .catch(() => {
        if (typeof onStepDone === "function") onStepDone();
      });
    queue.push(p);
  };

  if (shouldRefreshStoryArc) runStep(refreshStoryArc);
  runStep(refreshTownMission);
  runStep(refreshRoutineNudges);
  runStep(refreshEconomy);
  runStep(refreshWorldEvents);
  runStep(refreshFactionPulse);
  runStep(refreshReactiveMissions);

  return Promise.allSettled(queue);
}
