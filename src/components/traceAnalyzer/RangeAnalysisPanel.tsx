import { useMemo, useState } from 'react';
import type { RangeStatisticsResponse, RangeTopTimer } from '../../types/traceAnalyzer';
import { describeRange } from '../../utils/traceClassifier';

interface RangeAnalysisPanelProps {
  stats: RangeStatisticsResponse | null;
  targetMs: number;
  hitchCount?: number;
  maxHitchMs?: number;
  isLoading?: boolean;
  selectedTimerName?: string | null;
  onSelectTimer?: (timerName: string | null) => void;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  'Rendering & GPU': { bg: 'bg-orange-950/60', text: 'text-orange-300', border: 'border-orange-500/40' },
  'GPU': { bg: 'bg-orange-950/60', text: 'text-orange-300', border: 'border-orange-500/40' },
  'Render CPU': { bg: 'bg-purple-950/60', text: 'text-purple-300', border: 'border-purple-500/40' },
  'Blueprints & Script': { bg: 'bg-emerald-950/60', text: 'text-emerald-300', border: 'border-emerald-500/40' },
  'Blueprint': { bg: 'bg-emerald-950/60', text: 'text-emerald-300', border: 'border-emerald-500/40' },
  'UI & Slate': { bg: 'bg-sky-950/60', text: 'text-sky-300', border: 'border-sky-500/40' },
  'UI / Slate': { bg: 'bg-sky-950/60', text: 'text-sky-300', border: 'border-sky-500/40' },
  'Garbage Collection': { bg: 'bg-rose-950/60', text: 'text-rose-300', border: 'border-rose-500/40' },
  'GC': { bg: 'bg-rose-950/60', text: 'text-rose-300', border: 'border-rose-500/40' },
  'Animation & Physics': { bg: 'bg-indigo-950/60', text: 'text-indigo-300', border: 'border-indigo-500/40' },
  'Animation': { bg: 'bg-indigo-950/60', text: 'text-indigo-300', border: 'border-indigo-500/40' },
  'Physics': { bg: 'bg-indigo-950/60', text: 'text-indigo-300', border: 'border-indigo-500/40' },
  'Asset Loading & Streaming': { bg: 'bg-amber-950/60', text: 'text-amber-300', border: 'border-amber-500/40' },
  'Loading': { bg: 'bg-amber-950/60', text: 'text-amber-300', border: 'border-amber-500/40' },
  'Streaming': { bg: 'bg-amber-950/60', text: 'text-amber-300', border: 'border-amber-500/40' },
};

function getCategoryBadge(bucketOrCategory: string) {
  const c = CATEGORY_COLORS[bucketOrCategory] || {
    bg: 'bg-slate-800',
    text: 'text-slate-300',
    border: 'border-slate-700',
  };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${c.bg} ${c.text} ${c.border}`}
    >
      {bucketOrCategory}
    </span>
  );
}

export function RangeAnalysisPanel({
  stats,
  targetMs,
  hitchCount = 0,
  maxHitchMs,
  isLoading = false,
  selectedTimerName,
  onSelectTimer,
}: RangeAnalysisPanelProps) {
  const [threadFilter, setThreadFilter] = useState<'all' | 'gpu' | 'game' | 'render'>('all');

  const rangeDesc = useMemo(() => {
    if (!stats) return null;
    return describeRange(stats, targetMs, hitchCount, maxHitchMs);
  }, [stats, targetMs, hitchCount, maxHitchMs]);

  const filteredTimers = useMemo(() => {
    if (!stats?.topTimers) return [];
    if (threadFilter === 'all') return stats.topTimers.slice(0, 15);
    return stats.topTimers
      .filter((t) => {
        const role = t.threadRole.toLowerCase();
        if (threadFilter === 'gpu') return role.includes('gpu') || t.bucket.toLowerCase().includes('gpu');
        if (threadFilter === 'game') return role.includes('game') || t.bucket.toLowerCase().includes('blueprint');
        if (threadFilter === 'render') return role.includes('render') || t.bucket.toLowerCase().includes('render');
        return true;
      })
      .slice(0, 15);
  }, [stats, threadFilter]);

  if (isLoading) {
    return (
      <div className="p-6 rounded-xl bg-slate-900/60 border border-slate-800 text-center animate-pulse">
        <div className="text-xs text-slate-400">Computing selected range metrics...</div>
      </div>
    );
  }

  if (!stats || !rangeDesc) {
    return (
      <div className="p-6 rounded-xl bg-slate-900/40 border border-slate-800 text-center text-xs text-slate-500">
        Select a range on the timeline to inspect frame health, bottleneck threads, and top timer costs.
      </div>
    );
  }

  const {
    medianMs,
    p95Ms,
    maxMs,
    overBudgetPct,
    budgetGapMs,
    threadMedians,
  } = stats;

  const isOverBudget = budgetGapMs > 0.001;
  const maxScaleMs = Math.max(targetMs * 1.5, medianMs * 1.3, maxMs * 0.5, 20.0);

  const stateBadgeStyle =
    rangeDesc.stateLabel === 'Smooth'
      ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
      : rangeDesc.stateLabel === 'Steady Over Budget'
      ? 'bg-amber-950/80 text-amber-300 border-amber-500/50'
      : 'bg-rose-950/80 text-rose-300 border-rose-500/50';

  const limitingLabel =
    rangeDesc.limitingThread === 'GPU'
      ? 'GPU-bound'
      : rangeDesc.limitingThread === 'Game Thread'
      ? 'Game-bound'
      : rangeDesc.limitingThread === 'Render Thread'
      ? 'Render-bound'
      : rangeDesc.limitingThread === 'Idle / V-Sync'
      ? 'Idle / V-Sync limited'
      : 'Unattributed';

  return (
    <div className="flex flex-col gap-3.5 p-4 rounded-xl bg-slate-900/70 border border-slate-800 shadow-lg">
      {/* Title & State Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-slate-200 tracking-wide">
            What is happening in this range
          </h2>
          <span className={`px-2 py-0.5 rounded text-xs font-semibold border ${stateBadgeStyle}`}>
            {rangeDesc.stateLabel}
          </span>
        </div>
        <div className="text-xs text-slate-400">
          Target: <strong className="text-sky-300 font-mono">{targetMs.toFixed(1)} ms</strong> ({rangeDesc.targetFps} fps)
        </div>
      </div>

      {/* Grid: Frame Time Health (Left) + Thread Bottleneck (Right) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {/* Section A: Frame Time Health */}
        <div className="flex flex-col gap-2.5 p-3 rounded-lg bg-slate-950/40 border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Frame Health vs Budget
            </span>
            {isOverBudget ? (
              <span className="text-xs text-rose-400 font-semibold font-mono">
                +{budgetGapMs.toFixed(1)} ms over budget
              </span>
            ) : (
              <span className="text-xs text-emerald-400 font-semibold font-mono">
                Under budget
              </span>
            )}
          </div>

          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
              <div className="text-[11px] text-slate-400">Median</div>
              <div className="text-sm font-bold text-slate-100 font-mono mt-0.5">
                {medianMs.toFixed(1)} <span className="text-[11px] font-normal text-slate-400">ms</span>
              </div>
              <div className="text-[11px] text-slate-500 font-mono">
                {rangeDesc.medianFps} fps
              </div>
            </div>

            <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
              <div className="text-[11px] text-slate-400">p95</div>
              <div className="text-sm font-bold text-slate-100 font-mono mt-0.5">
                {p95Ms.toFixed(1)} <span className="text-[11px] font-normal text-slate-400">ms</span>
              </div>
              <div className="text-[11px] text-slate-500 font-mono">
                {p95Ms > 0 ? `${Math.round(1000 / p95Ms)} fps` : '-'}
              </div>
            </div>

            <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
              <div className="text-[11px] text-slate-400">Worst (Max)</div>
              <div className="text-sm font-bold text-rose-300 font-mono mt-0.5">
                {maxMs.toFixed(1)} <span className="text-[11px] font-normal text-slate-400">ms</span>
              </div>
              <div className="text-[11px] text-slate-500 font-mono">
                {maxMs > 0 ? `${Math.round(1000 / maxMs)} fps` : '-'}
              </div>
            </div>

            <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
              <div className="text-[11px] text-slate-400">Over Budget</div>
              <div className={`text-sm font-bold font-mono mt-0.5 ${overBudgetPct > 20 ? 'text-amber-300' : 'text-slate-200'}`}>
                {overBudgetPct.toFixed(0)}%
              </div>
              <div className="text-[11px] text-slate-500">
                of frames
              </div>
            </div>
          </div>
        </div>

        {/* Section B: Bottleneck Threads */}
        <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-950/40 border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Thread Bottleneck
            </span>
            <span className="px-2 py-0.5 rounded bg-sky-950/80 text-sky-300 border border-sky-500/40 text-xs font-bold">
              {limitingLabel}
            </span>
          </div>

          <div className="flex flex-col gap-2 mt-1">
            {/* GPU Bar */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-300 font-medium">GPU Thread</span>
                <span className="text-orange-400 font-mono font-bold">
                  {threadMedians.gpuMs > 0 ? `${threadMedians.gpuMs.toFixed(1)} ms` : 'No GPU channel'}
                </span>
              </div>
              <div className="h-2.5 rounded bg-slate-800/80 overflow-hidden relative">
                {/* Budget line indicator */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-sky-400/80 z-10"
                  style={{ left: `${Math.min(100, (targetMs / maxScaleMs) * 100)}%` }}
                  title={`Target budget: ${targetMs.toFixed(1)} ms`}
                />
                <div
                  className="h-full bg-gradient-to-r from-orange-600 to-orange-400 rounded transition-all duration-300"
                  style={{ width: `${Math.min(100, (threadMedians.gpuMs / maxScaleMs) * 100)}%` }}
                />
              </div>
            </div>

            {/* Game Thread Bar */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-300 font-medium">Game Thread</span>
                <span className="text-emerald-400 font-mono font-bold">
                  {threadMedians.gameMs > 0 ? `${threadMedians.gameMs.toFixed(1)} ms` : '0.0 ms'}
                </span>
              </div>
              <div className="h-2.5 rounded bg-slate-800/80 overflow-hidden relative">
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-sky-400/80 z-10"
                  style={{ left: `${Math.min(100, (targetMs / maxScaleMs) * 100)}%` }}
                  title={`Target budget: ${targetMs.toFixed(1)} ms`}
                />
                <div
                  className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded transition-all duration-300"
                  style={{ width: `${Math.min(100, (threadMedians.gameMs / maxScaleMs) * 100)}%` }}
                />
              </div>
            </div>

            {/* Render Thread Bar */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-300 font-medium">Render Thread</span>
                <span className="text-purple-400 font-mono font-bold">
                  {threadMedians.renderMs > 0 ? `${threadMedians.renderMs.toFixed(1)} ms` : '0.0 ms'}
                </span>
              </div>
              <div className="h-2.5 rounded bg-slate-800/80 overflow-hidden relative">
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-sky-400/80 z-10"
                  style={{ left: `${Math.min(100, (targetMs / maxScaleMs) * 100)}%` }}
                  title={`Target budget: ${targetMs.toFixed(1)} ms`}
                />
                <div
                  className="h-full bg-gradient-to-r from-purple-600 to-purple-400 rounded transition-all duration-300"
                  style={{ width: `${Math.min(100, (threadMedians.renderMs / maxScaleMs) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Section C: Top Timers Table */}
      <div className="flex flex-col gap-2 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Top Timers in Range ({filteredTimers.length})
            </span>
            {selectedTimerName && (
              <button
                type="button"
                onClick={() => onSelectTimer?.(null)}
                className="text-[11px] text-sky-400 hover:text-sky-300 underline"
              >
                Clear filter ({selectedTimerName})
              </button>
            )}
          </div>

          {/* Thread Filter Chips */}
          <div className="flex items-center gap-1 text-xs">
            {(['all', 'gpu', 'game', 'render'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setThreadFilter(mode)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  threadFilter === mode
                    ? 'bg-sky-600 text-white font-semibold'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {mode === 'all' ? 'All Threads' : mode.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Timers Table */}
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/80 text-slate-400 font-semibold border-b border-slate-800">
              <tr>
                <th className="py-2 px-3">Timer Scope</th>
                <th className="py-2 px-2.5">Category</th>
                <th className="py-2 px-2.5 text-right">ms / Frame</th>
                <th className="py-2 px-2.5 text-right">Calls</th>
                {isOverBudget && (
                  <th className="py-2 px-3 text-right">Share of Gap</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredTimers.length === 0 ? (
                <tr>
                  <td
                    colSpan={isOverBudget ? 5 : 4}
                    className="py-4 text-center text-xs text-slate-500 font-sans"
                  >
                    No profiled timer records found in this window.
                  </td>
                </tr>
              ) : (
                filteredTimers.map((timer: RangeTopTimer) => {
                  const isSelected = selectedTimerName === timer.name;
                  return (
                    <tr
                      key={`${timer.threadRole}-${timer.name}`}
                      onClick={() => onSelectTimer?.(isSelected ? null : timer.name)}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-sky-950/70 text-sky-200'
                          : 'hover:bg-slate-800/50'
                      }`}
                    >
                      <td className="py-2 px-3 font-sans font-medium text-slate-200 max-w-[280px] truncate" title={timer.name}>
                        {timer.name}
                      </td>
                      <td className="py-2 px-2.5 font-sans">
                        {getCategoryBadge(timer.bucket)}
                      </td>
                      <td className="py-2 px-2.5 text-right font-bold text-slate-100">
                        {timer.avgMsPerFrame.toFixed(2)} ms
                      </td>
                      <td className="py-2 px-2.5 text-right text-slate-400">
                        {timer.callCount.toLocaleString()}
                      </td>
                      {isOverBudget && (
                        <td className="py-2 px-3 text-right">
                          {timer.shareOfBudgetGapPct !== undefined && timer.shareOfBudgetGapPct !== null ? (
                            <span className="font-semibold text-amber-300">
                              {timer.shareOfBudgetGapPct.toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-slate-500">-</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
