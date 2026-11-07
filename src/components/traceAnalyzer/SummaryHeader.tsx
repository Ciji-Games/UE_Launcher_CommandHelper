import { useState } from 'react';
import type { Finding, IssueWithOccurrences, RangeStatisticsResponse, TraceBookmark, TraceCandidate, TraceSummary } from '../../types/traceAnalyzer';

export interface SummaryHeaderProps {
  summary: TraceSummary | null;
  findings: Finding[];
  issues?: IssueWithOccurrences[];
  rangeStats?: RangeStatisticsResponse | null;
  bookmarks?: TraceBookmark[];
  targetFps: number;
  onTargetFpsChange: (fps: number) => void;
  onOpenInInsights: () => void;
  onPickFile: () => void;
  onPickExe: () => void;
  candidates: TraceCandidate[];
  onOpenTrace: (path: string) => void;
  insightsExists: boolean;
  isAnalyzing: boolean;
  selectedRange?: [number, number] | null;
  onResetRange?: () => void;
  onRefreshDiagnostic?: () => void;
  onCleanTraceDatabase?: () => void;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds) || seconds <= 0) {
    return '0.0s';
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(0);
  return `${mins}m ${secs}s`;
}

export function SummaryHeader({
  summary,
  findings,
  issues = [],
  rangeStats,
  bookmarks = [],
  targetFps,
  onTargetFpsChange,
  onOpenInInsights,
  onPickFile,
  onPickExe,
  candidates,
  onOpenTrace,
  insightsExists,
  isAnalyzing,
  selectedRange,
  onResetRange,
  onRefreshDiagnostic,
  onCleanTraceDatabase,
}: SummaryHeaderProps) {
  const [copied, setCopied] = useState(false);
  const [jsonExported, setJsonExported] = useState(false);

  const medianFps =
    summary && (summary.medianMs ?? 0) > 0 ? Math.round(1000 / summary.medianMs) : 0;

  const handleCopyReport = () => {
    if (!summary) return;

    let md = `# Unreal Engine Trace Diagnosis Report\n\n`;
    md += `**Trace File**: \`${summary.path || 'Unknown'}\`\n`;
    md += `**Engine Version**: ${summary.engineVersion || 'Unknown'}\n`;
    md += `**Duration**: ${formatDuration(summary.durationS)} (${(summary.frameCount ?? 0).toLocaleString()} frames)\n`;

    if (selectedRange) {
      const dur = (selectedRange[1] - selectedRange[0]).toFixed(2);
      md += `**Selected Window**: ${selectedRange[0].toFixed(2)}s - ${selectedRange[1].toFixed(2)}s (${dur}s)\n`;
    }

    md += `**Performance**: Median ${medianFps} FPS (${(summary.medianMs ?? 0).toFixed(1)} ms) | p95: ${(summary.p95Ms ?? 0).toFixed(1)} ms | p99: ${(summary.p99Ms ?? 0).toFixed(1)} ms\n`;
    md += `**Issues**: ${summary.hitchCount ?? 0} hitch(es)\n\n`;

    if (summary.isEditorBuild) {
      md += `> **Note**: Captured in Unreal Editor session. Slate and Editor overhead are included.\n\n`;
    }

    if (rangeStats?.regimeChanges && rangeStats.regimeChanges.length > 0) {
      md += `### Frame Time Regime Changes\n\n`;
      rangeStats.regimeChanges.forEach((rc) => {
        md += `- ${rc.description}\n`;
      });
      md += `\n`;
    }

    // Export one entry per issue with every occurrence (Item 10)
    if (issues && issues.length > 0) {
      md += `### Diagnosed Issues (${issues.length})\n\n`;
      issues.forEach((item, idx) => {
        const iss = item.issue;
        md += `#### ${idx + 1}. ${iss.ruleId} [${iss.scale}] (${iss.threadRole})\n`;
        md += `- **Occurrences**: ${item.occurrences.length} (${iss.totalExcessMs.toFixed(1)} ms total excess, worst peak: ${iss.worstExcessMs.toFixed(1)} ms)\n`;
        md += `- **Occurrences Detail**:\n`;
        item.occurrences.forEach((occ, oIdx) => {
          const sTime = occ.startS?.toFixed(2) ?? '0.00';
          const eTime = occ.endS?.toFixed(2) ?? '0.00';
          md += `  - #${oIdx + 1}: Frames ${occ.frameFrom}..${occ.frameTo} (${sTime}s – ${eTime}s) | Peak: ${occ.peakFrameMs.toFixed(1)} ms | Mean Excess: ${occ.meanExcessMs.toFixed(1)} ms/frame\n`;
        });
        md += `\n`;
      });
    } else if (findings.length > 0) {
      md += `### Scoped Findings (${findings.length})\n\n`;
      findings.forEach((f, idx) => {
        const p = f.parsedPayload;
        const isSustained =
          p?.scale === 'sustained' ||
          f.ruleId.includes('sustained') ||
          (p?.title ? p.title.toLowerCase().includes('sustained') : false) ||
          (p?.evidence?.[0]?.note ? p.evidence[0].note.includes('/frame') : false) ||
          (p?.evidence?.[0]?.label ? p.evidence[0].label.includes('ms/frame') : false);

        md += `#### ${idx + 1}. ${p?.title || f.ruleId}\n`;
        md += `- **Confidence**: ${p?.matchConfidence || 'N/A'}\n`;
        md += `- **Fix Likelihood**: ${p?.fixLikelihood || f.fixLikelihood}\n`;
        if (isSustained) {
          md += `- **Time Impact**: ${(p?.explainsMs ?? 0).toFixed(1)} ms/frame explained (of ${(p?.ofExcessMs ?? 0).toFixed(1)} ms/frame excess gap)\n\n`;
        } else {
          md += `- **Time Impact**: ${(p?.explainsMs ?? 0).toFixed(1)} ms explained (of ${(p?.ofExcessMs ?? 0).toFixed(1)} ms peak excess)\n\n`;
        }

        if (p?.fixes && p.fixes.length > 0) {
          md += `**Step 1 Fix**:\n- ${p.fixes[0].text} (Effort: ${p.fixes[0].effort})\n\n`;
          if (p.verify) {
            md += `**How to Confirm**:\n- ${p.verify}\n\n`;
          }
        }
      });
    }

    navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleExportJson = () => {
    if (!summary) return;

    const data = {
      summary,
      selectedRange,
      rangeStats,
      issues,
      findings,
      bookmarks,
      exportedAt: new Date().toISOString(),
    };

    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${summary.traceId || 'trace'}_diagnosis.json`;
    a.click();
    URL.revokeObjectURL(url);

    setJsonExported(true);
    setTimeout(() => setJsonExported(false), 2000);
  };

  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const fileName = summary?.path ? summary.path.split(/[/\\]/).pop() : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 w-full bg-slate-900/90 border border-slate-800 rounded-xl p-3 shadow-md">
      {/* Left: File Name & Trace Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {fileName ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800/90 border border-slate-700/80 text-xs max-w-[260px] truncate" title={summary?.path || fileName}>
            <span className="text-sky-400 font-bold">Trace:</span>
            <span className="text-slate-200 font-mono font-medium truncate">{fileName}</span>
          </div>
        ) : (
          <div className="text-xs font-semibold text-slate-300 px-1">
            Unreal Trace Analyzer
          </div>
        )}

        {/* Open Trace Button */}
        <button
          type="button"
          onClick={onPickFile}
          disabled={isAnalyzing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-medium transition-colors shadow-sm"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
          </svg>
          <span>Open .utrace...</span>
        </button>

        {/* Launch Game Executable Button */}
        <button
          type="button"
          onClick={onPickExe}
          disabled={isAnalyzing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-medium border border-slate-700 transition-colors shadow-sm"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Launch (.exe)...</span>
        </button>

        {/* Candidate Traces Dropdown */}
        {candidates.length > 0 && (
          <select
            onChange={(e) => {
              if (e.target.value) onOpenTrace(e.target.value);
            }}
            value=""
            disabled={isAnalyzing}
            className="bg-slate-800 border border-slate-700 text-slate-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-sky-500 focus:outline-none max-w-[170px] truncate"
          >
            <option value="" disabled>
              Recent Traces ({candidates.length})...
            </option>
            {candidates.map((c: TraceCandidate) => (
              <option key={c.path} value={c.path}>
                {c.fileName}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Right Controls: Range Status, FPS Target, Open in Insights, Export Menu */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {/* Current Range Info & Reset Button */}
        {summary && (
          <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 shadow-sm">
            <span className="text-sky-400 font-bold">Range:</span>
            <span className="font-mono">
              {selectedRange && Math.max(...selectedRange) - Math.min(...selectedRange) < summary.durationS - 0.05 ? (
                `${selectedRange[0].toFixed(2)}s – ${selectedRange[1].toFixed(2)}s (${(selectedRange[1] - selectedRange[0]).toFixed(2)}s)`
              ) : (
                `Entire trace (${summary.durationS.toFixed(2)}s)`
              )}
            </span>
            {rangeStats && (
              <span className="text-[11px] text-slate-400 font-mono hidden md:inline border-l border-slate-700 pl-2">
                {rangeStats.frameCount.toLocaleString()} frames ({((rangeStats.durationS / Math.max(summary.durationS, 0.001)) * 100).toFixed(0)}%)
              </span>
            )}
            {onResetRange && (
              <button
                type="button"
                onClick={onResetRange}
                disabled={!selectedRange || Math.max(...selectedRange) - Math.min(...selectedRange) >= summary.durationS - 0.05}
                className="ml-0.5 px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30 disabled:hover:bg-slate-700 text-slate-200 text-[11px] font-sans transition-colors border border-slate-600/50"
                title="Reset selection to entire trace"
              >
                Entire trace
              </button>
            )}
          </div>
        )}

        {/* Target FPS Selector */}
        <div className="flex items-center gap-1 text-slate-400">
          <select
            value={targetFps}
            onChange={(e) => onTargetFpsChange(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200 text-xs focus:ring-1 focus:ring-sky-500 focus:outline-none"
          >
            <option value={30}>30 fps (33.3 ms)</option>
            <option value={60}>60 fps (16.7 ms)</option>
            <option value={120}>120 fps (8.3 ms)</option>
          </select>
        </div>

        {/* Open in Unreal Insights GUI */}
        <button
          type="button"
          onClick={onOpenInInsights}
          disabled={!insightsExists || !summary?.path}
          className="flex items-center gap-1 px-2.5 py-1 bg-sky-600/80 hover:bg-sky-600 disabled:opacity-50 text-white text-xs rounded border border-sky-500/60 font-medium transition-colors"
        >
          <svg className="w-3.5 h-3.5 text-sky-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          <span>Open in Insights</span>
        </button>

        {/* Export Dropdown Menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setExportMenuOpen(!exportMenuOpen)}
            className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-700 transition-colors shadow-sm"
          >
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span>Export</span>
            <svg className={`w-3 h-3 text-slate-400 transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {exportMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                onClick={() => setExportMenuOpen(false)}
              />
              <div className="absolute right-0 mt-1 w-48 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-40 py-1 text-xs flex flex-col">
                {/* 1. Copy Report */}
                <button
                  type="button"
                  onClick={() => {
                    handleCopyReport();
                    setExportMenuOpen(false);
                  }}
                  disabled={!summary}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-800 text-slate-200 disabled:opacity-40 text-left transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  <span>{copied ? '✓ Report Copied' : 'Copy Report'}</span>
                </button>

                {/* 2. Download JSON */}
                <button
                  type="button"
                  onClick={() => {
                    handleExportJson();
                    setExportMenuOpen(false);
                  }}
                  disabled={!summary}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-800 text-slate-200 disabled:opacity-40 text-left transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>{jsonExported ? '✓ JSON Exported' : 'Export JSON'}</span>
                </button>

                <div className="my-1 border-t border-slate-800" />

                {/* 3. Refresh Diagnostic */}
                {summary && onRefreshDiagnostic && (
                  <button
                    type="button"
                    onClick={() => {
                      onRefreshDiagnostic();
                      setExportMenuOpen(false);
                    }}
                    disabled={isAnalyzing}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-800 text-slate-200 disabled:opacity-40 text-left transition-colors"
                  >
                    <svg className={`w-3.5 h-3.5 text-slate-400 ${isAnalyzing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span>Refresh Diagnostic</span>
                  </button>
                )}

                {/* 4. Clean Trace DB */}
                {onCleanTraceDatabase && (
                  <button
                    type="button"
                    onClick={() => {
                      onCleanTraceDatabase();
                      setExportMenuOpen(false);
                    }}
                    disabled={isAnalyzing}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-rose-950/60 hover:text-rose-200 text-slate-300 disabled:opacity-40 text-left transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    <span>Clean Trace DB</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
