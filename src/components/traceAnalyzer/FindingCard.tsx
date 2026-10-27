import type { Finding } from '../../types/traceAnalyzer';

interface FindingCardProps {
  finding: Finding;
  isSelected: boolean;
  onSelectEpisode: (episodeId: number) => void;
}

export function FindingCard({ finding, isSelected, onSelectEpisode }: FindingCardProps) {
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

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border p-4 transition-all ${
        isSelected
          ? 'bg-slate-800/80 border-sky-500/80 ring-1 ring-sky-500/50'
          : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800/60'
      }`}
    >
      {/* Title & Badges */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-100 leading-snug">{p.title}</h4>
          <span
            className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded border capitalize ${confidenceColor}`}
          >
            {p.matchConfidence} Confidence ({Math.round(p.matchScore * 100)}%)
          </span>
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
        <div className="flex flex-col gap-1 text-xs bg-slate-900/40 rounded p-2.5 border border-slate-700/40">
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
              <div key={`fix-${i}-${fix.text.slice(0, 20)}`} className="flex items-start gap-2 bg-slate-900/30 rounded p-2 border border-slate-700/30">
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

      {/* Affected Episodes */}
      {p.episodeIds && p.episodeIds.length > 0 && (
        <div className="flex items-center gap-1.5 pt-1 border-t border-slate-700/50 text-xs text-slate-400">
          <span>Applies to episodes:</span>
          <div className="flex flex-wrap gap-1">
            {p.episodeIds.map((epId) => (
              <button
                key={epId}
                type="button"
                onClick={() => onSelectEpisode(epId)}
                className="px-2 py-0.5 rounded bg-slate-700/70 hover:bg-sky-600/60 hover:text-sky-100 text-slate-300 text-xs border border-slate-600/50 transition-colors"
              >
                #{epId}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
