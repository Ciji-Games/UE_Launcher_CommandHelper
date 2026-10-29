import { useEffect, useState, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTraceAnalyzer } from '../hooks/useTraceAnalyzer';
import { FrameGraph } from './traceAnalyzer/FrameGraph';
import { SummaryHeader } from './traceAnalyzer/SummaryHeader';
import { FindingCard } from './traceAnalyzer/FindingCard';
import { LoadingStages } from './traceAnalyzer/LoadingStages';
import { RangeStatisticsPanel } from './traceAnalyzer/RangeStatisticsPanel';
import { CategoryBreakdownChart } from './traceAnalyzer/CategoryBreakdownChart';
import type { Finding, TraceCandidate } from '../types/traceAnalyzer';

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${m}m ${sec}s`;
}

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
    bookmarks,
    selectedRange,
    setSelectedRange,
    rangeStats,
    rangeStatsLoading,
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
          } else if (event.payload.type === 'leave') {
            setIsDragOver(false);
          } else if (event.payload.type === 'drop') {
            setIsDragOver(false);
            const droppedPaths = event.payload.paths;
            if (droppedPaths && droppedPaths.length > 0) {
              const dropped = droppedPaths[0];
              if (dropped.toLowerCase().endsWith('.utrace')) {
                openTrace(dropped);
              } else if (dropped.toLowerCase().endsWith('.exe')) {
                setSelectedExePath(dropped);
                setShowLaunchModal(true);
              }
            }
          }
        })
        .then((fn) => {
          unlisten = fn;
        });
    } catch (e) {
      console.error('Drag & drop listener error:', e);
    }

    return () => {
      unlisten?.();
    };
  }, [openTrace]);

  // Keyboard navigation for episodes
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!summary || episodes.length === 0) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSelectedEpisodeId((current) => {
          if (current === null) return episodes[0].id;
          const idx = episodes.findIndex((ep) => ep.id === current);
          if (idx !== -1 && idx < episodes.length - 1) {
            return episodes[idx + 1].id;
          }
          return current;
        });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelectedEpisodeId((current) => {
          if (current === null) return episodes[episodes.length - 1].id;
          const idx = episodes.findIndex((ep) => ep.id === current);
          if (idx > 0) {
            return episodes[idx - 1].id;
          }
          return current;
        });
      } else if (e.key === 'Escape') {
        setSelectedEpisodeId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [summary, episodes, setSelectedEpisodeId]);

  // Rank and filter findings based on active selected range
  const scopedFindings = useMemo(() => {
    if (!selectedRange) return findings;
    const [minS, maxS] = [Math.min(...selectedRange), Math.max(...selectedRange)];

    // Check if range is roughly entire trace
    const isFullTrace = summary && (maxS - minS >= (summary.durationS - 0.1));

    if (isFullTrace) {
      return findings;
    }

    // Elevate findings whose episodes overlap the active selection window
    return [...findings].sort((a, b) => {
      const aMatches = a.episodeIds.some((id) => {
        const ep = episodes.find((e) => e.id === id);
        return ep && ep.startS <= maxS && ep.endS >= minS;
      });
      const bMatches = b.episodeIds.some((id) => {
        const ep = episodes.find((e) => e.id === id);
        return ep && ep.startS <= maxS && ep.endS >= minS;
      });

      if (aMatches && !bMatches) return -1;
      if (!aMatches && bMatches) return 1;
      return a.rank - b.rank;
    });
  }, [findings, selectedRange, episodes, summary]);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 p-4 gap-3 select-none overflow-hidden">
      {/* Top Header / Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">
              Trace Analyzer Studio
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-sky-950/80 text-sky-400 border border-sky-800/60 font-mono">
              Unified
            </span>
          </div>

          {/* Open Trace Button */}
          <button
            type="button"
            onClick={handlePickFile}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-medium transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
            </svg>
            <span>Open .utrace...</span>
          </button>

          {/* Launch Game Executable Button */}
          <button
            type="button"
            onClick={handlePickExe}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-medium border border-slate-700 transition-colors shadow-sm"
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
      <div className="flex-1 min-h-0 pt-1 flex flex-col gap-3">
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
          /* Active Trace View: Unified Performance Studio Dashboard */
          <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-1">
            {/* Top Summary Header Bar */}
            <SummaryHeader
              summary={summary}
              findings={findings}
              targetFps={options.targetFps}
              onTargetFpsChange={setTargetFps}
              onOpenInInsights={() => openInInsights()}
            />

            {/* Frame Time Graph + Bookmarks Track */}
            <div className="h-[250px] shrink-0">
              <FrameGraph
                durationS={summary.durationS}
                targetMs={summary.targetMs}
                episodes={episodes}
                selectedEpisodeId={selectedEpisodeId}
                onSelectEpisode={setSelectedEpisodeId}
                bookmarks={bookmarks}
                selectedRange={selectedRange}
                onSelectRange={setSelectedRange}
                fetchFrameSeries={fetchFrameSeries}
              />
            </div>

            {/* Middle Row: Range Statistics & Hardware Balance | Fixed Category Donut */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 shrink-0">
              {/* Left Column: Pipeline Balance & Health Metrics */}
              <RangeStatisticsPanel
                stats={rangeStats}
                targetMs={summary.targetMs}
                isLoading={rangeStatsLoading}
              />

              {/* Right Column: Fixed Category Donut & Top Timers */}
              <CategoryBreakdownChart
                categories={rangeStats?.categories || []}
                topTimers={rangeStats?.topTimers || []}
                frameCount={rangeStats?.frameCount || 0}
              />
            </div>

            {/* Scoped Diagnostic Findings Section */}
            <div className="flex flex-col gap-3 min-h-[300px] pb-6 pt-1 border-t border-slate-800/80">
              {/* Selected Scope Indicator Bar */}
              {selectedRange && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-slate-900/80 border border-sky-500/50 shadow-md">
                  <div className="flex items-center gap-2.5 text-xs">
                    <span className="font-bold text-sky-300 text-sm">
                      Active Scope:
                    </span>
                    <span className="font-mono text-slate-200">
                      {formatDuration(selectedRange[0])} – {formatDuration(selectedRange[1])}
                    </span>
                    <span className="text-slate-500">•</span>
                    <span className="text-slate-400">
                      Duration: <strong className="text-amber-300 font-mono">{(selectedRange[1] - selectedRange[0]).toFixed(2)}s</strong>
                    </span>
                    {rangeStats && (
                      <>
                        <span className="text-slate-500">•</span>
                        <span className="text-slate-400">
                          Frames: <strong className="text-sky-300 font-mono">{rangeStats.frameCount}</strong>
                        </span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => openInInsights()}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors shadow-sm"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      <span>Inspect in Unreal Insights</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedRange([0, summary.durationS])}
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs transition-colors border border-slate-700"
                    >
                      Entire Trace
                    </button>
                  </div>
                </div>
              )}

              {/* Findings Section Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Actionable Diagnostic Findings ({scopedFindings.length})
                  </h3>
                  {selectedRange && (
                    <span className="text-[11px] text-sky-400">
                      (Scoped to active selection)
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-500">Ranked by excess time explained</span>
              </div>

              {/* Cards List */}
              <div className="flex flex-col gap-3.5">
                {scopedFindings.length === 0 ? (
                  <div className="p-8 rounded-lg bg-slate-900/40 border border-slate-800 text-center text-xs text-slate-400">
                    No severe performance bottlenecks detected against the target frame budget in this scope.
                  </div>
                ) : (
                  scopedFindings.map((f: Finding) => (
                    <FindingCard
                      key={f.id}
                      finding={f}
                      isSelected={
                        selectedEpisodeId !== null && f.episodeIds.includes(selectedEpisodeId)
                      }
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

              <div>
                <h3 className="text-sm font-semibold text-slate-200">
                  Open an Unreal Trace (.utrace) or Launch Executable
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Drag and drop a trace file or game .exe here, or click one of the buttons below to begin analysis.
                </p>
              </div>

              <div className="flex items-center gap-3 mt-2">
                <button
                  type="button"
                  onClick={handlePickFile}
                  className="px-4 py-2 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors shadow-sm"
                >
                  Choose .utrace File...
                </button>
                <button
                  type="button"
                  onClick={handlePickExe}
                  className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-600 transition-colors shadow-sm"
                >
                  Launch .exe Game...
                </button>
              </div>

              {candidates.length > 0 && (
                <div className="mt-4 pt-4 border-t border-slate-800 w-full text-left">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">
                    Recent Traces ({candidates.length}):
                  </span>
                  <div className="flex flex-col gap-1.5 max-h-[160px] overflow-y-auto pr-1">
                    {candidates.slice(0, 5).map((c: TraceCandidate) => (
                      <button
                        key={c.path}
                        type="button"
                        onClick={() => openTrace(c.path)}
                        className="flex items-center justify-between p-2 rounded bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 text-xs transition-colors text-left"
                      >
                        <span className="text-slate-200 truncate font-mono text-[11px]">{c.fileName}</span>
                        <span className="text-[10px] text-slate-400 px-1.5 py-0.5 rounded bg-slate-700/60 ml-2 shrink-0">
                          {c.source}
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

      {/* Launch Game Modal */}
      {showLaunchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-md w-full shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <span>🎮</span> Launch Game with Trace Recording
              </h3>
              <button
                type="button"
                onClick={() => setShowLaunchModal(false)}
                className="text-slate-400 hover:text-slate-200 text-sm"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-2.5 text-xs text-slate-300">
              <div>
                <label className="block text-slate-400 mb-1">Executable Path:</label>
                <div className="p-2 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-[11px] truncate">
                  {selectedExePath}
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Additional Command Line Arguments:</label>
                <input
                  type="text"
                  value={customArgs}
                  onChange={(e) => setCustomArgs(e.target.value)}
                  placeholder="-WINDOWED -ResX=1920 -ResY=1080 -novsync"
                  className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500 font-mono text-xs"
                />
              </div>

              <div className="p-2.5 rounded bg-slate-800/60 border border-slate-700/60 text-[11px] text-slate-400">
                Automatically appends Unreal Trace flags:
                <code className="text-sky-300 block mt-1 font-mono text-[10px]">
                  -trace=default,frame,cpu,gpu,bookmark -statnamedevents
                </code>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowLaunchModal(false)}
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmLaunch}
                className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs transition-colors shadow-sm"
              >
                Launch & Monitor
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
