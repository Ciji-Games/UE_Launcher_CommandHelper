import type { EpisodeDetailResponse } from '../../types/traceAnalyzer';

interface EpisodeDetailProps {
  detail: EpisodeDetailResponse | null;
  loading: boolean;
  onOpenInInsights: () => void;
}

export function EpisodeDetail({ detail, loading, onOpenInInsights }: EpisodeDetailProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-slate-400">
        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-sky-400" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Loading episode details...
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-xs text-slate-400 bg-slate-800/20 border border-slate-700/40 rounded-lg">
        <p>Select an episode from the graph or finding cards to inspect exclusive timer execution and thread bottlenecks.</p>
      </div>
    );
  }

  const { episode, boundBy, buckets, topTimers, threads } = detail;

  const boundByColor: Record<string, string> = {
    game: 'text-emerald-400 bg-emerald-950/40 border-emerald-600/40',
    render: 'text-purple-400 bg-purple-950/40 border-purple-600/40',
    rhi: 'text-indigo-400 bg-indigo-950/40 border-indigo-600/40',
    gpu: 'text-orange-400 bg-orange-950/40 border-orange-600/40',
    idle_limited: 'text-sky-400 bg-sky-950/40 border-sky-600/40',
    unattributed: 'text-slate-400 bg-slate-800/40 border-slate-600/40',
  };

  return (
    <div className="flex flex-col gap-4 bg-slate-800/30 border border-slate-700/60 rounded-lg p-4 text-xs">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-700/60 pb-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-100">
              Episode #{episode.id} ({episode.kind === 'hitch' ? 'Hitch Spike' : 'Slow Region'})
            </h4>
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded border capitalize ${boundByColor[boundBy] || boundByColor.unattributed}`}>
              Bound by: {boundBy}
            </span>
          </div>

          <div className="text-slate-400 flex items-center gap-2 text-[11px]">
            <span>Peak: <strong className="text-amber-300 font-mono">{(episode.peakMs ?? 0).toFixed(1)} ms</strong></span>
            <span>•</span>
            <span>Frames: #{episode.frameFrom ?? 0} – #{episode.frameTo ?? 0}</span>
            <span>•</span>
            <span>Time: {(episode.startS ?? 0).toFixed(2)}s – {(episode.endS ?? 0).toFixed(2)}s</span>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenInInsights}
          className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs transition-colors shrink-0"
        >
          Inspect in Insights
        </button>
      </div>

      {/* Stacked Bucket Breakdown */}
      {buckets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Execution Time by Bucket:
          </span>
          <div className="flex flex-col gap-1">
            {buckets.slice(0, 6).map((b, idx) => (
              <div key={`${b.bucket}-${idx}`} className="flex items-center justify-between gap-2 text-slate-300">
                <span className="truncate">{b.bucket}</span>
                <span className="font-mono text-slate-200">{(b.episodeMs ?? 0).toFixed(1)} ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Excess Timers */}
      {topTimers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Top Culprit Scopes (Exclusive Time Excess):
          </span>
          <div className="overflow-x-auto rounded border border-slate-700/60">
            <table className="w-full text-left text-slate-300 border-collapse">
              <thead>
                <tr className="bg-slate-900/60 text-slate-400 text-[10px] uppercase border-b border-slate-700/60">
                  <th className="p-2 font-medium">Timer Scope</th>
                  <th className="p-2 font-medium">Bucket</th>
                  <th className="p-2 font-medium text-right">Time</th>
                  <th className="p-2 font-medium text-right">Normal</th>
                  <th className="p-2 font-medium text-right">Excess</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {topTimers.map((t, idx) => (
                  <tr key={`${t.timerName}-${t.bucket}-${idx}`} className="hover:bg-slate-700/20">
                    <td className="p-2 font-mono text-slate-200 max-w-[180px] truncate" title={t.timerName}>
                      {t.timerName}
                    </td>
                    <td className="p-2 text-slate-400 text-[11px]">{t.bucket}</td>
                    <td className="p-2 font-mono text-right text-slate-200">{(t.episodeExclMs ?? 0).toFixed(1)} ms</td>
                    <td className="p-2 font-mono text-right text-slate-400">{(t.baselineMedianMs ?? 0).toFixed(1)} ms</td>
                    <td className="p-2 font-mono text-right text-amber-300 font-semibold">
                      +{(t.excessMs ?? 0).toFixed(1)} ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Thread Busy / Wait Overview */}
      {threads.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Thread Activity:
          </span>
          <div className="grid grid-cols-2 gap-2">
            {threads.map((th, idx) => (
              <div key={`${th.threadName}-${th.role}-${idx}`} className="flex flex-col p-2 bg-slate-900/40 rounded border border-slate-700/40">
                <span className="font-semibold text-slate-200 truncate">{th.threadName}</span>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                  <span>Work: <strong className="text-emerald-400">{(th.busyMs ?? 0).toFixed(1)} ms</strong></span>
                  <span>Wait: <strong className="text-slate-400">{(th.waitMs ?? 0).toFixed(1)} ms</strong></span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
