import type { Episode, Finding } from '../../types/traceAnalyzer';

interface FindingCardProps {
  finding: Finding;
  isSelected: boolean;
  selectedEpisodeId: number | null;
  episodes?: Episode[];
  onSelectEpisode: (episodeId: number) => void;
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
  isSelected,
  selectedEpisodeId,
  episodes = [],
  onSelectEpisode,
  onOpenInInsights,
}: FindingCardProps) {
  const p = finding.parsedPayload;
  if (!p) return null;

  const confidenceColor =
    p.matchConfidence === 'high'
      ? 'text-emerald-400 bg-emerald-950/40 border-emerald-600/40'
      : p.matchConfidence === 'medium'
      ? 'text-sky-400 bg-sky-950/40 border-sky-600/40'
      : 'text-amber-400 bg-amber-950/40 border-amber-600/40';

  const likelihoodText =
    p.fixLikelihood === 'high'
      ? 'Usually fixes it'
      : p.fixLikelihood === 'medium'
      ? 'Often helps'
      : 'Worth trying';

  const likelihoodBadge =
    p.fixLikelihood === 'high'
      ? 'text-emerald-300 bg-emerald-900/40 border-emerald-600/50'
      : p.fixLikelihood === 'medium'
      ? 'text-sky-300 bg-sky-900/40 border-sky-600/50'
      : 'text-slate-300 bg-slate-700/50 border-slate-600/50';

  const episodesMap = new Map<number, Episode>(episodes.map((ep) => [ep.id, ep]));

  return (
    <div
      className={`flex flex-col gap-3.5 rounded-lg border p-4.5 transition-all ${
        isSelected
          ? 'bg-slate-800/90 border-sky-500/90 ring-1 ring-sky-500/50 shadow-lg shadow-sky-950/30'
          : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800/60'
      }`}
    >
      {/* Title & Badges & Quick Action */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-slate-100 leading-snug">{p.title}</h4>
            {isSelected && (
              <span className="px-1.5 py-0.2 text-[10px] uppercase font-bold tracking-wider rounded bg-sky-600/30 text-sky-300 border border-sky-500/50">
                Matched Episode #{selectedEpisodeId}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-[11px] font-medium px-2 py-0.5 rounded border capitalize ${confidenceColor}`}
            >
              {p.matchConfidence} Confidence ({Math.round(p.matchScore * 100)}%)
            </span>
            {onOpenInInsights && (
              <button
                type="button"
                onClick={onOpenInInsights}
                title="Open trace in Unreal Insights GUI"
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-700/70 hover:bg-slate-600 text-slate-200 text-xs border border-slate-600/60 transition-colors"
              >
                <svg className="w-3.5 h-3.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                <span>Insights</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Fix Likelihood:</span>
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${likelihoodBadge}`}>
            {likelihoodText}
          </span>
          <span className="text-slate-500">•</span>
          <span className="text-slate-300">
            Explains <strong className="text-amber-300">{(p.explainsMs ?? 0).toFixed(1)} ms</strong> of +
            {(p.ofExcessMs ?? 0).toFixed(1)} ms spike
          </span>
        </div>
      </div>

      {/* Quantitative Evidence */}
      {p.evidence && p.evidence.length > 0 && (
        <div className="flex flex-col gap-1 text-xs bg-slate-900/50 rounded p-2.5 border border-slate-700/50">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">What We Observed:</span>
          <ul className="flex flex-col gap-1 list-disc list-inside text-slate-300">
            {p.evidence.map((ev, i) => (
              <li key={`ev-${i}-${ev.label.slice(0, 20)}`} className="leading-relaxed">
                {ev.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Need More Details / Recommended Channel Flags */}
      {p.channelSuggestion && (
        <div className="flex flex-col gap-1.5 p-3 bg-amber-950/20 border border-amber-600/30 rounded-lg text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40">
              💡 {p.channelSuggestion.badge}
            </span>
            <span className="text-slate-300">
              Recommended flag: <code className="text-amber-300 font-mono font-bold bg-slate-900 px-1.5 py-0.5 rounded border border-slate-700">{p.channelSuggestion.channelFlags}</code>
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed pl-0.5">
            {p.channelSuggestion.description}
          </p>
        </div>
      )}

      {/* Recommended Fixes */}
      {p.fixes && p.fixes.length > 0 && (
        <div className="flex flex-col gap-1.5 text-xs">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">What to Try (Ordered):</span>
          <div className="flex flex-col gap-1.5">
            {p.fixes.map((fix, i) => (
              <div key={`fix-${i}-${fix.text.slice(0, 20)}`} className="flex items-start gap-2 bg-slate-900/30 rounded p-2.5 border border-slate-700/40">
                <span className="text-sky-400 font-bold shrink-0">{i + 1}.</span>
                <div className="flex flex-col gap-1 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-200">{fix.text}</span>
                    <span className="shrink-0 text-[10px] uppercase font-semibold px-1.5 py-0.2 rounded bg-slate-700/60 text-slate-400 border border-slate-600/40">
                      Effort: {fix.effort}
                    </span>
                  </div>
                  {fix.cvarsOrApis && fix.cvarsOrApis.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {fix.cvarsOrApis.map((cvar, cIdx) => (
                        <code key={`cvar-${i}-${cIdx}-${cvar}`} className="text-[10px] bg-slate-800 text-sky-300 px-1.5 py-0.5 rounded border border-slate-700">
                          {cvar}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* How to Verify */}
      {p.verify && (
        <div className="text-xs text-slate-400 flex items-start gap-1.5">
          <strong className="text-emerald-400 shrink-0">How to Verify:</strong>
          <span>{p.verify}</span>
        </div>
      )}

      {/* Caveats */}
      {p.caveats && p.caveats.length > 0 && (
        <div className="text-[11px] text-slate-500 italic">
          {p.caveats.join(' ')}
        </div>
      )}

      {/* Affected Episodes with Timestamps and Peak Durations */}
      {p.episodeIds && p.episodeIds.length > 0 && (
        <div className="flex items-center gap-2 pt-2 border-t border-slate-700/50 text-xs text-slate-400 flex-wrap">
          <span className="font-medium">Matching episodes:</span>
          <div className="flex flex-wrap gap-1.5">
            {p.episodeIds.map((epId) => {
              const ep = episodesMap.get(epId);
              const isEpSelected = selectedEpisodeId === epId;
              const timeLabel = ep ? formatTime(ep.startS) : null;
              const peakLabel = ep ? `${ep.peakMs.toFixed(0)} ms` : null;

              return (
                <button
                  key={epId}
                  type="button"
                  onClick={() => onSelectEpisode(epId)}
                  title={ep ? `Episode #${epId} (${ep.kind === 'hitch' ? 'Hitch' : 'Slow Region'}) at ${timeLabel}, peak ${ep.peakMs.toFixed(1)} ms` : `Episode #${epId}`}
                  className={`flex items-center gap-1 px-2.5 py-0.5 rounded text-xs border transition-colors ${
                    isEpSelected
                      ? 'bg-sky-600 text-white font-semibold border-sky-400 shadow-sm'
                      : 'bg-slate-700/60 hover:bg-slate-700 text-slate-300 border-slate-600/50'
                  }`}
                >
                  <span>#{epId}</span>
                  {timeLabel && <span className="opacity-75 text-[11px]">({timeLabel})</span>}
                  {peakLabel && <span className="text-amber-300 font-mono text-[11px]">{peakLabel}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
