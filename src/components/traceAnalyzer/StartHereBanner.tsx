import { useMemo } from 'react';
import type { Finding, Episode, RangeStatisticsResponse, TraceSummary } from '../../types/traceAnalyzer';
import { describeRange } from '../../utils/traceClassifier';

interface StartHereBannerProps {
  stats: RangeStatisticsResponse | null;
  summary: TraceSummary;
  findings: Finding[];
  episodes: Episode[];
  hitchCount?: number;
  maxHitchMs?: number;
  onShowOnGraph?: (range: [number, number]) => void;
}

export function StartHereBanner({
  stats,
  summary,
  findings,
  episodes,
  hitchCount,
  maxHitchMs,
  onShowOnGraph,
}: StartHereBannerProps) {
  const worstHitch = useMemo(() => {
    const hitches = episodes.filter((e) => e.kind === 'hitch');
    if (hitches.length === 0) return null;
    return hitches.reduce((worst, e) => (e.peakMs > worst.peakMs ? e : worst), hitches[0]);
  }, [episodes]);

  const effectiveHitchCount =
    hitchCount !== undefined ? hitchCount : episodes.filter((e) => e.kind === 'hitch').length;
  const effectiveMaxHitchMs =
    maxHitchMs !== undefined ? maxHitchMs : worstHitch?.peakMs;

  const rangeDesc = useMemo(() => {
    if (!stats) return null;
    return describeRange(
      stats,
      summary.targetMs,
      effectiveHitchCount,
      effectiveMaxHitchMs
    );
  }, [stats, summary.targetMs, effectiveHitchCount, effectiveMaxHitchMs]);

  // Top finding for "First thing to try"
  const topFinding = useMemo(() => {
    if (findings.length === 0) return null;
    return findings[0];
  }, [findings]);

  const topFix = useMemo(() => {
    if (!topFinding) return null;
    const payload = topFinding.parsedPayload;
    if (!payload?.fixes || payload.fixes.length === 0) return null;
    return {
      text: payload.fixes[0].text,
      effort: payload.fixes[0].effort,
      cvars: payload.fixes[0].cvarsOrApis,
      episodeIds: payload.episodeIds || [],
    };
  }, [topFinding]);

  const topEpisodeRange = useMemo<[number, number] | null>(() => {
    if (!topFix || topFix.episodeIds.length === 0) {
      if (worstHitch) return [worstHitch.startS, worstHitch.endS];
      return null;
    }
    const ep = episodes.find((e) => e.id === topFix.episodeIds[0]);
    if (ep) return [ep.startS, ep.endS];
    if (worstHitch) return [worstHitch.startS, worstHitch.endS];
    return null;
  }, [topFix, episodes, worstHitch]);

  if (!rangeDesc) return null;

  const stateIcon =
    rangeDesc.stateLabel === 'Smooth'
      ? '🟢'
      : rangeDesc.stateLabel === 'Steady Over Budget'
      ? '🟡'
      : '🔴';

  const isEditor = summary.isEditorBuild;

  return (
    <div className="flex flex-col gap-2 p-3.5 rounded-xl bg-gradient-to-r from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800 shadow-md">
      {/* Banner Header */}
      <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-bold uppercase tracking-wider text-[11px]">
            Start Here
          </span>
          <span className="text-slate-600">•</span>
          <span className="text-slate-400 text-xs font-normal">
            10-Second Diagnostic Summary
          </span>
        </div>
        {isEditor && (
          <span className="text-[11px] text-amber-400/90 bg-amber-950/40 border border-amber-500/30 px-2 py-0.5 rounded">
            Editor Capture Note: Slate &amp; Editor overhead included
          </span>
        )}
      </div>

      {/* Sentence 1: Performance State */}
      <div className="flex items-start gap-2 text-xs text-slate-200 leading-relaxed">
        <span className="text-sm select-none">{stateIcon}</span>
        <div>
          <strong className="text-slate-100 font-semibold">State: </strong>
          <span>{rangeDesc.stateSummary}</span>
        </div>
      </div>

      {/* Sentence 2: Bottleneck */}
      <div className="flex items-start gap-2 text-xs text-slate-200 leading-relaxed">
        <span className="text-sm select-none">🎯</span>
        <div>
          <strong className="text-slate-100 font-semibold">Bottleneck: </strong>
          <span>{rangeDesc.bottleneckSummary}</span>
        </div>
      </div>

      {/* Sentence 3: First thing to try */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/60 mt-0.5">
        <div className="flex items-start gap-2 text-xs text-slate-200 flex-1 min-w-[280px]">
          <span className="text-sm select-none">💡</span>
          <div>
            <strong className="text-sky-300 font-semibold">First thing to try: </strong>
            {rangeDesc.stateLabel === 'Smooth' || findings.length === 0 ? (
              <span className="text-emerald-300 font-medium">
                No performance bottlenecks in this range — frames are within the {summary.targetMs.toFixed(1)} ms budget.
              </span>
            ) : topFix ? (
              <span className="text-slate-200">
                {topFix.text}
                {topFix.effort && (
                  <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800 text-slate-400 border border-slate-700">
                    Effort: {topFix.effort}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-slate-400">
                Re-capture with full channels enabled: <code className="text-sky-300 bg-slate-800 px-1 py-0.5 rounded font-mono">-trace=cpu,gpu,frame,bookmark</code> to isolate timer gaps.
              </span>
            )}
          </div>
        </div>

        {/* Action Button: Show on graph */}
        {rangeDesc.stateLabel !== 'Smooth' && topEpisodeRange && onShowOnGraph && (
          <button
            type="button"
            onClick={() => onShowOnGraph(topEpisodeRange)}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-sky-600/80 hover:bg-sky-600 text-white text-xs font-medium transition-all shadow-sm shrink-0 border border-sky-400/40 hover:scale-[1.02]"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <span>Show on graph</span>
          </button>
        )}
      </div>
    </div>
  );
}
