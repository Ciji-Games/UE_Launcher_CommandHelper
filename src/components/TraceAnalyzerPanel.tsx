import { useEffect, useState, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTraceAnalyzer } from '../hooks/useTraceAnalyzer';
import { FrameGraph } from './traceAnalyzer/FrameGraph';
import { SummaryHeader } from './traceAnalyzer/SummaryHeader';
import { StartHereBanner } from './traceAnalyzer/StartHereBanner';
import { FindingCard } from './traceAnalyzer/FindingCard';
import { LoadingStages } from './traceAnalyzer/LoadingStages';
import { RangeAnalysisPanel } from './traceAnalyzer/RangeAnalysisPanel';
import { DetailsDrawer } from './traceAnalyzer/DetailsDrawer';
import type { Episode, Finding, TraceCandidate } from '../types/traceAnalyzer';

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
  const [selectedTimerName, setSelectedTimerName] = useState<string | null>(null);

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

  // Filter and rank findings strictly based on active selected range & selected timer
  const scopedFindings = useMemo(() => {
    if (!summary) return [];
    let list = findings;

    if (selectedRange) {
      const [minS, maxS] = [Math.min(...selectedRange), Math.max(...selectedRange)];

      // Check if range is roughly entire trace
      const isFullTrace = maxS - minS >= summary.durationS - 0.05;

      if (!isFullTrace) {
        // Filter to only findings whose occurrences/episodes overlap the active selection window
        list = list.filter((f) => {
          if (!f.episodeIds || f.episodeIds.length === 0) return true;
          return f.episodeIds.some((id) => {
            const ep = episodes.find((e) => e.id === id);
            return ep && ep.startS <= maxS && ep.endS >= minS;
          });
        });
      }
    }

    if (selectedTimerName) {
      const lower = selectedTimerName.toLowerCase();
      const filteredByTimer = list.filter((f) => {
        const payloadStr = f.payload.toLowerCase();
        return payloadStr.includes(lower) || f.ruleId.toLowerCase().includes(lower);
      });
      if (filteredByTimer.length > 0) {
        list = filteredByTimer;
      }
    }

    return list;
  }, [findings, selectedRange, selectedTimerName, episodes, summary]);

  // Categorize findings into Every Frame (sustained) and Spikes (hitches), with startup hitches (< 1s) ranked last
  const { everyFrameFindings, spikeFindings } = useMemo(() => {
    const everyFrame: Finding[] = [];
    const normalSpikes: Finding[] = [];
    const startupSpikes: Finding[] = [];

    const episodesMap = new Map<number, Episode>(episodes.map((e) => [e.id, e]));

    scopedFindings.forEach((f) => {
      const p = f.parsedPayload;
      const fEpisodes = (p?.episodeIds || [])
        .map((id) => episodesMap.get(id))
        .filter(Boolean) as Episode[];

      const hasSlowRegion = fEpisodes.some((e) => e.kind === 'slow_region');
      const isSustainedRule =
        f.ruleId.includes('region') ||
        f.ruleId.includes('overhead') ||
        f.ruleId.includes('gpu-heavy') ||
        f.ruleId.includes('limiter') ||
        f.ruleId.includes('editor') ||
        f.ruleId.includes('slate') ||
        f.ruleId.includes('lumen') ||
        f.ruleId.includes('nanite') ||
        f.ruleId.includes('shadows');

      if (hasSlowRegion || isSustainedRule) {
        everyFrame.push(f);
      } else {
        const allStartup =
          fEpisodes.length > 0 && fEpisodes.every((e) => e.startS < 1.0);
        if (allStartup) {
          startupSpikes.push(f);
        } else {
          normalSpikes.push(f);
        }
      }
    });

    const getEarliestStart = (f: Finding) => {
      const p = f.parsedPayload;
      const times = (p?.episodeIds || [])
        .map((id) => episodesMap.get(id)?.startS)
        .filter((t): t is number => t !== undefined);
      return times.length > 0 ? Math.min(...times) : 0;
    };

    normalSpikes.sort((a, b) => getEarliestStart(a) - getEarliestStart(b));
    startupSpikes.sort((a, b) => getEarliestStart(a) - getEarliestStart(b));

    return {
      everyFrameFindings: everyFrame,
      spikeFindings: [...normalSpikes, ...startupSpikes],
    };
  }, [scopedFindings, episodes]);

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 p-4 gap-3 select-none overflow-hidden">
      {/* Top Compact Action & Metadata Bar */}
      <SummaryHeader
        summary={summary}
        findings={scopedFindings}
        targetFps={options.targetFps}
        onTargetFpsChange={setTargetFps}
        onOpenInInsights={() => openInInsights()}
        onPickFile={handlePickFile}
        onPickExe={handlePickExe}
        candidates={candidates}
        onOpenTrace={openTrace}
        availableEngines={availableEngines}
        selectedEngineRoot={selectedEngineRoot}
        onEngineChange={setSelectedEngineRoot}
        insightsExists={!!insightsInfo?.exists}
        isAnalyzing={isAnalyzing}
        selectedRange={selectedRange}
      />

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
            {/* "Start Here" Dynamic Diagnostic Banner */}
            <StartHereBanner
              stats={rangeStats}
              summary={summary}
              findings={scopedFindings}
              episodes={episodes}
              onShowOnGraph={(range) => setSelectedRange(range)}
            />

            {/* Frame Time Graph + Bookmarks Track */}
            <div className="h-[250px] shrink-0">
              <FrameGraph
                durationS={summary.durationS}
                targetMs={summary.targetMs}
                episodes={episodes}
                bookmarks={bookmarks}
                selectedRange={selectedRange}
                onSelectRange={setSelectedRange}
                fetchFrameSeries={fetchFrameSeries}
              />
            </div>

            {/* Middle Row: Range Analysis Panel */}
            <div className="shrink-0">
              <RangeAnalysisPanel
                stats={rangeStats}
                targetMs={summary.targetMs}
                hitchCount={summary.hitchCount}
                maxHitchMs={episodes.find((e) => e.kind === 'hitch')?.peakMs}
                isLoading={rangeStatsLoading}
                selectedTimerName={selectedTimerName}
                onSelectTimer={setSelectedTimerName}
              />
            </div>

            {/* Scoped Diagnostic Findings Section */}
            <div className="flex flex-col gap-4 min-h-[300px] pb-6 pt-1 border-t border-slate-800/80">
              {/* Selected Scope Indicator Bar (Hidden when entire trace is active) */}
              {selectedRange &&
                Math.max(...selectedRange) - Math.min(...selectedRange) < summary.durationS - 0.05 && (
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

              {/* No Findings State */}
              {everyFrameFindings.length === 0 && spikeFindings.length === 0 ? (
                <div className="p-8 rounded-lg bg-slate-900/40 border border-slate-800 text-center text-xs text-slate-400">
                  No severe performance bottlenecks detected against the target frame budget in this scope.
                </div>
              ) : (
                <>
                  {/* Section 1: Every Frame (Sustained Bottlenecks) */}
                  {everyFrameFindings.length > 0 && (
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                            Every Frame ({everyFrameFindings.length})
                          </span>
                          <span className="text-[11px] text-slate-400 font-normal">
                            — Continuous budget bottlenecks and sustained overheads
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-3">
                        {everyFrameFindings.map((f: Finding, idx: number) => (
                          <FindingCard
                            key={f.id}
                            finding={f}
                            episodes={episodes}
                            targetFps={options.targetFps}
                            budgetGapMs={rangeStats?.budgetGapMs || 0}
                            defaultExpanded={idx < 3}
                            onSelectRange={(range) => setSelectedRange(range)}
                            onOpenInInsights={() => openInInsights()}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Section 2: Spikes (Hitches) */}
                  {spikeFindings.length > 0 && (
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                            Spikes ({spikeFindings.length})
                          </span>
                          <span className="text-[11px] text-slate-400 font-normal">
                            — Discrete frame hitches and anomalous pauses
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500 font-mono">Sorted chronologically (startup last)</span>
                      </div>

                      <div className="flex flex-col gap-3">
                        {spikeFindings.map((f: Finding, idx: number) => (
                          <FindingCard
                            key={f.id}
                            finding={f}
                            episodes={episodes}
                            targetFps={options.targetFps}
                            budgetGapMs={rangeStats?.budgetGapMs || 0}
                            defaultExpanded={everyFrameFindings.length + idx < 3}
                            onSelectRange={(range) => setSelectedRange(range)}
                            onOpenInInsights={() => openInInsights()}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Bottom Collapsible Details Drawer */}
              <DetailsDrawer summary={summary} />
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
