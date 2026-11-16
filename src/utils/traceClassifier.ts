import type { RangeStatisticsResponse } from '../types/traceAnalyzer';

export type RangeStateLabel =
  | 'Smooth'
  | 'Steady Over Budget'
  | 'Spiky'
  | 'Severe Spikes';

export type LimitingThreadName =
  | 'GPU'
  | 'Game Thread'
  | 'Render Thread'
  | 'Idle / V-Sync'
  | 'Balanced'
  | 'Unattributed';

export interface RangeDescription {
  stateLabel: RangeStateLabel;
  stateSummary: string;
  bottleneckSummary: string;
  limitingThread: LimitingThreadName;
  budgetGapMs: number;
  targetFps: number;
  medianFps: number;
}

/**
 * Single source of truth for classifying frame health and bottleneck attribution in any time range.
 */
export function describeRange(
  stats: RangeStatisticsResponse,
  targetMs: number,
  hitchCount: number = 0,
  maxHitchMs?: number
): RangeDescription {
  const targetFps = Math.round(1000 / (targetMs > 0 ? targetMs : 16.6667));
  const medianFps = stats.medianMs > 0 ? Math.round(1000 / stats.medianMs) : targetFps;
  const budgetGapMs = Math.max(0, stats.medianMs - targetMs);
  const worstMs = maxHitchMs !== undefined && maxHitchMs > 0 ? maxHitchMs : stats.maxMs;

  let stateLabel: RangeStateLabel = 'Smooth';
  let stateSummary = '';

  const isOverBudget = budgetGapMs > 0.4 || stats.overBudgetPct > 20;
  const isSevereHitch = (worstMs > targetMs * 3.5 || worstMs > 100.0) && hitchCount > 0;
  const hasSpikes = hitchCount > 0;

  if (isOverBudget && isSevereHitch) {
    stateLabel = 'Severe Spikes';
    const spikeClause = ` ${hitchCount} spike${hitchCount === 1 ? '' : 's'} up to ${worstMs.toFixed(0)} ms.`;
    stateSummary = `Steady ${medianFps} fps: every frame is about ${budgetGapMs.toFixed(1)} ms over the ${targetFps} fps budget.${spikeClause}`;
  } else if (isOverBudget && hasSpikes) {
    stateLabel = 'Steady Over Budget';
    const spikeClause = ` ${hitchCount} spike${hitchCount === 1 ? '' : 's'} up to ${worstMs.toFixed(0)} ms.`;
    stateSummary = `Steady ${medianFps} fps: every frame is about ${budgetGapMs.toFixed(1)} ms over the ${targetFps} fps budget.${spikeClause}`;
  } else if (isOverBudget) {
    stateLabel = 'Steady Over Budget';
    stateSummary = `Steady ${medianFps} fps: every frame is about ${budgetGapMs.toFixed(1)} ms over the ${targetFps} fps budget (${stats.overBudgetPct.toFixed(0)}% of frames over budget).`;
  } else if (isSevereHitch) {
    stateLabel = 'Severe Spikes';
    const spikeClause = `${hitchCount} severe spike${hitchCount === 1 ? '' : 's'} up to ${worstMs.toFixed(0)} ms interrupt smooth gameplay.`;
    stateSummary = `${medianFps} fps within budget on average, but ${spikeClause}`;
  } else if (hasSpikes) {
    stateLabel = 'Spiky';
    const spikeClause = `${hitchCount} spike${hitchCount === 1 ? '' : 's'} up to ${worstMs.toFixed(0)} ms break smoothness.`;
    stateSummary = `${medianFps} fps on average within the ${targetFps} fps budget, but ${spikeClause}`;
  } else if (stats.overBudgetPct > 10) {
    stateLabel = 'Smooth';
    stateSummary = `Solid ${medianFps} fps: frames are within the ${targetFps} fps budget (${stats.medianMs.toFixed(1)} ms median) with minor variance.`;
  } else {
    stateLabel = 'Smooth';
    stateSummary = `Solid ${medianFps} fps: frames are within the ${targetFps} fps budget (${stats.medianMs.toFixed(1)} ms median).`;
  }

  // Bottleneck attribution
  const {
    hasGameData,
    hasRenderData,
    hasGpuData,
    gameMs: rawGameMs,
    renderMs: rawRenderMs,
    gpuMs: rawGpuMs,
    limitingThread: rawLimiting = 'game',
  } = stats.threadMedians || {};

  const hasGame = hasGameData !== undefined ? Boolean(hasGameData) : rawGameMs != null;
  const hasRender = hasRenderData !== undefined ? Boolean(hasRenderData) : rawRenderMs != null;
  const hasGpu = hasGpuData !== undefined ? Boolean(hasGpuData) : rawGpuMs != null;

  const gameMs = hasGame ? (rawGameMs ?? 0) : 0;
  const renderMs = hasRender ? (rawRenderMs ?? 0) : 0;
  const gpuMs = hasGpu ? (rawGpuMs ?? 0) : 0;

  let limitingThread: LimitingThreadName = 'Unattributed';
  let bottleneckSummary = '';

  if (stateLabel === 'Smooth' && stats.medianMs <= targetMs) {
    if (rawLimiting === 'idle') {
      limitingThread = 'Idle / V-Sync';
      bottleneckSummary = `Execution is healthy and V-Sync / refresh rate limited.`;
    } else if (hasGpu && gpuMs > 0 && gpuMs >= gameMs && gpuMs >= renderMs) {
      limitingThread = 'GPU';
      bottleneckSummary = `GPU takes ${gpuMs.toFixed(1)} ms (within the ${targetMs.toFixed(1)} ms budget).`;
    } else if (hasGame && gameMs > 0 && gameMs >= renderMs) {
      limitingThread = 'Game Thread';
      bottleneckSummary = `Game Thread takes ${gameMs.toFixed(1)} ms (within the ${targetMs.toFixed(1)} ms budget).`;
    } else if (!hasGpu && !hasRender) {
      limitingThread = 'Balanced';
      bottleneckSummary = `Balanced: Game Thread is running within the ${targetMs.toFixed(1)} ms budget (${gameMs.toFixed(1)} ms); GPU and Render channels were not captured.`;
    } else {
      limitingThread = 'Balanced';
      bottleneckSummary = `Balanced: all profiled threads are running well within the ${targetMs.toFixed(1)} ms budget.`;
    }
  } else {
    if (hasGpu && (rawLimiting === 'gpu' || (gpuMs >= gameMs && gpuMs >= renderMs && gpuMs > 0))) {
      limitingThread = 'GPU';
      const isGameWaiting = gameMs > gpuMs;
      const otherText = isGameWaiting
        ? `(Game Thread is waiting on GPU synchronization via Reflex/VSync).`
        : gameMs > 0
        ? `versus ${gameMs.toFixed(1)} ms on the game thread.`
        : 'dominating frame time.';
      bottleneckSummary = `The GPU is the limit: ${gpuMs.toFixed(1)} ms per frame, ${otherText}`;
    } else if (hasRender && (rawLimiting === 'render' || (renderMs >= gameMs && renderMs >= gpuMs && renderMs > 0))) {
      limitingThread = 'Render Thread';
      const otherText = gameMs > 0 ? `versus ${gameMs.toFixed(1)} ms on the game thread.` : 'dominating frame time.';
      bottleneckSummary = `The Render Thread is the limit: ${renderMs.toFixed(1)} ms per frame, ${otherText}`;
    } else if (hasGame && (rawLimiting === 'game' || (gameMs >= renderMs && gameMs > 0))) {
      limitingThread = 'Game Thread';
      const otherText = hasGpu && gpuMs > 0 ? `versus ${gpuMs.toFixed(1)} ms on the GPU.` : 'dominating frame time.';
      bottleneckSummary = `The Game Thread is the limit: ${gameMs.toFixed(1)} ms per frame, ${otherText}`;
    } else if (rawLimiting === 'idle') {
      limitingThread = 'Idle / V-Sync';
      bottleneckSummary = `Execution is idle or V-Sync limited: frames are waiting on display refresh rate.`;
    } else {
      limitingThread = 'Unattributed';
      bottleneckSummary = `No single thread dominates frame time.`;
    }
  }

  return {
    stateLabel,
    stateSummary,
    bottleneckSummary,
    limitingThread,
    budgetGapMs,
    targetFps,
    medianFps,
  };
}
