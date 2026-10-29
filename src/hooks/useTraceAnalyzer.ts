import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEngines } from './useEngines';
import { useProjects } from './useProjects';
import { useProgress } from '../contexts/ProgressContext';
import type {
  AnalysisOptions,
  Episode,
  Finding,
  FindingPayload,
  FrameSeriesResponse,
  InsightsExeInfo,
  RangeStatisticsResponse,
  TraceBookmark,
  TraceCandidate,
  TraceProgressPayload,
  TraceSummary,
} from '../types/traceAnalyzer';

const DEFAULT_OPTIONS: AnalysisOptions = {
  targetFps: 60,
  hitchFactor: 2.5,
  hitchMinExtraMs: 12.0,
  hitchFloorMs: 33.333,
  maxEpisodes: 15,
  baselineSamples: 6,
  maxWindowRows: 5000000,
};

export function useTraceAnalyzer() {
  const { engines, allEngines } = useEngines();
  const { projects } = useProjects();
  const { startProgress, finishProgress } = useProgress();

  const [candidates, setCandidates] = useState<TraceCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  const [currentTracePath, setCurrentTracePath] = useState<string | null>(null);
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<number | null>(null);

  const [bookmarks, setBookmarks] = useState<TraceBookmark[]>([]);
  const [selectedRange, setSelectedRange] = useState<[number, number] | null>(null);
  const [rangeStats, setRangeStats] = useState<RangeStatisticsResponse | null>(null);
  const [rangeStatsLoading, setRangeStatsLoading] = useState(false);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progressPayload, setProgressPayload] = useState<TraceProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [options, setOptions] = useState<AnalysisOptions>(DEFAULT_OPTIONS);

  // Available installed engines list
  const availableEngines = useMemo(() => {
    const list = [...engines, ...allEngines];
    const unique = new Map<string, string>(); // root -> version
    for (const e of list) {
      let root = e.editorPath;
      const lower = root.toLowerCase().replace(/\\/g, '/');
      const binIdx = lower.indexOf('/engine/binaries/');
      if (binIdx !== -1) {
        root = root.substring(0, binIdx);
      }
      if (root && !unique.has(root)) {
        unique.set(root, e.version || 'Unreal Engine');
      }
    }
    return Array.from(unique.entries()).map(([root, version]) => ({ root, version }));
  }, [engines, allEngines]);

  const [selectedEngineRoot, setSelectedEngineRoot] = useState<string>(() => {
    return availableEngines.length > 0 ? availableEngines[0].root : '';
  });

  useEffect(() => {
    if (availableEngines.length > 0 && !availableEngines.some((e) => e.root === selectedEngineRoot)) {
      setSelectedEngineRoot(availableEngines[0].root);
    }
  }, [availableEngines, selectedEngineRoot]);

  const [insightsInfo, setInsightsInfo] = useState<InsightsExeInfo | null>(null);

  // Resolve Insights.exe whenever selectedEngineRoot changes
  useEffect(() => {
    if (!selectedEngineRoot) {
      setInsightsInfo(null);
      return;
    }
    invoke<InsightsExeInfo>('trace_find_insights', { engineRoot: selectedEngineRoot })
      .then((info) => setInsightsInfo(info))
      .catch(() => setInsightsInfo({ path: undefined, exists: false }));
  }, [selectedEngineRoot]);

  // Load candidate traces
  const refreshCandidates = useCallback(() => {
    setCandidatesLoading(true);
    const activeProject = projects.length > 0 ? projects[0].projectPath : undefined;
    invoke<TraceCandidate[]>('trace_list_candidates', { projectPath: activeProject })
      .then((res) => setCandidates(res))
      .catch((e) => console.error('Failed to list trace candidates:', e))
      .finally(() => setCandidatesLoading(false));
  }, [projects]);

  useEffect(() => {
    refreshCandidates();
  }, [refreshCandidates]);

  // Listen to Tauri progress events
  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenFrames: UnlistenFn | undefined;
    let unlistenFindings: UnlistenFn | undefined;

    listen<TraceProgressPayload>('trace-analyzer:progress', (event) => {
      setProgressPayload(event.payload);
    }).then((fn) => {
      unlistenProgress = fn;
    });

    listen('trace-analyzer:frames-ready', () => {
      // Pass A frames ready
    }).then((fn) => {
      unlistenFrames = fn;
    });

    listen('trace-analyzer:findings-ready', () => {
      // Pass B findings ready
    }).then((fn) => {
      unlistenFindings = fn;
    });

    return () => {
      unlistenProgress?.();
      unlistenFrames?.();
      unlistenFindings?.();
    };
  }, []);

  // Open trace handler
  const openTrace = useCallback(
    async (tracePath: string) => {
      setError(null);
      setIsAnalyzing(true);
      setCurrentTracePath(tracePath);
      setSummary(null);
      setEpisodes([]);
      setFindings([]);
      setSelectedEpisodeId(null);

      startProgress();

      try {
        const insightsPath = insightsInfo?.path || '';
        if (!insightsPath) {
          throw new Error('Unreal Insights executable could not be found for the selected engine.');
        }

        const matchedVer = availableEngines.find((e) => e.root === selectedEngineRoot)?.version || '5.x';

        const res = await invoke<TraceSummary>('trace_open', {
          tracePath,
          insightsPath,
          engineVersion: matchedVer,
          options,
        });

        setSummary(res);

        // Fetch episodes, findings, bookmarks & initial range statistics
        const [eps, fnds, bms] = await Promise.all([
          invoke<Episode[]>('trace_get_episodes', { traceId: res.traceId }),
          invoke<Finding[]>('trace_get_findings', { traceId: res.traceId }),
          invoke<TraceBookmark[]>('trace_get_bookmarks', { traceId: res.traceId }).catch(() => []),
        ]);

        const parsedFindings: Finding[] = fnds.map((f) => {
          let parsed: FindingPayload | undefined;
          try {
            parsed = JSON.parse(f.payload);
          } catch {
            // fallback
          }
          return {
            ...f,
            parsedPayload: parsed,
          };
        });

        setEpisodes(eps);
        setFindings(parsedFindings);
        setBookmarks(bms);

        const initialRange: [number, number] = [0, res.durationS];
        setSelectedRange(initialRange);
        if (res.durationS > 0) {
          invoke<RangeStatisticsResponse>('trace_get_range_statistics', {
            traceId: res.traceId,
            startS: 0,
            endS: res.durationS,
          })
            .then((stats) => setRangeStats(stats))
            .catch((e) => console.error('Failed to fetch initial range stats:', e));
        }

        if (eps.length > 0) {
          setSelectedEpisodeId(eps[0].id);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsAnalyzing(false);
        finishProgress();
        refreshCandidates();
      }
    },
    [insightsInfo, availableEngines, selectedEngineRoot, options, startProgress, finishProgress, refreshCandidates]
  );

  // Launch game executable with trace flags and monitor until exit
  const launchAndTraceExe = useCallback(
    async (exePath: string, customArgs?: string, traceFilePath?: string) => {
      let resolvedInsights = insightsInfo?.path;
      if (!resolvedInsights && selectedEngineRoot) {
        try {
          const info = await invoke<InsightsExeInfo>('trace_find_insights', {
            engineRoot: selectedEngineRoot,
          });
          resolvedInsights = info.path;
        } catch {
          // ignore
        }
      }

      if (!resolvedInsights) {
        setError(
          'Unreal Insights executable not found. Please ensure an engine with Unreal Insights is selected.'
        );
        return;
      }

      setIsAnalyzing(true);
      setError(null);
      setSummary(null);
      setEpisodes([]);
      setFindings([]);
      setSelectedEpisodeId(null);
      startProgress();

      try {
        const engVer =
          availableEngines.find((e) => e.root === selectedEngineRoot)?.version || '5.7';

        const res = await invoke<TraceSummary>('trace_launch_and_monitor', {
          exePath,
          customArgs: customArgs || null,
          traceFilePath: traceFilePath || null,
          insightsPath: resolvedInsights,
          engineVersion: engVer,
          options,
        });

        setSummary(res);
        setCurrentTracePath(res.path);

        const [eps, fnds, bms] = await Promise.all([
          invoke<Episode[]>('trace_get_episodes', { traceId: res.traceId }),
          invoke<Finding[]>('trace_get_findings', { traceId: res.traceId }),
          invoke<TraceBookmark[]>('trace_get_bookmarks', { traceId: res.traceId }).catch(() => []),
        ]);

        const parsedFindings: Finding[] = fnds.map((f) => {
          try {
            const parsed = JSON.parse(f.payload) as FindingPayload;
            return { ...f, parsedPayload: parsed };
          } catch {
            return f;
          }
        });

        setEpisodes(eps);
        setFindings(parsedFindings);
        setBookmarks(bms);

        const initialRange: [number, number] = [0, res.durationS];
        setSelectedRange(initialRange);
        if (res.durationS > 0) {
          invoke<RangeStatisticsResponse>('trace_get_range_statistics', {
            traceId: res.traceId,
            startS: 0,
            endS: res.durationS,
          })
            .then((stats) => setRangeStats(stats))
            .catch((e) => console.error('Failed to fetch initial range stats:', e));
        }

        if (eps.length > 0) {
          setSelectedEpisodeId(eps[0].id);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setIsAnalyzing(false);
        finishProgress();
        refreshCandidates();
      }
    },
    [insightsInfo, availableEngines, selectedEngineRoot, options, startProgress, finishProgress, refreshCandidates]
  );

  // Fetch range statistics for selected time range
  const fetchRangeStatistics = useCallback(
    async (startS: number, endS: number): Promise<RangeStatisticsResponse | null> => {
      if (!summary?.traceId) return null;
      setRangeStatsLoading(true);
      try {
        const stats = await invoke<RangeStatisticsResponse>('trace_get_range_statistics', {
          traceId: summary.traceId,
          startS,
          endS,
        });
        setRangeStats(stats);
        return stats;
      } catch (e) {
        console.error('Failed to fetch range statistics:', e);
        return null;
      } finally {
        setRangeStatsLoading(false);
      }
    },
    [summary?.traceId]
  );

  const rangeStatsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Set selected range and automatically refresh range statistics (debounced)
  const handleSetSelectedRange = useCallback(
    (range: [number, number] | null) => {
      setSelectedRange(range);
      if (rangeStatsTimerRef.current) {
        clearTimeout(rangeStatsTimerRef.current);
      }
      if (range && summary?.traceId) {
        const [s0, s1] = range;
        rangeStatsTimerRef.current = setTimeout(() => {
          fetchRangeStatistics(s0, s1);
        }, 50);
      }
    },
    [summary?.traceId, fetchRangeStatistics]
  );

  // Cancel running analysis
  const cancelAnalysis = useCallback(async () => {
    try {
      await invoke('trace_cancel');
    } catch (e) {
      console.error('Failed to cancel trace analysis:', e);
    } finally {
      setIsAnalyzing(false);
      finishProgress();
    }
  }, [finishProgress]);

  // Fetch frame series for graph LOD
  const fetchFrameSeries = useCallback(
    async (startS: number, endS: number, maxItems = 1000): Promise<FrameSeriesResponse | null> => {
      if (!summary?.traceId) return null;
      try {
        return await invoke<FrameSeriesResponse>('trace_get_frame_series', {
          traceId: summary.traceId,
          startS,
          endS,
          maxItems,
        });
      } catch (e) {
        console.error('Failed to fetch frame series:', e);
        return null;
      }
    },
    [summary?.traceId]
  );

  // Open in Unreal Insights GUI
  const openInInsights = useCallback(
    async (tracePath?: string) => {
      const p = tracePath || currentTracePath;
      if (!p || !insightsInfo?.path) return;
      try {
        await invoke('trace_open_in_insights', {
          tracePath: p,
          insightsPath: insightsInfo.path,
        });
      } catch (e) {
        console.error('Failed to launch Unreal Insights GUI:', e);
      }
    },
    [currentTracePath, insightsInfo]
  );

  // Re-analyze with new target FPS
  const setTargetFps = useCallback(
    async (targetFps: number) => {
      setOptions((prev) => ({ ...prev, targetFps }));
      if (!summary?.traceId || isAnalyzing) return;

      try {
        const newOpts = { ...options, targetFps };
        const res = await invoke<TraceSummary>('trace_open', {
          tracePath: summary.path,
          insightsPath: insightsInfo?.path || '',
          engineVersion: summary.engineVersion,
          options: newOpts,
        });
        setSummary(res);
      } catch (e) {
        console.error('Failed to re-analyze trace:', e);
      }
    },
    [summary, isAnalyzing, options, insightsInfo]
  );

  return {
    candidates,
    candidatesLoading,
    refreshCandidates,
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
    setSelectedRange: handleSetSelectedRange,
    rangeStats,
    rangeStatsLoading,
    fetchRangeStatistics,
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
  };
}
