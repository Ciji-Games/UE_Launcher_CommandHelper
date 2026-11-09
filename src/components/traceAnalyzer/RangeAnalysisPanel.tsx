import { useMemo, useState } from 'react';
import type { Finding, RangeStatisticsResponse, RangeTopTimer } from '../../types/traceAnalyzer';

interface RangeAnalysisPanelProps {
  stats: RangeStatisticsResponse | null;
  targetMs: number;
  topFinding?: Finding | null;
  hitchCount?: number;
  maxHitchMs?: number;
  isLoading?: boolean;
  selectedTimerName?: string | null;
  onSelectTimer?: (timerName: string | null) => void;
  onSeeDetails?: () => void;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  'Rendering & GPU': { bg: 'bg-orange-950/60', text: 'text-orange-300', border: 'border-orange-500/40' },
  'GPU': { bg: 'bg-orange-950/60', text: 'text-orange-300', border: 'border-orange-500/40' },
  'Render CPU': { bg: 'bg-purple-950/60', text: 'text-purple-300', border: 'border-purple-500/40' },
  'Blueprints & Script': { bg: 'bg-emerald-950/60', text: 'text-emerald-300', border: 'border-emerald-500/40' },
  'Blueprint': { bg: 'bg-emerald-950/60', text: 'text-emerald-300', border: 'border-emerald-500/40' },
  'UI & Slate': { bg: 'bg-sky-950/60', text: 'text-sky-300', border: 'border-sky-500/40' },
  'Garbage Collection': { bg: 'bg-rose-950/60', text: 'text-rose-300', border: 'border-rose-500/40' },
  'GC': { bg: 'bg-rose-950/60', text: 'text-rose-300', border: 'border-rose-500/40' },
  'Animation & Physics': { bg: 'bg-indigo-950/60', text: 'text-indigo-300', border: 'border-indigo-500/40' },
  'Animation': { bg: 'bg-indigo-950/60', text: 'text-indigo-300', border: 'border-indigo-500/40' },
  'Physics': { bg: 'bg-indigo-950/60', text: 'text-indigo-300', border: 'border-indigo-500/40' },
  'Asset Loading & Streaming': { bg: 'bg-amber-950/60', text: 'text-amber-300', border: 'border-amber-500/40' },
  'Loading': { bg: 'bg-amber-950/60', text: 'text-amber-300', border: 'border-amber-500/40' },
  'Other': { bg: 'bg-slate-800', text: 'text-slate-300', border: 'border-slate-700' },
};

function getCategoryBadge(bucketOrCategory: string) {
  const c = CATEGORY_COLORS[bucketOrCategory] || CATEGORY_COLORS.Other;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${c.bg} ${c.text} ${c.border}`}
    >
      {bucketOrCategory}
    </span>
  );
}

function normalizeSubsystemName(rawName: string, threadRole: string = 'game'): string {
  const lower = rawName.toLowerCase();
  if (lower.includes('rdg') || lower.includes('rendergraph') || lower.includes('gpu') || lower.includes('shading') || lower.includes('lighting') || lower.includes('shadow') || lower.includes('nanite') || lower.includes('lumen')) {
    return 'Rendering & GPU';
  }
  if (lower.includes('render') || lower.includes('rhi') || lower.includes('initview') || threadRole.toLowerCase().includes('render')) {
    return 'Render CPU';
  }
  if (lower.includes('blueprint') || lower.includes('script') || lower.includes('bp')) {
    return 'Blueprints & Script';
  }
  if (lower.includes('ui') || lower.includes('slate')) {
    return 'UI & Slate';
  }
  if (lower.includes('gc') || lower.includes('garbage')) {
    return 'Garbage Collection';
  }
  if (lower.includes('anim') || lower.includes('physics') || lower.includes('chaos')) {
    return 'Animation & Physics';
  }
  if (lower.includes('load') || lower.includes('stream') || lower.includes('io')) {
    return 'Asset Loading & Streaming';
  }
  if (lower === 'other' || lower === 'unclassified' || lower === 'unknown' || lower === 'misc') {
    return 'Other';
  }
  return rawName.charAt(0).toUpperCase() + rawName.slice(1);
}

export function RangeAnalysisPanel({
  stats,
  targetMs,
  topFinding,
  hitchCount = 0,
  maxHitchMs,
  isLoading = false,
  selectedTimerName,
  onSelectTimer,
  onSeeDetails,
}: RangeAnalysisPanelProps) {
  const [threadFilter, setThreadFilter] = useState<'all' | 'gpu' | 'game' | 'render'>('all');
  const [expandedSubsystems, setExpandedSubsystems] = useState<Record<string, boolean>>({});
  const [showAllSubsystems, setShowAllSubsystems] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  const toggleSubsystem = (sub: string) => {
    setExpandedSubsystems((prev) => ({
      ...prev,
      [sub]: !prev[sub],
    }));
  };

  // 1. Verdict (2 Sentences: State & Bottleneck with waiting folded in)
  const verdict = useMemo(() => {
    if (!stats) return null;
    const { medianMs, overBudgetPct, threadMedians, waitingOn } = stats;
    const isOverBudget = medianMs > targetMs || overBudgetPct > 15 || hitchCount > 0;
    const worstMs = maxHitchMs !== undefined && maxHitchMs > 0 ? maxHitchMs : stats.maxMs;
    const { gameMs = 0, renderMs = 0, gpuMs = 0, limitingThread = 'game' } = threadMedians || {};

    const hasGpuWait =
      waitingOn?.some(
        (w) =>
          w.timer.toLowerCase().includes('reflex') ||
          w.timer.toLowerCase().includes('gpu') ||
          w.timer.toLowerCase().includes('waitforgpu')
      ) || (gameMs > gpuMs && gpuMs > targetMs);

    const hasWorkerWait = waitingOn?.some(
      (w) =>
        w.timer.toLowerCase().includes('waitfortask') ||
        w.timer.toLowerCase().includes('taskgraph')
    );

    let stateSentence = '';
    if (!isOverBudget) {
      stateSentence = `Smooth: frames average ${medianMs.toFixed(1)} ms per frame, within the ${targetMs.toFixed(1)} ms budget.`;
    } else if (hitchCount > 0 && medianMs <= targetMs) {
      stateSentence = `Spiky: frames average ${medianMs.toFixed(1)} ms per frame, but ${hitchCount} hitch spike${hitchCount === 1 ? '' : 's'} (up to ${worstMs.toFixed(0)} ms) break smoothness.`;
    } else if (hitchCount > 0) {
      stateSentence = `Steady over budget: ${overBudgetPct.toFixed(0)}% of frames exceed the ${targetMs.toFixed(1)} ms budget (median ${medianMs.toFixed(1)} ms per frame), with ${hitchCount} hitch spike${hitchCount === 1 ? '' : 's'}.`;
    } else {
      stateSentence = `Steady over budget: ${overBudgetPct.toFixed(0)}% of frames exceed the ${targetMs.toFixed(1)} ms budget with a median of ${medianMs.toFixed(1)} ms per frame.`;
    }

    let bottleneckSentence = '';
    if (!isOverBudget) {
      bottleneckSentence = `Balanced: all threads (Game, Render, GPU) are running within budget.`;
    } else if (limitingThread === 'gpu' || (gpuMs >= gameMs && gpuMs >= renderMs && gpuMs > 0)) {
      if (hasGpuWait) {
        bottleneckSentence = `GPU-bound: ${gpuMs.toFixed(1)} ms per frame against a ${targetMs.toFixed(1)} ms budget; the game thread is waiting on it.`;
      } else {
        bottleneckSentence = `GPU-bound: ${gpuMs.toFixed(1)} ms per frame against a ${targetMs.toFixed(1)} ms budget.`;
      }
    } else if (limitingThread === 'game' || (gameMs >= renderMs && gameMs > 0)) {
      if (hasWorkerWait) {
        bottleneckSentence = `Game-bound: ${gameMs.toFixed(1)} ms per frame against a ${targetMs.toFixed(1)} ms budget; the game thread is stalled waiting on worker tasks.`;
      } else {
        bottleneckSentence = `Game-bound: ${gameMs.toFixed(1)} ms per frame against a ${targetMs.toFixed(1)} ms budget.`;
      }
    } else if (limitingThread === 'render' || renderMs > 0) {
      bottleneckSentence = `Render-bound: ${renderMs.toFixed(1)} ms per frame against a ${targetMs.toFixed(1)} ms budget.`;
    } else if (limitingThread === 'idle') {
      bottleneckSentence = `V-Sync limited: frames are waiting on display refresh rate.`;
    } else {
      bottleneckSentence = `Unattributed: frame execution is distributed across threads.`;
    }

    return { isOverBudget, stateSentence, bottleneckSentence };
  }, [stats, targetMs, hitchCount, maxHitchMs]);

  // 2. Filtered Timers and Subsystem Grouping
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

  const groupedSubsystems = useMemo(() => {
    const map = new Map<string, { subsystem: string; totalMs: number; timers: RangeTopTimer[] }>();
    for (const t of filteredTimers) {
      const sub = normalizeSubsystemName(t.subsystem || t.bucket || 'Other', t.threadRole);
      if (!map.has(sub)) {
        map.set(sub, { subsystem: sub, totalMs: 0, timers: [] });
      }
      const entry = map.get(sub)!;
      entry.totalMs += t.avgMsPerFrame;
      entry.timers.push(t);
    }

    const all = Array.from(map.values());
    const otherGroup = all.find((g) => g.subsystem === 'Other');
    const mainGroups = all.filter((g) => g.subsystem !== 'Other').sort((a, b) => b.totalMs - a.totalMs);

    if (otherGroup) {
      return [...mainGroups, otherGroup];
    }
    return mainGroups;
  }, [filteredTimers]);

  if (isLoading) {
    return (
      <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-center animate-pulse text-xs text-slate-400">
        Computing selected range metrics...
      </div>
    );
  }

  if (!stats || !verdict) {
    return (
      <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 text-center text-xs text-slate-500">
        Select a range on the timeline to inspect performance metrics and bottleneck attribution.
      </div>
    );
  }

  const { medianMs, p95Ms, overBudgetPct, threadMedians, waitingOn } = stats;
  const {
    gameMs = 0,
    activeGameMs = gameMs,
    waitGameMs = 0,
    renderMs = 0,
    activeRenderMs = renderMs,
    waitRenderMs = 0,
    gpuMs = 0,
    activeGpuMs = gpuMs,
    waitGpuMs = 0,
  } = threadMedians || {};
  const isOverBudget = verdict.isOverBudget;

  // Active hardware time bars scaling: max(value, budget) * 1.1, clamp fill to 100%, budget marker at true position
  const maxThreadVal = Math.max(activeGpuMs + waitGpuMs, activeGameMs + waitGameMs, activeRenderMs + waitRenderMs, targetMs);
  const axisMax = Math.max(maxThreadVal, targetMs) * 1.1;
  const budgetMarkerPct = Math.min(100, Math.max(0, (targetMs / axisMax) * 100));

  // Waiting condition: shown inline ONLY when waits are >= 30% of the frame AND frame is over budget
  const totalWaitMs = (waitingOn || []).reduce((sum, w) => sum + w.avgMsPerFrame, 0);
  const isSignificantWait = totalWaitMs >= medianMs * 0.30;
  const showInlineWaiting = isSignificantWait && isOverBudget && (waitingOn && waitingOn.length > 0);

  // First thing to try (first step of top finding)
  const firstFix = topFinding?.parsedPayload?.fixes?.[0];

  const displayedSubsystems = showAllSubsystems ? groupedSubsystems : groupedSubsystems.slice(0, 5);

  const renderThreadBar = (label: string, activeMs: number, waitMs: number, role: 'gpu' | 'game' | 'render') => {
    const isThreadOver = activeMs > targetMs;
    const isExtreme = activeMs > targetMs * 3.0;
    const activeFillPct = Math.min(100, Math.max(0, (activeMs / axisMax) * 100));
    const waitFillPct = Math.min(100 - activeFillPct, Math.max(0, (waitMs / axisMax) * 100));
    const multiple = (activeMs / targetMs).toFixed(1);

    let barColor = 'bg-emerald-500';
    let textColor = 'text-emerald-400 font-mono';
    if (isThreadOver) {
      if (role === 'gpu') {
        barColor = 'bg-orange-500';
        textColor = 'text-orange-400 font-bold font-mono';
      } else if (role === 'game') {
        barColor = 'bg-amber-500';
        textColor = 'text-amber-400 font-bold font-mono';
      } else {
        barColor = 'bg-purple-500';
        textColor = 'text-purple-400 font-bold font-mono';
      }
    }

    return (
      <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-300 font-medium">{label}</span>
          <div className="flex items-center gap-1.5">
            <span className={textColor}>
              {activeMs.toFixed(1)} ms
              {waitMs >= 0.1 && (
                <span className="text-slate-400 font-normal text-[11px] ml-1">
                  (+{waitMs.toFixed(1)} ms wait)
                </span>
              )}
            </span>
            {isExtreme && (
              <span className="text-[10px] px-1 py-0.2 rounded bg-rose-950/80 text-rose-300 border border-rose-500/40 font-mono">
                x {multiple} over budget
              </span>
            )}
          </div>
        </div>
        <div className="h-2 rounded bg-slate-800/80 overflow-hidden relative flex">
          {/* Target Budget Marker */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-sky-300/90 z-10"
            style={{ left: `${budgetMarkerPct}%` }}
            title={`Target budget: ${targetMs.toFixed(1)} ms/frame`}
          />
          {/* Active Work fill bar */}
          <div
            className={`h-full ${barColor} rounded-l transition-all duration-300`}
            style={{ width: `${activeFillPct}%` }}
            title={`Active work: ${activeMs.toFixed(1)} ms/frame`}
          />
          {/* Wait Segment (hatched) */}
          {waitMs >= 0.1 && (
            <div
              className="h-full bg-slate-600/70 opacity-80 border-l border-slate-900/40 transition-all duration-300 relative"
              style={{
                width: `${waitFillPct}%`,
                backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.15) 2px, rgba(255,255,255,0.15) 4px)',
              }}
              title={`Idle/Sync wait: ${waitMs.toFixed(1)} ms/frame`}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 5. Range Card */}
      <div
        className={`flex flex-col gap-3 p-4 rounded-xl border shadow-md transition-all ${
          isOverBudget
            ? 'bg-slate-900/80 border-slate-800'
            : 'bg-slate-900/50 border-slate-800'
        }`}
      >
        {/* Top: 2-Sentence Verdict & 3 Core Numbers */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 pb-3 border-b border-slate-800/80">
          {/* Left: Verdict (2 Sentences) */}
          <div className="flex-1 flex flex-col gap-1 text-xs leading-relaxed">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${
                  isOverBudget
                    ? 'bg-amber-950/60 text-amber-300 border-amber-500/40'
                    : 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40'
                }`}
              >
                {isOverBudget ? 'Over Budget' : 'Within Budget'}
              </span>
              <span className="text-slate-400 font-mono text-[11px]">
                {stats.frameCount.toLocaleString()} frames ({stats.durationS.toFixed(2)}s)
              </span>
            </div>

            <p className="font-semibold text-slate-100 mt-0.5">{verdict.stateSentence}</p>
            <p className="text-slate-300">{verdict.bottleneckSentence}</p>
          </div>

          {/* Right: Three Numbers (ms per frame) */}
          <div className="flex items-center gap-4 bg-slate-950/60 border border-slate-800 rounded-lg p-2.5 shrink-0 text-xs font-mono">
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-400 font-sans uppercase">Median</span>
              <span className="font-bold text-slate-100">{medianMs.toFixed(1)} ms/frame</span>
            </div>
            <div className="w-px h-7 bg-slate-800" />
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-400 font-sans uppercase">p95</span>
              <span className={`font-bold ${p95Ms > targetMs ? 'text-amber-300' : 'text-slate-100'}`}>
                {p95Ms.toFixed(1)} ms/frame
              </span>
            </div>
            <div className="w-px h-7 bg-slate-800" />
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-400 font-sans uppercase">Over Budget</span>
              <span className={`font-bold ${overBudgetPct > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
                {overBudgetPct.toFixed(0)}%
              </span>
            </div>
          </div>
        </div>

        {/* Middle: Active Hardware Times Bars */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="font-semibold text-slate-300 uppercase tracking-wider">
              Active Hardware Times
            </span>
            <span className="font-mono">
              Target: <strong className="text-sky-300">{targetMs.toFixed(1)} ms/frame</strong>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {renderThreadBar('GPU', activeGpuMs, waitGpuMs, 'gpu')}
            {renderThreadBar('Game Thread', activeGameMs, waitGameMs, 'game')}
            {renderThreadBar('Render Thread', activeRenderMs, waitRenderMs, 'render')}
          </div>
        </div>

        {/* Bottom: "First thing to try" (first step of top finding) */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-sky-400 font-bold shrink-0">First thing to try:</span>
            {isOverBudget && firstFix ? (
              <span className="text-slate-200 leading-snug">
                {firstFix.text}
                {onSeeDetails && (
                  <button
                    type="button"
                    onClick={onSeeDetails}
                    className="ml-2 text-sky-400 hover:text-sky-300 font-medium underline inline-flex items-center gap-0.5"
                  >
                    <span>see details</span>
                    <span className="text-[10px]">↓</span>
                  </button>
                )}
              </span>
            ) : (
              <span className="text-emerald-300 font-medium">
                No performance bottlenecks detected in this range (all frames within the {targetMs.toFixed(1)} ms budget).
              </span>
            )}
          </div>
        </div>

        {/* Inline Waiting & Sync (Shown ONLY when waits >= 30% of frame AND frame is over budget) */}
        {showInlineWaiting && (
          <div className="p-2.5 rounded-lg bg-amber-950/20 border border-amber-600/30 flex items-start gap-2.5 text-xs mt-1">
            <span className="text-amber-400 font-bold shrink-0 mt-0.5">⚠️</span>
            <div className="flex flex-col gap-1 text-slate-300 w-full">
              <span className="font-semibold text-amber-300 text-[11px]">
                High CPU Synchronization &amp; Waiting on Hardware (≥30% of frame time):
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-300 font-mono text-[11px]">
                {waitingOn.map((w, idx) => (
                  <span key={idx}>
                    <span className="text-slate-400 uppercase mr-1">{w.thread}:</span>
                    <strong className="text-amber-300">{w.timer}</strong> ({w.avgMsPerFrame.toFixed(1)} ms/frame)
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Details & Subsystem Breakdown Accordion (Included inside the card, below general diagnostic & warning) */}
        <div className="flex flex-col border border-slate-800 rounded-lg overflow-hidden bg-slate-900/40 mt-1">
          <button
            type="button"
            onClick={() => setIsDetailsOpen(!isDetailsOpen)}
            className="flex items-center justify-between p-2.5 bg-slate-900/60 hover:bg-slate-800/60 text-xs font-semibold text-slate-300 transition-colors"
          >
            <div className="flex items-center gap-2">
              <svg
                className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${isDetailsOpen ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span>Details &amp; Subsystem Breakdown</span>
            </div>
            <span className="text-[11px] font-normal text-slate-400 font-mono">
              {groupedSubsystems.length} subsystems • {stats.topTimers?.length || 0} work timers
            </span>
          </button>

          {isDetailsOpen && (
            <div className="flex flex-col gap-3 p-3 border-t border-slate-800 bg-slate-950/40 text-xs">
              {/* Section 1: Waiting and Synchronization (Neutral style when not shown inline) */}
              {!showInlineWaiting && waitingOn && waitingOn.length > 0 && (
                <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-slate-900/60 border border-slate-800">
                  <span className="font-semibold text-slate-300 uppercase tracking-wider text-[11px]">
                    CPU Synchronization &amp; Wait Timers
                  </span>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-300 font-mono text-[11px]">
                    {waitingOn.map((w, idx) => (
                      <span key={idx}>
                        <span className="text-slate-400 uppercase mr-1">{w.thread}:</span>
                        <span className="text-slate-200">{w.timer}</span> ({w.avgMsPerFrame.toFixed(1)} ms/frame)
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Section 2: Where the time goes by system (Subsystem Table) */}
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-300 uppercase tracking-wider text-[11px]">
                      Where the Time Goes by System
                    </span>
                    {selectedTimerName && (
                      <button
                        type="button"
                        onClick={() => onSelectTimer?.(null)}
                        className="text-[11px] text-sky-400 hover:text-sky-300 underline font-mono"
                      >
                        Clear filter ({selectedTimerName})
                      </button>
                    )}
                  </div>

                  {/* Thread Filters */}
                  <div className="flex items-center gap-1">
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
                        {mode === 'all' ? 'All' : mode.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Subsystems Table */}
                <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/40">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-900/90 text-slate-400 font-semibold border-b border-slate-800 text-[11px]">
                      <tr>
                        <th className="py-2 px-3">Subsystem / Function</th>
                        <th className="py-2 px-2.5">Thread</th>
                        <th className="py-2 px-2.5 text-right">ms / Frame</th>
                        <th className="py-2 px-2.5 text-right">Calls / Frame</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                      {displayedSubsystems.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-4 text-center text-slate-500 font-sans">
                            No profiled work timers found for this selection.
                          </td>
                        </tr>
                      ) : (
                        displayedSubsystems.map((grp) => {
                          const isExpanded = expandedSubsystems[grp.subsystem] ?? false;

                          return (
                            <div key={grp.subsystem} className="contents">
                              {/* Group Header Row */}
                              <tr
                                onClick={() => toggleSubsystem(grp.subsystem)}
                                className="bg-slate-900/80 hover:bg-slate-800/80 cursor-pointer font-sans transition-colors border-t border-slate-800"
                              >
                                <td className="py-2 px-3 font-semibold text-slate-200 flex items-center gap-2">
                                  <svg
                                    className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                  </svg>
                                  {getCategoryBadge(grp.subsystem)}
                                  <span className="text-xs font-medium text-slate-200">
                                    {grp.subsystem}
                                  </span>
                                  <span className="text-[11px] text-slate-500 font-normal">
                                    ({grp.timers.length} timer{grp.timers.length === 1 ? '' : 's'})
                                  </span>
                                </td>
                                <td className="py-2 px-2.5 text-slate-400 font-mono text-[11px]">
                                  {grp.timers[0]?.threadRole ? grp.timers[0].threadRole.toUpperCase() : '—'}
                                </td>
                                <td className="py-2 px-2.5 text-right font-bold text-slate-100 font-mono">
                                  {grp.totalMs.toFixed(1)} ms
                                </td>
                                <td className="py-2 px-2.5 text-right text-slate-400 font-mono text-[11px]">
                                  —
                                </td>
                              </tr>

                              {/* Leaf Rows */}
                              {isExpanded &&
                                grp.timers.map((timer: RangeTopTimer) => {
                                  const isSelected = selectedTimerName === timer.name;

                                  return (
                                    <tr
                                      key={`${timer.threadRole}-${timer.name}-${timer.path}`}
                                      onClick={() => onSelectTimer?.(isSelected ? null : timer.name)}
                                      className={`cursor-pointer transition-colors ${
                                        isSelected
                                          ? 'bg-sky-950/60 hover:bg-sky-900/60'
                                          : 'bg-slate-950/30 hover:bg-slate-900/50'
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
                                      <td className="py-1.5 px-2.5 text-slate-400 text-[10px] font-mono">
                                        {timer.threadRole.toUpperCase()}
                                      </td>
                                      <td className="py-1.5 px-2.5 text-right font-bold text-slate-200 font-mono">
                                        {timer.avgMsPerFrame.toFixed(1)} ms
                                      </td>
                                      <td className="py-1.5 px-2.5 text-right text-slate-400 font-mono text-[11px]">
                                        {timer.callCount && stats.frameCount > 0
                                          ? (timer.callCount / stats.frameCount).toFixed(1)
                                          : timer.baselineCallsPerFrame
                                          ? timer.baselineCallsPerFrame.toFixed(1)
                                          : '—'}
                                      </td>
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

                {groupedSubsystems.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAllSubsystems(!showAllSubsystems)}
                    className="text-xs text-sky-400 hover:text-sky-300 font-medium self-start mt-1 transition-colors"
                  >
                    {showAllSubsystems ? 'Show top 5 only' : `Show all (${groupedSubsystems.length}) subsystems...`}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
