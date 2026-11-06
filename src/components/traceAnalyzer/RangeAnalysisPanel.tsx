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
  'nanite': { bg: 'bg-rose-950/60', text: 'text-rose-300', border: 'border-rose-500/40' },
  'shadow-depths': { bg: 'bg-red-950/60', text: 'text-red-300', border: 'border-red-500/40' },
  'niagara': { bg: 'bg-pink-950/60', text: 'text-pink-300', border: 'border-pink-500/40' },
  'vsm': { bg: 'bg-red-950/60', text: 'text-red-300', border: 'border-red-500/40' },
  'lumen': { bg: 'bg-pink-950/60', text: 'text-pink-300', border: 'border-pink-500/40' },
  'hzb': { bg: 'bg-amber-950/60', text: 'text-amber-300', border: 'border-amber-500/40' },
  'basepass': { bg: 'bg-orange-950/60', text: 'text-orange-300', border: 'border-orange-500/40' },
  'lighting': { bg: 'bg-yellow-950/60', text: 'text-yellow-300', border: 'border-yellow-500/40' },
  'postprocess': { bg: 'bg-fuchsia-950/60', text: 'text-fuchsia-300', border: 'border-fuchsia-500/40' },
  'translucency': { bg: 'bg-cyan-950/60', text: 'text-cyan-300', border: 'border-cyan-500/40' },
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

function getThreadBadge(role: string) {
  const r = role.toLowerCase();
  let bg = 'bg-slate-800 text-slate-300 border-slate-700';
  let label = role.toUpperCase();

  if (r.includes('rhi')) {
    bg = 'bg-purple-900/60 text-purple-300 border-purple-500/40';
    label = 'RHI';
  } else if (r.includes('gpu')) {
    bg = 'bg-orange-950/60 text-orange-300 border-orange-500/40';
    label = 'GPU';
  } else if (r.includes('render')) {
    bg = 'bg-fuchsia-950/60 text-fuchsia-300 border-fuchsia-500/40';
    label = 'RENDER';
  } else if (r.includes('game')) {
    bg = 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40';
    label = 'GAME';
  }

  return (
    <span className={`inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-mono border ${bg}`}>
      {label}
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
  const [expandedSubsystems, setExpandedSubsystems] = useState<Record<string, boolean>>({});

  const toggleSubsystem = (sub: string) => {
    setExpandedSubsystems((prev) => ({
      ...prev,
      [sub]: !prev[sub],
    }));
  };

  const rangeDesc = useMemo(() => {
    if (!stats) return null;
    return describeRange(stats, targetMs, hitchCount, maxHitchMs);
  }, [stats, targetMs, hitchCount, maxHitchMs]);

  const filteredTimers = useMemo(() => {
    if (!stats?.topTimers) return [];
    if (threadFilter === 'all') return stats.topTimers;
    return stats.topTimers.filter((t) => {
      const role = t.threadRole.toLowerCase();
      if (threadFilter === 'gpu') return role.includes('gpu') || t.bucket.toLowerCase().includes('gpu');
      if (threadFilter === 'game') return role.includes('game') || t.bucket.toLowerCase().includes('blueprint');
      if (threadFilter === 'render') return role.includes('render') || role.includes('rhi') || t.bucket.toLowerCase().includes('render');
      return true;
    });
  }, [stats, threadFilter]);

  // Group work timers by subsystem
  const groupedSubsystems = useMemo(() => {
    const map = new Map<string, { subsystem: string; totalMs: number; timers: RangeTopTimer[] }>();
    for (const t of filteredTimers) {
      const sub = t.subsystem || t.bucket || 'other';
      if (!map.has(sub)) {
        map.set(sub, { subsystem: sub, totalMs: 0, timers: [] });
      }
      const entry = map.get(sub)!;
      entry.totalMs += t.avgMsPerFrame;
      entry.timers.push(t);
    }
    return Array.from(map.values()).sort((a, b) => b.totalMs - a.totalMs);
  }, [filteredTimers]);

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
    waitingOn,
  } = stats;

  const isSteadyOverBudget = budgetGapMs > 0.001;
  const showGapShare = isSteadyOverBudget;
  const maxScaleMs = Math.max(targetMs * 1.5, medianMs * 1.3, maxMs * 0.5, 20.0);

  const stateBadgeStyle =
    rangeDesc.stateLabel === 'Smooth'
      ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
      : rangeDesc.stateLabel === 'Steady Over Budget'
      ? 'bg-amber-950/80 text-amber-300 border-amber-500/50'
      : 'bg-rose-950/80 text-rose-300 border-rose-500/50';

  return (
    <div className="flex flex-col gap-4 p-4 rounded-xl bg-slate-900/40 border border-slate-800">
      {/* Section A: Headline & Diagnosis (FR-7 Verdict) */}
      <div className="flex flex-col gap-2 pb-3 border-b border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${stateBadgeStyle}`}
            >
              {rangeDesc.stateLabel}
            </span>
            <span className="text-xs text-slate-400">
              {stats.frameCount} frames ({stats.durationS.toFixed(2)}s window)
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs font-mono">
            <div>
              <span className="text-slate-400">Median: </span>
              <span className="font-bold text-slate-200">{medianMs.toFixed(1)} ms</span>
            </div>
            <div>
              <span className="text-slate-400">p95: </span>
              <span className="font-bold text-slate-200">{p95Ms.toFixed(1)} ms</span>
            </div>
            <div>
              <span className="text-slate-400">Max: </span>
              <span className="font-bold text-slate-200">{maxMs.toFixed(1)} ms</span>
            </div>
          </div>
        </div>

        {/* Verdict Line */}
        <div className="text-xs leading-relaxed text-slate-300 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/80">
          <p className="font-medium text-slate-200">{rangeDesc.stateSummary}</p>
          <p className="mt-1 text-slate-300">{rangeDesc.bottleneckSummary}</p>
          {isSteadyOverBudget && (
            <p className="mt-1 text-[11px] text-amber-300/90 font-mono">
              Over Budget gap: +{budgetGapMs.toFixed(1)} ms/frame vs {targetMs.toFixed(1)} ms budget ({overBudgetPct.toFixed(0)}% frames over).
            </p>
          )}
        </div>

        {/* Waiting on Section (FR-7) */}
        {waitingOn && waitingOn.length > 0 && (
          <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-start gap-2.5 text-xs">
            <div className="w-2 h-2 rounded-full bg-amber-400 mt-1 shrink-0" />
            <div className="flex flex-col gap-1 text-slate-300 w-full">
              <span className="font-semibold text-slate-200 text-[11px]">CPU Synchronization & Waiting on Hardware:</span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-400">
                {waitingOn.map((w, idx) => (
                  <span key={idx} className="font-mono text-[11px]">
                    <span className="text-slate-300 font-medium uppercase px-1 py-0.2 rounded bg-slate-800 text-[10px] mr-1">
                      {w.thread}
                    </span>
                    <span className="text-amber-300 font-semibold">{w.timer}</span>: {w.avgMsPerFrame.toFixed(1)} ms/frame
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Section B: Thread Active Time Bars */}
      <div className="flex flex-col gap-2 pb-3 border-b border-slate-800">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-300 uppercase tracking-wider text-[11px]">
            Active Hardware Times (Excl. Idle Waits)
          </span>
          <span className="text-slate-400 text-[11px]">
            Target: <span className="font-mono text-sky-400 font-semibold">{targetMs.toFixed(1)} ms</span>
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {/* GPU Bar */}
          <div className="flex flex-col gap-0.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300 font-medium">GPU Rendering (Graphics)</span>
              <span className="text-orange-400 font-mono font-bold">
                {threadMedians.gpuMs > 0 ? `${threadMedians.gpuMs.toFixed(1)} ms` : '0.0 ms'}
              </span>
            </div>
            <div className="h-2.5 rounded bg-slate-800/80 overflow-hidden relative">
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

      {/* Section C: Subsystem-Grouped Top Timers Table (FR-7) */}
      <div className="flex flex-col gap-2 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Profiled Work by Subsystem ({groupedSubsystems.length})
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

        {/* Grouped Table */}
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/80 text-slate-400 font-semibold border-b border-slate-800">
              <tr>
                <th className="py-2 px-3">Subsystem / Function</th>
                <th className="py-2 px-2.5">Thread / Queue</th>
                <th className="py-2 px-2.5 text-right">ms / Frame (vs Base)</th>
                <th className="py-2 px-2.5 text-right">Calls / Frame</th>
                {showGapShare && (
                  <th className="py-2 px-3 text-right">Share of Excess</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {groupedSubsystems.length === 0 ? (
                <tr>
                  <td
                    colSpan={showGapShare ? 5 : 4}
                    className="py-4 text-center text-xs text-slate-500 font-sans"
                  >
                    No profiled work timers found in this window.
                  </td>
                </tr>
              ) : (
                groupedSubsystems.map((grp) => {
                  const isExpanded = expandedSubsystems[grp.subsystem] ?? true;

                  return (
                    <div key={grp.subsystem} className="contents">
                      {/* Subsystem Group Header Row */}
                      <tr
                        onClick={() => toggleSubsystem(grp.subsystem)}
                        className="bg-slate-900/70 hover:bg-slate-800/70 cursor-pointer font-sans transition-colors border-t border-slate-800"
                      >
                        <td className="py-2 px-3 font-semibold text-slate-200 flex items-center gap-2">
                          <span className="text-slate-400 text-[10px]">
                            {isExpanded ? '▼' : '▶'}
                          </span>
                          {getCategoryBadge(grp.subsystem)}
                          <span className="text-xs font-medium text-slate-200 capitalize">
                            {grp.subsystem}
                          </span>
                          <span className="text-[11px] text-slate-400 font-normal">
                            ({grp.timers.length} leaves)
                          </span>
                        </td>
                        <td className="py-2 px-2.5 text-slate-400 text-[11px] font-mono">
                          {grp.timers[0]?.threadRole ? grp.timers[0].threadRole.toUpperCase() : '—'}
                        </td>
                        <td className="py-2 px-2.5 text-right font-bold text-slate-100 font-mono">
                          {grp.totalMs.toFixed(1)} ms
                        </td>
                        <td className="py-2 px-2.5 text-right text-slate-400 font-mono text-[11px]">
                          —
                        </td>
                        {showGapShare && (
                          <td className="py-2 px-3 text-right font-bold text-amber-300 font-mono">
                            {grp.timers[0]?.shareOfThreadExcessPct !== undefined && grp.timers[0]?.shareOfThreadExcessPct !== null
                              ? `${grp.timers[0].shareOfThreadExcessPct.toFixed(0)}%`
                              : '—'}
                          </td>
                        )}
                      </tr>

                      {/* Leaf Rows */}
                      {isExpanded &&
                        grp.timers.map((timer: RangeTopTimer) => {
                          const isSelected = selectedTimerName === timer.name;
                          const baseMs = timer.baselineMsPerFrame || 0;
                          const baseCalls = timer.baselineCallsPerFrame || 0;

                          return (
                            <tr
                              key={`${timer.threadRole}-${timer.name}-${timer.path}`}
                              onClick={() => onSelectTimer?.(isSelected ? null : timer.name)}
                              className={`cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-sky-950/60 hover:bg-sky-900/60'
                                  : 'bg-slate-950/20 hover:bg-slate-900/40'
                              }`}
                            >
                              <td className="py-1.5 pl-8 pr-3 font-mono font-medium text-slate-300 text-xs">
                                <div className="flex flex-col">
                                  <span className="text-slate-200">{timer.name}</span>
                                  {timer.path && timer.path !== timer.name && (
                                    <span className="text-[10px] text-slate-500 font-sans truncate max-w-md" title={timer.path}>
                                      {timer.path}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-1.5 px-2.5">
                                <div className="flex items-center gap-1.5">
                                  {getThreadBadge(timer.threadRole)}
                                  {timer.queue === 'compute' && (
                                    <span className="px-1 py-0.2 rounded text-[9px] font-sans bg-amber-950/50 text-amber-300 border border-amber-600/30">
                                      async compute
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-1.5 px-2.5 text-right text-slate-200">
                                {timer.avgMsPerFrame.toFixed(2)} ms
                                {baseMs > 0 && (
                                  <span className="text-[10px] text-slate-500 ml-1">
                                    (base {baseMs.toFixed(1)})
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 px-2.5 text-right text-slate-400 text-[11px]">
                                {timer.callCount}
                                {baseCalls > 0 && (
                                  <span className="text-[10px] text-slate-500 ml-1">
                                    (base {baseCalls.toFixed(0)})
                                  </span>
                                )}
                              </td>
                              {showGapShare && (
                                <td className="py-1.5 px-3 text-right">
                                  {timer.shareOfThreadExcessPct !== undefined && timer.shareOfThreadExcessPct !== null ? (
                                    <span className="text-amber-400 font-semibold">
                                      {timer.shareOfThreadExcessPct.toFixed(0)}%
                                    </span>
                                  ) : (
                                    <span className="text-slate-500">—</span>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                    </div>
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
