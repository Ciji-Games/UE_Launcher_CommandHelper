import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTraceAnalyzer } from '../hooks/useTraceAnalyzer';
import { FrameGraph } from './traceAnalyzer/FrameGraph';
import { SummaryHeader } from './traceAnalyzer/SummaryHeader';
import { FindingCard } from './traceAnalyzer/FindingCard';
import { EpisodeDetail } from './traceAnalyzer/EpisodeDetail';
import { LoadingStages } from './traceAnalyzer/LoadingStages';
import type { Episode, Finding, TraceCandidate } from '../types/traceAnalyzer';

export function TraceAnalyzerPanel() {
  const {
    candidates,
    availableEngines,
    selectedEngineRoot,
    setSelectedEngineRoot,
    insightsInfo,
    currentTracePath,
    summary,
    episodes,
    findings,
    selectedEpisodeId,
    setSelectedEpisodeId,
    episodeDetail,
    episodeDetailLoading,
    isAnalyzing,
    progressPayload,
    error,
    options,
    openTrace,
    cancelAnalysis,
    fetchFrameSeries,
    openInInsights,
    setTargetFps,
  } = useTraceAnalyzer();

  const [isDragOver, setIsDragOver] = useState(false);

  // File picker handler
  const handlePickFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Unreal Trace (*.utrace)',
            extensions: ['utrace'],
          },
        ],
      });
      if (selected && typeof selected === 'string') {
        openTrace(selected);
      }
    } catch (e) {
      console.error('File pick failed:', e);
    }
  };

  // Drag and drop handler
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            setIsDragOver(true);
          } else if (event.payload.type === 'drop') {
            setIsDragOver(false);
            const paths = event.payload.paths;
            if (paths && paths.length > 0) {
              const file = paths[0];
              if (file.toLowerCase().endsWith('.utrace')) {
                openTrace(file);
              }
            }
          } else {
            setIsDragOver(false);
          }
        })
        .then((fn) => {
          unlisten = fn;
        });
    } catch (e) {
      console.error('Failed to register drag-drop listener:', e);
    }

    return () => {
      unlisten?.();
    };
  }, [openTrace]);

  // Keyboard navigation for episodes
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape') {
        setSelectedEpisodeId(null);
      } else if (e.key === 'ArrowRight' && episodes.length > 0) {
        e.preventDefault();
        const currIdx = episodes.findIndex((ep: Episode) => ep.id === selectedEpisodeId);
        const nextIdx = currIdx >= 0 && currIdx < episodes.length - 1 ? currIdx + 1 : 0;
        setSelectedEpisodeId(episodes[nextIdx].id);
      } else if (e.key === 'ArrowLeft' && episodes.length > 0) {
        e.preventDefault();
        const currIdx = episodes.findIndex((ep: Episode) => ep.id === selectedEpisodeId);
        const prevIdx = currIdx > 0 ? currIdx - 1 : episodes.length - 1;
        setSelectedEpisodeId(episodes[prevIdx].id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [episodes, selectedEpisodeId, setSelectedEpisodeId]);

  return (
    <div className="flex flex-col h-full w-full min-h-0 text-slate-200 select-none">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-700/60 shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePickFile}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-medium text-xs transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span>Open Trace (.utrace)</span>
          </button>

          {/* Candidate Traces Dropdown */}
          {candidates.length > 0 && (
            <select
              onChange={(e) => {
                if (e.target.value) openTrace(e.target.value);
              }}
              value=""
              disabled={isAnalyzing}
              className="bg-slate-800 border border-slate-600 text-slate-300 rounded px-2.5 py-1 text-xs focus:ring-1 focus:ring-sky-500 focus:outline-none max-w-[200px] truncate"
            >
              <option value="" disabled>
                Recent Traces ({candidates.length})...
              </option>
              {candidates.map((c: TraceCandidate) => (
                <option key={c.path} value={c.path}>
                  {c.fileName} ({c.source === 'store' ? 'Store' : 'Project'})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Engine Selection & Insights Status */}
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Engine:</span>
            <select
              value={selectedEngineRoot}
              onChange={(e) => setSelectedEngineRoot(e.target.value)}
              disabled={isAnalyzing}
              className="bg-slate-800 border border-slate-600 text-slate-300 rounded px-2.5 py-1 text-xs focus:ring-1 focus:ring-sky-500 focus:outline-none max-w-[180px] truncate"
            >
              {availableEngines.map((e: { root: string; version: string }) => (
                <option key={e.root} value={e.root}>
                  UE {e.version}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                insightsInfo?.exists ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-rose-400'
              }`}
            />
            <span className="text-slate-400">
              {insightsInfo?.exists ? 'Insights Ready' : 'Insights Missing'}
            </span>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 pt-3 flex flex-col gap-3">
        {/* Error Banner */}
        {error && (
          <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-600/50 text-rose-200 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold text-rose-400">Error:</span>
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => openTrace(currentTracePath || '')}
              className="px-2 py-0.5 rounded bg-rose-900/60 hover:bg-rose-800 text-rose-100 text-xs transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading State */}
        {isAnalyzing ? (
          <div className="flex-1 flex items-center justify-center min-h-0">
            <LoadingStages progress={progressPayload} onCancel={cancelAnalysis} />
          </div>
        ) : summary ? (
          /* Active Trace View */
          <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-1">
            {/* Summary Header */}
            <SummaryHeader
              summary={summary}
              findings={findings}
              targetFps={options.targetFps}
              onTargetFpsChange={setTargetFps}
              onOpenInInsights={() => openInInsights()}
            />

            {/* Frame Time Graph */}
            <div className="h-[250px] shrink-0">
              <FrameGraph
                durationS={summary.durationS}
                targetMs={summary.targetMs}
                episodes={episodes}
                selectedEpisodeId={selectedEpisodeId}
                onSelectEpisode={setSelectedEpisodeId}
                fetchFrameSeries={fetchFrameSeries}
              />
            </div>

            {/* Split Findings (Left) & Episode Detail (Right) */}
            <div className="flex gap-4 min-h-[350px] pb-4">
              {/* Findings Column */}
              <div className="flex-[3_1_0] flex flex-col gap-3 min-w-0">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Diagnostic Findings ({findings.length})
                  </h3>
                  <span className="text-[11px] text-slate-500">Ranked by excess time explained</span>
                </div>

                <div className="flex flex-col gap-3">
                  {findings.length === 0 ? (
                    <div className="p-6 rounded-lg bg-slate-800/30 border border-slate-700/40 text-center text-xs text-slate-400">
                      No severe performance anomalies detected against the frame budget.
                    </div>
                  ) : (
                    findings.map((f: Finding) => (
                      <FindingCard
                        key={f.id}
                        finding={f}
                        isSelected={selectedEpisodeId !== null && f.episodeIds.includes(selectedEpisodeId)}
                        onSelectEpisode={setSelectedEpisodeId}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* Episode Detail Column */}
              <div className="flex-[2_1_0] flex flex-col gap-3 min-w-0">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Episode Inspector
                  </h3>
                  {selectedEpisodeId !== null && (
                    <span className="text-[11px] text-slate-400">
                      Use <kbd className="px-1 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px]">←</kbd>{' '}
                      <kbd className="px-1 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px]">→</kbd> to navigate
                    </span>
                  )}
                </div>

                <EpisodeDetail
                  detail={episodeDetail}
                  loading={episodeDetailLoading}
                  onOpenInInsights={() => openInInsights()}
                />
              </div>
            </div>
          </div>
        ) : (
          /* Empty Drop Zone & Candidate Explorer */
          <div
            className={`flex-1 flex flex-col items-center justify-center p-8 rounded-xl border-2 border-dashed transition-all ${
              isDragOver
                ? 'bg-sky-950/20 border-sky-400 scale-[0.99]'
                : 'bg-slate-800/20 border-slate-700/60 hover:bg-slate-800/30'
            }`}
          >
            <div className="flex flex-col items-center text-center max-w-md gap-3">
              <div className="p-4 rounded-full bg-slate-800 border border-slate-700 text-sky-400 shadow-md">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>

              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold text-slate-100">Drop an Unreal .utrace capture here</h3>
                <p className="text-xs text-slate-400">
                  Or click &quot;Open Trace&quot; above to select a performance capture file for headless diagnosis.
                </p>
              </div>

              {/* Recommended Trace Channels */}
              <div className="mt-4 p-3 bg-slate-900/60 border border-slate-700/60 rounded-lg text-left text-xs text-slate-300 w-full">
                <span className="font-semibold text-sky-300 block mb-1">Recommended Capture Channels:</span>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  For full diagnostic accuracy, capture traces with: <code className="text-amber-300 bg-slate-800 px-1 py-0.5 rounded">-trace=cpu,gpu,frame,loadtime,counters</code>. Packaged Development or Test builds provide the cleanest results.
                </p>
              </div>

              {/* Candidate Quick List */}
              {candidates.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5 w-full text-left">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Detected Local Captures:
                  </span>
                  <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1">
                    {candidates.slice(0, 5).map((c: TraceCandidate) => (
                      <button
                        key={c.path}
                        type="button"
                        onClick={() => openTrace(c.path)}
                        className="flex items-center justify-between p-2 rounded bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700/50 text-xs text-left transition-colors"
                      >
                        <div className="flex flex-col truncate pr-2">
                          <span className="font-medium text-slate-200 truncate">{c.fileName}</span>
                          <span className="text-[10px] text-slate-400 truncate">{c.path}</span>
                        </div>
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {(c.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
