import type { RangeStatisticsResponse } from '../../types/traceAnalyzer';

interface RangeStatisticsPanelProps {
  stats: RangeStatisticsResponse | null;
  targetMs: number;
  isLoading?: boolean;
}

function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return '0.00s';
  }
  const s = Math.max(0, seconds);
  if (s < 60) {
    return `${s.toFixed(2)}s`;
  }
  const mins = Math.floor(s / 60);
  const secs = (s % 60).toFixed(1);
  return `${mins}m ${secs}s`;
}

export function RangeStatisticsPanel({ stats, targetMs, isLoading = false }: RangeStatisticsPanelProps) {
  if (isLoading && !stats) {
    return (
      <div className="bg-slate-900/60 rounded border border-slate-700/60 p-4 flex items-center justify-center min-h-[220px]">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <svg className="animate-spin h-5 w-5 text-sky-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Computing range statistics...</span>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="bg-slate-900/60 rounded border border-slate-700/60 p-4 flex flex-col items-center justify-center text-slate-400 text-sm min-h-[220px]">
        <span className="text-slate-500 mb-1">No Range Selected</span>
        <span className="text-xs text-slate-500">Drag-select any window on the timeline to inspect statistics.</span>
      </div>
    );
  }

  const { pipelineBalance } = stats;
  const gpuPct = Math.round(pipelineBalance.gpuBoundPct);
  const gamePct = Math.round(pipelineBalance.gameBoundPct);
  const renderPct = Math.round(pipelineBalance.renderBoundPct);
  const idlePct = Math.max(0, 100 - gpuPct - gamePct - renderPct);

  // Dominant bottleneck badge
  let dominantLabel = 'Balanced / Smooth';
  let dominantColor = 'bg-sky-500/20 text-sky-300 border-sky-500/30';

  if (gpuPct >= 45 && gpuPct >= gamePct && gpuPct >= renderPct) {
    dominantLabel = 'GPU Bound';
    dominantColor = 'bg-orange-500/20 text-orange-300 border-orange-500/30';
  } else if (gamePct >= 45 && gamePct >= gpuPct && gamePct >= renderPct) {
    dominantLabel = 'Game Thread (CPU) Bound';
    dominantColor = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
  } else if (renderPct >= 40 && renderPct >= gpuPct && renderPct >= gamePct) {
    dominantLabel = 'Render Thread (CPU) Bound';
    dominantColor = 'bg-purple-500/20 text-purple-300 border-purple-500/30';
  } else if (idlePct >= 50) {
    dominantLabel = 'Idle / V-Sync Limited';
    dominantColor = 'bg-slate-700/50 text-slate-300 border-slate-600/50';
  }

  return (
    <div className="bg-slate-900/60 rounded border border-slate-700/60 p-4 flex flex-col gap-3.5 h-full">
      {/* Header with Title and Dominant Badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-200 text-sm">Hardware & Pipeline Balance</span>
          <span className="text-xs text-slate-400">
            ({formatTime(stats.startS)} – {formatTime(stats.endS)})
          </span>
        </div>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${dominantColor}`}>
          {dominantLabel}
        </span>
      </div>

      {/* Hardware Pipeline Balance Meter Bar */}
      <div className="flex flex-col gap-1.5">
        <div className="w-full h-4 bg-slate-800 rounded-full overflow-hidden flex border border-slate-700/80 shadow-inner">
          {gpuPct > 0 && (
            <div
              className="h-full bg-orange-500 hover:bg-orange-400 transition-all cursor-pointer relative group"
              style={{ width: `${gpuPct}%` }}
              title={`GPU Bound: ${gpuPct}%`}
            />
          )}
          {gamePct > 0 && (
            <div
              className="h-full bg-emerald-500 hover:bg-emerald-400 transition-all cursor-pointer relative group"
              style={{ width: `${gamePct}%` }}
              title={`Game Thread: ${gamePct}%`}
            />
          )}
          {renderPct > 0 && (
            <div
              className="h-full bg-purple-500 hover:bg-purple-400 transition-all cursor-pointer relative group"
              style={{ width: `${renderPct}%` }}
              title={`Render Thread: ${renderPct}%`}
            />
          )}
          {idlePct > 0 && (
            <div
              className="h-full bg-sky-600 hover:bg-sky-500 transition-all cursor-pointer relative group"
              style={{ width: `${idlePct}%` }}
              title={`Idle / Wait: ${idlePct}%`}
            />
          )}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-0.5">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" />
            <span className="text-slate-300">GPU:</span>
            <span className="font-mono font-medium text-orange-400">{gpuPct}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
            <span className="text-slate-300">Game:</span>
            <span className="font-mono font-medium text-emerald-400">{gamePct}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-500 inline-block" />
            <span className="text-slate-300">Render:</span>
            <span className="font-mono font-medium text-purple-400">{renderPct}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 inline-block" />
            <span className="text-slate-300">Idle / Wait:</span>
            <span className="font-mono font-medium text-sky-400">{idlePct}%</span>
          </div>
        </div>
      </div>

      {/* Frame Time Health & Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-slate-800">
        <div className="bg-slate-800/50 rounded border border-slate-700/50 p-2 flex flex-col">
          <span className="text-[11px] text-slate-400">Duration / Frames</span>
          <span className="text-sm font-semibold font-mono text-slate-200">
            {stats.durationS.toFixed(2)}s{' '}
            <span className="text-xs font-normal text-slate-400">({stats.frameCount} f)</span>
          </span>
        </div>

        <div className="bg-slate-800/50 rounded border border-slate-700/50 p-2 flex flex-col">
          <span className="text-[11px] text-slate-400">Median Frame</span>
          <span
            className={`text-sm font-semibold font-mono ${
              stats.medianMs > targetMs * 1.25 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {stats.medianMs.toFixed(1)} ms
          </span>
        </div>

        <div className="bg-slate-800/50 rounded border border-slate-700/50 p-2 flex flex-col">
          <span className="text-[11px] text-slate-400">P95 / P99 Tail</span>
          <span className="text-sm font-semibold font-mono text-amber-300">
            {stats.p95Ms.toFixed(1)}{' '}
            <span className="text-xs text-rose-400">/ {stats.p99Ms.toFixed(1)} ms</span>
          </span>
        </div>

        <div className="bg-slate-800/50 rounded border border-slate-700/50 p-2 flex flex-col">
          <span className="text-[11px] text-slate-400">Over Budget</span>
          <span
            className={`text-sm font-semibold font-mono ${
              stats.overBudgetPct > 20 ? 'text-rose-400' : stats.overBudgetPct > 5 ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {stats.overBudgetPct.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}
