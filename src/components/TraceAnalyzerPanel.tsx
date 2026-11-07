import { useEffect, useState, useMemo, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTraceAnalyzer } from '../hooks/useTraceAnalyzer';
import { FrameGraph } from './traceAnalyzer/FrameGraph';
import { SummaryHeader } from './traceAnalyzer/SummaryHeader';
import { FindingCard } from './traceAnalyzer/FindingCard';
import { LoadingStages } from './traceAnalyzer/LoadingStages';
import { RangeAnalysisPanel } from './traceAnalyzer/RangeAnalysisPanel';
import { getRemediationAdvice } from '../utils/remediationAdvice';
import type { Episode, Finding, FindingPayload, Level, TraceCandidate } from '../types/traceAnalyzer';

export function TraceAnalyzerPanel() {
  const {
    candidates,
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
    chunks,
    issues,
    importProgress,
    setFrontier,
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
    clearLocalTraceDatabase,
    refreshTraceDiagnostic,
  } = useTraceAnalyzer();

  const [isDragOver, setIsDragOver] = useState(false);
  const [showLaunchModal, setShowLaunchModal] = useState(false);
  const [showCleanDbModal, setShowCleanDbModal] = useState(false);
  const [isCleaningDb, setIsCleaningDb] = useState(false);
  const [cleanStatusMsg, setCleanStatusMsg] = useState<string | null>(null);
  const [selectedExePath, setSelectedExePath] = useState<string>('');
  const [customArgs, setCustomArgs] = useState<string>('');
  const [selectedTimerName, setSelectedTimerName] = useState<string | null>(null);
  const findingsSectionRef = useRef<HTMLDivElement>(null);

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

  // Episodes strictly within active selection window
  const rangeEpisodes = useMemo(() => {
    if (!summary) return [];
    if (!selectedRange) return episodes;
    const [minS, maxS] = [Math.min(...selectedRange), Math.max(...selectedRange)];
    if (maxS - minS >= summary.durationS - 0.05) return episodes;
    return episodes.filter((e) => e.startS <= maxS && e.endS >= minS);
  }, [episodes, selectedRange, summary]);

  const rangeHitches = useMemo(() => {
    return rangeEpisodes.filter((e) => e.kind === 'hitch');
  }, [rangeEpisodes]);

  const rangeHitchCount = rangeHitches.length;
  const rangeMaxHitchMs = useMemo(() => {
    if (rangeHitches.length === 0) return undefined;
    return Math.max(...rangeHitches.map((h) => h.peakMs));
  }, [rangeHitches]);

  // Filter and rank findings strictly based on active selected range & selected timer
  const scopedFindings = useMemo(() => {
    if (!summary) return [];

    const isSmoothRange =
      selectedRange &&
      rangeStats &&
      rangeStats.medianMs <= summary.targetMs * 1.05 &&
      rangeStats.overBudgetPct <= 5 &&
      rangeHitchCount === 0;

    if (isSmoothRange) {
      return [];
    }

    // Prioritize selection-clipped findings directly from backend range statistics if available (Item 3)
    if (rangeStats?.findings && rangeStats.findings.length > 0) {
      const parsedRangeFindings: Finding[] = rangeStats.findings
        .map((f) => {
          let parsed: FindingPayload | undefined;
          try {
            parsed = JSON.parse(f.payload);
          } catch {
            // ignore
          }

          if (parsed) {
            const ofExcess = parsed.ofExcessMs ?? 0;
            const explains = parsed.explainsMs ?? 0;
            const shareOfExcess = ofExcess > 0.001 ? Math.min(1.0, explains / ofExcess) : 0.5;

            // Enforce low-share capping rule (<10% share is never high)
            if (shareOfExcess < 0.10) {
              parsed.fixLikelihood = 'low';
              parsed.matchConfidence = 'low';
            }

            if (!parsed.matchScore || parsed.matchScore === 90 || parsed.matchScore === 75) {
              const baseScore = parsed.matchConfidence === 'high' ? 80 : parsed.matchConfidence === 'medium' ? 50 : 20;
              parsed.matchScore = Math.min(100, Math.round(baseScore + Math.min(20, shareOfExcess * 20)));
            }
          }

          const effFixLikelihood = parsed?.fixLikelihood || (f.fixLikelihood as Level) || 'low';
          const effConfidence = parsed?.matchConfidence === 'high' ? 0.9 : parsed?.matchConfidence === 'medium' ? 0.6 : 0.3;

          return {
            id: f.id,
            ruleId: f.ruleId,
            rank: f.rank,
            matchConfidence: effConfidence,
            fixLikelihood: effFixLikelihood,
            payload: parsed ? JSON.stringify(parsed) : f.payload,
            episodeIds: f.episodeIds,
            parsedPayload: parsed,
          };
        })
        .filter((f) => {
          const p = f.parsedPayload;
          if (!p) return false;
          // Discard zero / trivial sub-0.1ms findings
          if (p.explainsMs < 0.1 && (p.ofExcessMs ?? 0) < 0.5) return false;
          return true;
        });

      if (selectedTimerName) {
        const lower = selectedTimerName.toLowerCase();
        const filtered = parsedRangeFindings.filter((f) => {
          const payloadStr = f.payload.toLowerCase();
          return payloadStr.includes(lower) || f.ruleId.toLowerCase().includes(lower);
        });
        if (filtered.length > 0) return filtered;
      }
      return parsedRangeFindings;
    }
    
    // Fallback: Convert diagnosed issues and occurrences overlapping the range into Findings grouped by issue
    const convertedIssueFindings: Finding[] = [];
    if (issues && issues.length > 0 && summary.durationS > 0) {
      const [minS, maxS] = selectedRange
        ? [Math.min(...selectedRange), Math.max(...selectedRange)]
        : [0, summary.durationS];

      for (const item of issues) {
        const issue = item.issue;
        const overlappingOccs = item.occurrences.filter((occ) => {
          const fromS = occ.startS ?? 0;
          const toS = occ.endS > fromS ? occ.endS : fromS + 0.016;
          return fromS <= maxS && toS >= minS;
        });

        if (overlappingOccs.length === 0) continue;

        let primaryTimerName = 'Unprofiled Execution';
        let primaryPath = '';
        let primarySanityViolation = false;
        let totalClippedExcessMs = 0;
        let totalClippedFrames = 0;
        let peakFrameMs = 0;
        const subOccEvidenceList: Array<{ label: string; valueMs: number; thread: string; note: string }> = [];
        const episodeIds: number[] = [];

        for (const occ of overlappingOccs) {
          episodeIds.push(occ.occurrenceId);
          const fromS = occ.startS ?? 0;
          const toS = occ.endS > fromS ? occ.endS : fromS + 0.016;

          let evidenceObj: { timer?: string; excessMs?: number; path?: string; sanityViolation?: boolean; leaves?: Array<{ timer?: string; path?: string }> } = {};
          try {
            evidenceObj = JSON.parse(occ.evidenceJson);
          } catch {
            // ignore
          }

          if (primaryTimerName === 'Unprofiled Execution' || primaryTimerName === 'Other') {
            if (evidenceObj.timer) primaryTimerName = evidenceObj.timer;
            else if (evidenceObj.leaves && evidenceObj.leaves.length > 0 && evidenceObj.leaves[0].timer) {
              primaryTimerName = evidenceObj.leaves[0].timer;
            }
          }
          if (!primaryPath && evidenceObj.path) primaryPath = evidenceObj.path;
          if (evidenceObj.sanityViolation) primarySanityViolation = true;

          const occFrames = Math.max(1, occ.frameTo - occ.frameFrom + 1);
          const occExcess = occ.sumExcessMs > 0 ? occ.sumExcessMs : occ.meanExcessMs * occFrames;
          totalClippedExcessMs += occExcess;
          totalClippedFrames += occFrames;
          peakFrameMs = Math.max(peakFrameMs, occ.peakFrameMs);

          subOccEvidenceList.push({
            label: evidenceObj.path ? `${evidenceObj.path}` : (evidenceObj.timer || primaryTimerName),
            valueMs: occ.meanExcessMs > 0 ? occ.meanExcessMs : occExcess / occFrames,
            thread: issue.threadRole || 'general',
            note: `Frames ${occ.frameFrom}..${occ.frameTo} (${fromS.toFixed(2)}s – ${toS.toFixed(2)}s), Peak: ${occ.peakFrameMs.toFixed(1)} ms, Excess: +${occExcess.toFixed(1)} ms`,
          });
        }

        const isSpike = issue.scale === 'spike';
        const threadRole = issue.threadRole || 'general';

        const advice = getRemediationAdvice(
          issue.ruleId,
          primaryTimerName,
          threadRole,
          isSpike ? 'spike' : 'sustained'
        );

        const explainsMs = totalClippedFrames > 0 ? totalClippedExcessMs / totalClippedFrames : 0;
        const ofExcessMs = rangeStats?.budgetGapMs && rangeStats.budgetGapMs > 0.001
          ? rangeStats.budgetGapMs
          : (totalClippedExcessMs > 0 ? explainsMs : 1.0);

        const shareOfExcess = ofExcessMs > 0.001 ? Math.min(1.0, explainsMs / ofExcessMs) : 0.5;
        const totalSelectedRangeFrames = rangeStats?.frameCount || summary.frameCount || Math.max(1, totalClippedFrames);
        const fractionOfFramesExceeded = Math.min(1.0, totalClippedFrames / Math.max(1, totalSelectedRangeFrames));

        let fixLikelihood: Level = 'low';
        let matchConfidence: Level = 'low';

        if (shareOfExcess < 0.10) {
          fixLikelihood = 'low';
          matchConfidence = 'low';
        } else if (shareOfExcess >= 0.40 && fractionOfFramesExceeded >= 0.50 && !primarySanityViolation) {
          fixLikelihood = 'high';
          matchConfidence = 'high';
        } else if (shareOfExcess >= 0.20 || fractionOfFramesExceeded >= 0.30) {
          fixLikelihood = 'medium';
          matchConfidence = 'medium';
        } else {
          fixLikelihood = 'low';
          matchConfidence = 'low';
        }

        const baseScore = matchConfidence === 'high' ? 80 : matchConfidence === 'medium' ? 50 : 20;
        const matchScore = Math.min(100, Math.round(baseScore + Math.min(20, shareOfExcess * 20)));

        const parsed: FindingPayload = {
          title: advice.title,
          matchConfidence,
          matchScore,
          fixLikelihood,
          explainsMs,
          ofExcessMs,
          evidence: subOccEvidenceList,
          fixes: advice.fixes,
          verify: advice.verify,
          caveats: advice.caveats || [],
          episodeIds,
        };

        const confVal = matchConfidence === 'high' ? 0.9 : matchConfidence === 'medium' ? 0.6 : 0.3;

        convertedIssueFindings.push({
          id: issue.issueId || (overlappingOccs[0].occurrenceId + 100000),
          ruleId: issue.ruleId,
          rank: explainsMs,
          matchConfidence: confVal,
          fixLikelihood,
          payload: JSON.stringify(parsed),
          episodeIds,
          parsedPayload: parsed,
        });
      }
    }

    let list = [...findings, ...convertedIssueFindings];

    if (selectedRange) {
      const [minS, maxS] = [Math.min(...selectedRange), Math.max(...selectedRange)];

      // Check if range is roughly entire trace
      const isFullTrace = maxS - minS >= summary.durationS - 0.05;

      if (!isFullTrace) {
        // If range is within budget with no hitches, don't leak global over-budget findings
        const isSmoothRange =
          rangeStats &&
          rangeStats.medianMs <= summary.targetMs &&
          rangeStats.overBudgetPct <= 10 &&
          rangeHitchCount === 0;

        // Filter to only findings whose occurrences/episodes overlap the active selection window
        list = list.filter((f) => {
          if (isSmoothRange) {
            return false;
          }
          if (!f.episodeIds || f.episodeIds.length === 0) {
            // General finding without episodes: only keep if range is over budget
            return rangeStats
              ? rangeStats.medianMs > summary.targetMs || rangeStats.overBudgetPct > 15
              : true;
          }
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
  }, [findings, issues, selectedRange, selectedTimerName, episodes, summary, rangeStats, rangeHitchCount]);

  // Categorize findings into Every Frame (sustained) and Spikes (hitches), with startup hitches (< 1s) ranked last
  const { everyFrameFindings, spikeFindings } = useMemo(() => {
    const everyFrame: Finding[] = [];
    const normalSpikes: Finding[] = [];
    const startupSpikes: Finding[] = [];

    const episodesMap = new Map<number, Episode>(episodes.map((e) => [e.id, e]));
    const limiting = rangeStats?.threadMedians?.limitingThread?.toLowerCase();
    const topTimerNames = new Set((rangeStats?.topTimers || []).slice(0, 5).map((t) => t.name.toLowerCase()));

    for (const f of scopedFindings) {
      const episodeIds =
        f.episodeIds && f.episodeIds.length > 0
          ? f.episodeIds
          : f.parsedPayload?.episodeIds || [];

      const isSpike =
        episodeIds.some((id) => {
          const ep = episodesMap.get(id);
          return ep && ep.kind === 'hitch';
        }) ||
        f.ruleId.includes('hitch') ||
        f.ruleId.includes('stall');

      if (isSpike) {
        const isStartup = episodeIds.some((id) => {
          const ep = episodesMap.get(id);
          return ep && ep.startS < 1.0;
        });
        if (isStartup) {
          startupSpikes.push(f);
        } else {
          normalSpikes.push(f);
        }
      } else {
        everyFrame.push(f);
      }
    }

    const getFindingScore = (f: Finding): number => {
      let score = f.parsedPayload?.matchScore ?? f.matchConfidence ?? 0;
      const rule = f.ruleId.toLowerCase();
      const title = f.parsedPayload?.title?.toLowerCase() || '';

      if (limiting) {
        if (
          limiting === 'gpu' &&
          (rule.includes('gpu') ||
            rule.includes('nanite') ||
            rule.includes('lumen') ||
            rule.includes('shadows') ||
            title.includes('gpu'))
        ) {
          score += 50;
        } else if (
          limiting === 'game' &&
          (rule.includes('game') ||
            rule.includes('blueprint') ||
            rule.includes('gc') ||
            rule.includes('tick') ||
            title.includes('game') ||
            title.includes('cpu'))
        ) {
          score += 50;
        } else if (
          limiting === 'render' &&
          (rule.includes('render') || rule.includes('rhi') || title.includes('render'))
        ) {
          score += 50;
        }
      }

      // Bonus if finding evidence references any top timer from the selected range
      if (f.parsedPayload?.evidence) {
        for (const ev of f.parsedPayload.evidence) {
          if (ev.label && topTimerNames.has(ev.label.toLowerCase())) {
            score += 20;
            break;
          }
        }
      }

      return score;
    };

    everyFrame.sort((a, b) => getFindingScore(b) - getFindingScore(a));

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
  }, [scopedFindings, episodes, rangeStats]);

  return (
    <div className="flex flex-col h-full min-h-0 text-slate-100 gap-3 select-none overflow-hidden">
      {/* Top Compact Action & Metadata Bar */}
      <SummaryHeader
        summary={summary}
        findings={scopedFindings}
        issues={issues}
        rangeStats={rangeStats}
        bookmarks={bookmarks}
        targetFps={options.targetFps}
        onTargetFpsChange={setTargetFps}
        onOpenInInsights={() => openInInsights()}
        onPickFile={handlePickFile}
        onPickExe={handlePickExe}
        candidates={candidates}
        onOpenTrace={openTrace}
        insightsExists={!!insightsInfo?.exists}
        isAnalyzing={isAnalyzing}
        selectedRange={selectedRange}
        onResetRange={() => summary && setSelectedRange([0, summary.durationS])}
        onRefreshDiagnostic={refreshTraceDiagnostic}
        onCleanTraceDatabase={() => setShowCleanDbModal(true)}
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
          <div className="flex-1 flex items-center justify-center min-h-[300px]">
            <LoadingStages progress={progressPayload} importProgress={importProgress} onCancel={cancelAnalysis} />
          </div>
        ) : summary ? (
          /* Active Trace View: Single Scroll Column Dashboard */
          <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-1">
            {/* 3 & 4. Frame Graph with Header Metrics, Bookmarks Chips, Worst-5 Hitch Labels, and Findings Lane */}
            <div className="min-h-[280px] shrink-0">
              <FrameGraph
                summary={summary}
                durationS={summary.durationS}
                targetMs={summary.targetMs}
                episodes={episodes}
                bookmarks={bookmarks}
                chunks={chunks}
                issues={issues}
                selectedRange={selectedRange}
                onSelectRange={setSelectedRange}
                onSetFrontier={setFrontier}
                fetchFrameSeries={fetchFrameSeries}
              />
            </div>

            {/* 5 & 7. Range Card (Verdict, 3 numbers, Thread Bars, First thing to try) + Details Accordion (Subsystems, Waiting, Channels) */}
            <div className="shrink-0">
              <RangeAnalysisPanel
                stats={rangeStats}
                summary={summary}
                targetMs={summary.targetMs}
                topFinding={scopedFindings[0]}
                hitchCount={rangeHitchCount}
                maxHitchMs={rangeMaxHitchMs}
                isLoading={rangeStatsLoading}
                selectedTimerName={selectedTimerName}
                onSelectTimer={setSelectedTimerName}
                onSeeDetails={() => findingsSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
                onRefreshDiagnostic={refreshTraceDiagnostic}
                onCleanAllCaches={() => setShowCleanDbModal(true)}
              />
            </div>

            {/* 6. Findings Section ("Every frame" and "Spikes") */}
            <div ref={findingsSectionRef} className="flex flex-col gap-4 pb-6 pt-1">
              {everyFrameFindings.length === 0 && spikeFindings.length === 0 ? (
                <div className="p-6 rounded-xl bg-slate-900/40 border border-slate-800 text-center flex flex-col items-center justify-center gap-1.5">
                  <div className="text-sm font-semibold text-emerald-400">Within Target Budget</div>
                  <div className="text-xs text-slate-400 max-w-md">
                    No discrete performance bottlenecks detected in this range.
                  </div>
                </div>
              ) : (
                <>
                  {/* Every Frame Findings */}
                  {everyFrameFindings.length > 0 && (
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                          Every Frame ({everyFrameFindings.length})
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono">
                          Continuous frame time bottlenecks
                        </span>
                      </div>

                      <div className="flex flex-col gap-2.5">
                        {everyFrameFindings.map((f: Finding, idx: number) => (
                          <FindingCard
                            key={f.id}
                            finding={f}
                            episodes={episodes}
                            bookmarks={bookmarks}
                            targetFps={options.targetFps}
                            budgetGapMs={rangeStats?.budgetGapMs || 0}
                            defaultExpanded={idx === 0}
                            onSelectRange={(range) => setSelectedRange(range)}
                            onOpenInInsights={() => openInInsights()}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Spikes Findings */}
                  {spikeFindings.length > 0 && (
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                          Spikes ({spikeFindings.length})
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono">
                          Discrete frame hitches
                        </span>
                      </div>

                      <div className="flex flex-col gap-2.5">
                        {spikeFindings.map((f: Finding, idx: number) => (
                          <FindingCard
                            key={f.id}
                            finding={f}
                            episodes={episodes}
                            bookmarks={bookmarks}
                            targetFps={options.targetFps}
                            budgetGapMs={rangeStats?.budgetGapMs || 0}
                            defaultExpanded={everyFrameFindings.length === 0 && idx === 0}
                            onSelectRange={(range) => setSelectedRange(range)}
                            onOpenInInsights={() => openInInsights()}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
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

              <div className="flex flex-wrap items-center justify-center gap-3 mt-2">
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
                <button
                  type="button"
                  onClick={() => setShowCleanDbModal(true)}
                  className="px-3.5 py-2 rounded bg-slate-800/80 hover:bg-rose-950/60 hover:border-rose-700/60 hover:text-rose-200 text-slate-300 text-xs font-medium border border-slate-700 transition-colors shadow-sm flex items-center gap-1.5"
                  title="Clear all cached trace SQLite databases (original .utrace files will NOT be deleted)"
                >
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  <span>Clean Local Trace DB</span>
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

      {/* Clean Trace Database Modal */}
      {showCleanDbModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-md w-full shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <span className="text-rose-400">🗑️</span> Clean Local Trace Database
              </h3>
              <button
                type="button"
                onClick={() => {
                  setShowCleanDbModal(false);
                  setCleanStatusMsg(null);
                }}
                className="text-slate-400 hover:text-slate-200 text-sm"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-3 text-xs text-slate-300 leading-relaxed">
              <p>
                This action will delete all local SQLite cache databases, index pyramids, and precomputed diagnoses generated by the launcher.
              </p>
              <div className="p-3 rounded bg-amber-950/30 border border-amber-600/30 text-amber-200 text-xs">
                <strong>Important:</strong> Your original <code className="bg-slate-900 px-1 py-0.5 rounded font-mono text-amber-100">.utrace</code> files will <strong>NOT</strong> be deleted. Any trace can be re-opened and re-imported fresh at any time.
              </div>
              {cleanStatusMsg && (
                <div className="p-2.5 rounded bg-emerald-950/40 border border-emerald-500/40 text-emerald-300 text-xs">
                  {cleanStatusMsg}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setShowCleanDbModal(false);
                  setCleanStatusMsg(null);
                }}
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isCleaningDb}
                onClick={async () => {
                  setIsCleaningDb(true);
                  try {
                    await clearLocalTraceDatabase();
                    setCleanStatusMsg('All trace database caches have been cleared successfully.');
                    setTimeout(() => {
                      setShowCleanDbModal(false);
                      setCleanStatusMsg(null);
                    }, 1200);
                  } catch (e) {
                    console.error('Failed to clean cache:', e);
                  } finally {
                    setIsCleaningDb(false);
                  }
                }}
                className="px-3.5 py-1.5 rounded bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-medium transition-colors shadow-sm flex items-center gap-1.5"
              >
                {isCleaningDb ? (
                  <span>Cleaning...</span>
                ) : (
                  <span>Confirm Clean</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

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
