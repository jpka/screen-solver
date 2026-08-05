// The part worth lifting into the real app. Pure: given metrics already
// computed by metrics.js, decide trigger vs skip. No I/O, no capture, no timers.
function classify(pairMetrics, config) {
  const { region, metric, threshold } = config;
  const value = pairMetrics.regions[region][metric === 'hash' ? 'hashDistance' : 'pixelDiffPercent'];
  return { value, verdict: value >= threshold ? 'trigger' : 'skip' };
}

module.exports = { classify };
