import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTraceAnalyzer } from '../hooks/useTraceAnalyzer';
import { FrameGraph } from './traceAnalyzer/FrameGraph';
import { SummaryHeader } from './traceAnalyzer/SummaryHeader';
import { FindingCard } from './traceAnalyzer/FindingCard';
import { LoadingStages } from './traceAnalyzer/LoadingStages';
import type { Episode, Finding, TraceCandidate } from '../types/traceAnalyzer';

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}m ${sec}s`;
}

const BOUND_BY_COLORS: Record<string, string> = {
  game: 'text-emerald-400 bg-emerald-950/40 border-emerald-600/40',
  render: 'text-purple-400 bg-purple-950/40 border-purple-600/40',
  rhi: 'text-indigo-400 bg-indigo-950/40 border-indigo-600/40',
  gpu: 'text-orange-400 bg-orange-950/40 border-orange-600/40',
  idle_limited: 'text-sky-400 bg-sky-950/40 border-sky-600/40',
  unattributed: 'text-slate-400 bg-slate-800/40 border-slate-600/40',
};

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
    isAnalyzing,
    progressPayload,
    error,
    options,
    openTrace,
    launchAndTraceExe,
    cancelAnalysis,
    fetchFrameSeries,
    openInInsights,
    setTargetFps,
  } = useTraceAnalyzer();

  const [isDragOver, setIsDragOver] = useState(false);
  const [showLaunchModal, setShowLaunchModal] = useState(false);
  const [selectedExePath, setSelectedExePath] = useState<string>('');
  const [customArgs, setCustomArgs] = useState<string>('');

  // File picker handler for .utrace
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

  // File picker handler for game executable .exe
  const handlePickExe = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Game Executable (*.exe)',
            extensions: ['exe'],
          },
        ],
      });
      if (selected && typeof selected === 'string') {
        setSelectedExePath(selected);
        setShowLaunchModal(true);
      }
    } catch (e) {
      console.error('Exe file pick failed:', e);
    }
  };

  const handleConfirmLaunch = () => {
    if (!selectedExePath) return;
    setShowLaunchModal(false);
    launchAndTraceExe(selectedExePath, customArgs);
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
              const lower = file.toLowerCase();
              if (lower.endsWith('.utrace')) {
                openTrace(file);
              } else if (lower.endsWith('.exe')) {
                setSelectedExePath(file);
                setShowLaunchModal(true);
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

          <button
            type="button"
            onClick={handlePickExe}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Launch Game (.exe)...</span>
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

            {/* Diagnostic Findings Section (Full Width) */}
            <div className="flex flex-col gap-3 min-h-[350px] pb-6">
              {/* Active Episode Selection Highlight Bar */}
              {selectedEpisodeId !== null && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-slate-800/80 border border-sky-500/60 shadow-md">
                  {(() => {
                    const ep = episodes.find((e: Episode) => e.id === selectedEpisodeId);
                    if (!ep) return null;
                    const boundClass = BOUND_BY_COLORS[ep.boundBy] || BOUND_BY_COLORS.unattributed;

                    return (
                      <>
                        <div className="flex flex-wrap items-center gap-2.5 text-xs">
                          <span className="font-bold text-sky-300 text-sm">
                            Episode #{ep.id} ({ep.kind === 'hitch' ? 'Hitch Spike' : 'Slow Region'})
                          </span>
                          <span className={`px-2 py-0.5 rounded border capitalize text-[11px] font-medium ${boundClass}`}>
                            Bound by: {ep.boundBy}
                          </span>
                          <span className="text-slate-400">•</span>
                          <span className="text-slate-300">
                            Peak: <strong className="text-amber-300 font-mono">{ep.peakMs.toFixed(1)} ms</strong>
                          </span>
                          <span className="text-slate-400">•</span>
                          <span className="text-slate-400">
                            Time: {formatDuration(ep.startS)} – {formatDuration(ep.endS)} (Frames #{ep.frameFrom}–#{ep.frameTo})
                          </span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-slate-400 hidden sm:inline">
                            Navigate with <kbd className="px-1 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px]">←</kbd>{' '}
                            <kbd className="px-1 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px]">→</kbd>
                          </span>
                          <button
                            type="button"
                            onClick={() => openInInsights()}
                            className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors shadow-sm"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                            <span>Inspect in Insights</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedEpisodeId(null)}
                            title="Clear selection (Esc)"
                            className="px-2 py-1 rounded bg-slate-700/80 hover:bg-slate-700 text-slate-300 hover:text-white text-xs transition-colors"
                          >
                            Clear (Esc)
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}

              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Diagnostic Findings ({findings.length})
                  </h3>
                  {selectedEpisodeId !== null && (
                    <span className="text-[11px] text-sky-400">
                      (Filtered to explain Episode #{selectedEpisodeId})
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-500">Ranked by excess time explained</span>
              </div>

              {/* Cards List */}
              <div className="flex flex-col gap-3.5">
                {findings.length === 0 ? (
                  <div className="p-8 rounded-lg bg-slate-800/30 border border-slate-700/40 text-center text-xs text-slate-400">
                    No severe performance anomalies detected against the frame budget.
                  </div>
                ) : (
                  findings.map((f: Finding) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      isSelected={selectedEpisodeId !== null && f.episodeIds.includes(selectedEpisodeId)}
                      selectedEpisodeId={selectedEpisodeId}
                      episodes={episodes}
                      onSelectEpisode={setSelectedEpisodeId}
                      onOpenInInsights={() => openInInsights()}
                    />
                  ))
                )}
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
                <h3 className="text-base font-semibold text-slate-100">
                  Import a Trace or Launch a Game Executable
                </h3>
                <p className="text-xs text-slate-400">
                  Drop a <code className="text-sky-300">.utrace</code> file to analyze, or drop / select a game <code className="text-indigo-300">.exe</code> to launch with trace flags and analyze upon exit.
                </p>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-3 mt-1">
                <button
                  type="button"
                  onClick={handlePickFile}
                  disabled={isAnalyzing}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-medium text-xs transition-colors shadow-sm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span>Select .utrace File</span>
                </button>

                <button
                  type="button"
                  onClick={handlePickExe}
                  disabled={isAnalyzing}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs transition-colors shadow-sm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>Launch & Trace .exe</span>
                </button>
              </div>

              {/* Recommended Trace Channels */}
              <div className="mt-4 p-3 bg-slate-900/60 border border-slate-700/60 rounded-lg text-left text-xs text-slate-300 w-full">
                <span className="font-semibold text-sky-300 block mb-1">Automated Capture Setup:</span>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  When launching an executable, the launcher applies <code className="text-amber-300 bg-slate-800 px-1 py-0.5 rounded">-trace=cpu,gpu,frame,loadtime,counters,bookmark -cpuprofilertrace</code> and writes the trace directly to the UE Trace Store directory.
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

      {/* Launch Executable Configuration Modal */}
      {showLaunchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full p-5 shadow-2xl flex flex-col gap-4 text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-indigo-950 border border-indigo-700/50 text-indigo-400">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-slate-100">Launch & Profile Game</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowLaunchModal(false)}
                className="text-slate-400 hover:text-slate-200 text-base font-bold"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <span className="text-slate-400 block mb-1 font-medium">Selected Executable:</span>
                <div className="p-2 rounded bg-slate-800/80 border border-slate-700 text-slate-200 font-mono text-[11px] break-all select-text">
                  {selectedExePath}
                </div>
              </div>

              <div>
                <span className="text-slate-400 block mb-1 font-medium">Automatic Trace Flags:</span>
                <div className="p-2 rounded bg-slate-950/60 border border-slate-800 text-amber-300 font-mono text-[11px] select-text">
                  -trace=cpu,gpu,frame,loadtime,counters,bookmark -cpuprofilertrace -tracefile=&lt;UE_Trace_Store&gt;
                </div>
                <p className="text-[10px] text-slate-500 mt-1">
                  Traces will be stored in the default Unreal Engine trace store and automatically analyzed once the game exits.
                </p>
              </div>

              <div>
                <label htmlFor="custom-game-args" className="text-slate-400 block mb-1 font-medium">
                  Additional Arguments (Optional):
                </label>
                <input
                  id="custom-game-args"
                  type="text"
                  value={customArgs}
                  onChange={(e) => setCustomArgs(e.target.value)}
                  placeholder="e.g. -windowed -ResX=1920 -ResY=1080 -log"
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConfirmLaunch();
                  }}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowLaunchModal(false)}
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmLaunch}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors shadow-sm"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                </svg>
                <span>Launch & Monitor</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
