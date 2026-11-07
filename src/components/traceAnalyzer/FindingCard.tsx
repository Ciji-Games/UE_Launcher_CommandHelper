import { useState, useMemo } from 'react';
import type { Episode, Finding, TraceBookmark } from '../../types/traceAnalyzer';
import { getRuleDisplayLabel } from '../../utils/ruleDisplay';

interface FindingCardProps {
  finding: Finding;
  episodes?: Episode[];
  bookmarks?: TraceBookmark[];
  targetFps?: number;
  budgetGapMs?: number;
  defaultExpanded?: boolean;
  onSelectRange?: (range: [number, number]) => void;
  onOpenInInsights?: () => void;
}

function formatTime(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}m ${sec}s`;
}

export function FindingCard({
  finding,
  episodes = [],
  bookmarks = [],
  defaultExpanded = true,
  onSelectRange,
  onOpenInInsights,
}: FindingCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [showMoreFixes, setShowMoreFixes] = useState(false);

  const p = finding.parsedPayload;

  const episodesMap = useMemo(() => {
    return new Map<number, Episode>(episodes.map((ep) => [ep.id, ep]));
  }, [episodes]);

  // Nearest bookmark calculation (Item 8)
  const nearestBookmark = useMemo(() => {
    if (!bookmarks || bookmarks.length === 0) return null;
    const targetTime = p?.episodeIds?.[0]
      ? episodesMap.get(p.episodeIds[0])?.startS
      : null;
    if (targetTime === null || targetTime === undefined) return null;

    let closest = bookmarks[0];
    let minDiff = Math.abs(bookmarks[0].startS - targetTime);

    for (let i = 1; i < bookmarks.length; i++) {
      const diff = Math.abs(bookmarks[i].startS - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = bookmarks[i];
      }
    }

    if (minDiff <= 10.0) {
      return { bookmark: closest, distanceS: minDiff };
    }
    return null;
  }, [bookmarks, p, episodesMap]);

  const isInconclusive = finding.ruleId === 'inconclusive';
  const isFrameLimiter = finding.ruleId === 'frame-limiter';
  const isSlowRegion = p?.episodeIds?.some((id) => episodesMap.get(id)?.kind === 'slow_region');
  const isSustained =
    p?.scale === 'sustained' ||
    isSlowRegion ||
    finding.ruleId.includes('sustained') ||
    (p?.title ? p.title.toLowerCase().includes('sustained') : false) ||
    (p?.evidence?.[0]?.note ? p.evidence[0].note.includes('/frame') : false) ||
    (p?.evidence?.[0]?.label ? p.evidence[0].label.includes('ms/frame') : false);

  // Text-only confidence
  const confidenceLabel = isInconclusive
    ? 'Inconclusive'
    : isFrameLimiter
    ? 'Informational'
    : p?.matchConfidence === 'high'
    ? 'High Confidence'
    : p?.matchConfidence === 'medium'
    ? 'Medium Confidence'
    : 'Low Confidence';

  const confidenceBadgeColor = isInconclusive
    ? 'text-slate-400 bg-slate-800/80 border-slate-700'
    : p?.matchConfidence === 'high'
    ? 'text-emerald-400 bg-emerald-950/60 border-emerald-500/40'
    : p?.matchConfidence === 'medium'
    ? 'text-sky-400 bg-sky-950/60 border-sky-500/40'
    : 'text-amber-400 bg-amber-950/60 border-amber-500/40';

  const ruleDisplay = useMemo(() => {
    return getRuleDisplayLabel(finding.ruleId, p?.title);
  }, [finding.ruleId, p?.title]);

  // Fix likelihood
  const likelihoodText = isInconclusive
    ? 'Investigate'
    : isFrameLimiter
    ? 'Expected Behavior'
    : p?.fixLikelihood === 'high'
    ? 'Usually fixes it'
    : p?.fixLikelihood === 'medium'
    ? 'Often helps'
    : 'Worth trying';

  const likelihoodColor = isInconclusive
    ? 'text-slate-400'
    : p?.fixLikelihood === 'high'
    ? 'text-emerald-400'
    : p?.fixLikelihood === 'medium'
    ? 'text-sky-400'
    : 'text-amber-400';

  // Formulate single sentence headline with matching units (FR-3)
  const headline = useMemo(() => {
    if (!p) return finding.ruleId;
    if (isInconclusive) {
      return `Unprofiled execution spike: +${(p.ofExcessMs ?? 0).toFixed(1)} ms excess time without active instrumentation.`;
    }
    if (isFrameLimiter) {
      return `Frame limiter active: engine is capped at target framerate (${p.explainsMs.toFixed(1)} ms headroom).`;
    }
    if (isSustained) {
      return `${p.title} costs ${p.explainsMs.toFixed(1)} ms/frame of +${p.ofExcessMs.toFixed(1)} ms/frame excess gap.`;
    }
    // Hitch spike
    return `${p.title} caused a +${p.explainsMs.toFixed(1)} ms spike (+${p.ofExcessMs.toFixed(1)} ms frame excess).`;
  }, [p, isInconclusive, isFrameLimiter, isSustained, finding.ruleId]);

  if (!p) return null;

  const step1Fix = p.fixes && p.fixes.length > 0 ? p.fixes[0] : null;
  const remainingFixes = p.fixes && p.fixes.length > 1 ? p.fixes.slice(1) : [];

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-3.5 bg-slate-900/70 border-slate-800 shadow-md transition-all">
      {/* Top Headline & Header */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          {/* Headline (Clickable to toggle expand) */}
          <div
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-start gap-2 cursor-pointer flex-1 group"
          >
            <svg
              className={`w-4 h-4 text-slate-400 mt-0.5 shrink-0 transition-transform duration-200 group-hover:text-slate-200 ${
                isExpanded ? 'rotate-90' : ''
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {/* Domain pill */}
              <span
                className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider shrink-0 ${ruleDisplay.badgeColor}`}
                title={`Domain: ${ruleDisplay.label}`}
              >
                {ruleDisplay.badge}
              </span>
              <h3 className="text-sm font-semibold text-slate-100 group-hover:text-sky-300 leading-snug transition-colors">
                {headline}
              </h3>
            </div>
          </div>

          {/* Badges & Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Text-only Confidence with Tooltip */}
            <span
              title="How sure we are what this is, not a promise it will fix the problem."
              className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${confidenceBadgeColor} cursor-help`}
            >
              {confidenceLabel}
            </span>

            {/* Open in Insights deep link */}
            {onOpenInInsights && (
              <button
                type="button"
                onClick={onOpenInInsights}
                title="Inspect in Unreal Insights"
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs border border-slate-700 transition-colors"
              >
                <svg className="w-3.5 h-3.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                <span>Insights</span>
              </button>
            )}
          </div>
        </div>

        {/* Fix Likelihood Line with Tooltip */}
        <div className="flex items-center gap-2 text-xs text-slate-400 pl-6">
          <span>Likelihood of Fix:</span>
          <span
            title="Typical outcome, not measured on your project."
            className={`font-semibold cursor-help underline decoration-dotted ${likelihoodColor}`}
          >
            {likelihoodText}
          </span>
          <span className="text-slate-600">•</span>
          <span className="text-slate-300 font-mono text-[11px]">
            {isSustained ? (
              <>
                Explains <strong>{(p.explainsMs ?? 0).toFixed(1)} ms/frame</strong> of +{(p.ofExcessMs ?? 0).toFixed(1)} ms/frame excess
              </>
            ) : (
              <>
                Explains <strong>{(p.explainsMs ?? 0).toFixed(1)} ms</strong> of +{(p.ofExcessMs ?? 0).toFixed(1)} ms peak excess
              </>
            )}
          </span>
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="flex flex-col gap-3 pl-6 pt-1 border-t border-slate-800/80">
          {/* Nearest Bookmark Badge (Item 8) */}
          {nearestBookmark && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-700/80 text-xs text-slate-300 w-fit">
              <span className="text-amber-400">🏷️</span>
              <span className="text-slate-400">Nearest Bookmark:</span>
              <span className="font-semibold text-slate-200">"{nearestBookmark.bookmark.name}"</span>
              <span className="text-slate-500 font-mono text-[11px]">
                at {formatTime(nearestBookmark.bookmark.startS)} ({nearestBookmark.distanceS.toFixed(2)}s away)
              </span>
            </div>
          )}

          {/* Quantitative Evidence (Capped <= 100%) */}
          {p.evidence && p.evidence.length > 0 && (
            <div className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-slate-950/50 border border-slate-800">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                What We Observed
              </span>
              <ul className="flex flex-col gap-1 text-xs text-slate-300">
                {p.evidence.map((ev, i) => (
                  <li key={`ev-${i}`} className="leading-relaxed flex items-start gap-1.5">
                    <span className="text-sky-400 font-bold">•</span>
                    <span>{ev.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Need More Details / Recommended Channel Flags */}
          {p.channelSuggestion && (
            <div className="flex flex-col gap-1 p-2.5 bg-amber-950/20 border border-amber-600/30 rounded-lg text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 rounded">
                  💡 {p.channelSuggestion.badge}
                </span>
                <span className="text-slate-300">
                  Flags: <code className="text-amber-300 font-mono font-bold bg-slate-900 px-1.5 py-0.5 rounded">{p.channelSuggestion.channelFlags}</code>
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed mt-0.5">
                {p.channelSuggestion.description}
              </p>
            </div>
          )}

          {/* Fix Section: Step 1 expanded + How to Confirm */}
          {step1Fix && (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Recommended Action
              </span>

              {/* Step 1 Box */}
              <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-950/60 border border-slate-800">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <span className="text-xs font-bold text-sky-400 bg-sky-950/80 border border-sky-500/40 px-1.5 py-0.5 rounded">
                      Step 1
                    </span>
                    <span className="text-xs text-slate-200 font-medium leading-relaxed">
                      {step1Fix.text}
                    </span>
                  </div>
                  <span className="shrink-0 text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                    Effort: {step1Fix.effort}
                  </span>
                </div>

                {step1Fix.cvarsOrApis && step1Fix.cvarsOrApis.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 pl-8">
                    {step1Fix.cvarsOrApis.map((cvar) => (
                      <code
                        key={cvar}
                        className="text-[11px] bg-slate-900 text-sky-300 px-1.5 py-0.5 rounded border border-slate-800 font-mono"
                      >
                        {cvar}
                      </code>
                    ))}
                  </div>
                )}

                {/* How to Confirm Box */}
                <div className="flex items-start gap-2 p-2 mt-1 rounded bg-slate-900/80 border border-slate-800 text-xs text-slate-300">
                  <strong className="text-emerald-400 shrink-0 font-medium">How to confirm:</strong>
                  <span>{p.verify || 'Re-capture trace with identical settings and verify reduction in culprit timer.'}</span>
                </div>
              </div>

              {/* Remaining Steps Collapsible */}
              {remainingFixes.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowMoreFixes(!showMoreFixes)}
                    className="text-xs text-sky-400 hover:text-sky-300 font-medium text-left flex items-center gap-1 w-fit"
                  >
                    <span>{showMoreFixes ? '▲ Hide additional steps' : `▼ Show ${remainingFixes.length} more step(s)...`}</span>
                  </button>

                  {showMoreFixes && (
                    <div className="flex flex-col gap-2 mt-1">
                      {remainingFixes.map((fix, idx) => (
                        <div
                          key={`fix-${idx + 2}`}
                          className="flex items-start justify-between gap-2 p-2.5 rounded-lg bg-slate-950/40 border border-slate-800/80 text-xs"
                        >
                          <div className="flex items-start gap-2">
                            <span className="text-slate-400 font-bold px-1.5 py-0.5 rounded bg-slate-800 text-[10px]">
                              Step {idx + 2}
                            </span>
                            <span className="text-slate-300">{fix.text}</span>
                          </div>
                          <span className="shrink-0 text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                            Effort: {fix.effort}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Time Range Chips */}
          {p.episodeIds && p.episodeIds.length > 0 && (
            <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60 text-xs text-slate-400 flex-wrap">
              <span className="font-medium text-slate-400">Time Range:</span>
              <div className="flex flex-wrap gap-1.5">
                {p.episodeIds.map((epId) => {
                  const ep = episodesMap.get(epId);
                  if (!ep) return null;
                  const timeLabel = `${ep.startS.toFixed(1)}s – ${ep.endS.toFixed(1)}s`;
                  const peakLabel = `${ep.peakMs.toFixed(1)} ms`;

                  return (
                    <button
                      key={epId}
                      type="button"
                      onClick={() => {
                        const padding = 0.5;
                        onSelectRange?.([Math.max(0, ep.startS - padding), ep.endS + padding]);
                      }}
                      title={`Select ${timeLabel} (${peakLabel})`}
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-800 hover:bg-sky-950/70 text-slate-300 hover:text-sky-200 border border-slate-700 hover:border-sky-500/60 text-xs transition-all cursor-pointer font-mono shadow-sm"
                    >
                      <span>{timeLabel}</span>
                      <span className="text-amber-300 font-semibold">({peakLabel})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
