import { useState } from 'react';
import type { Finding, IssueWithOccurrences, RangeStatisticsResponse, TraceCandidate, TraceSummary } from '../../types/traceAnalyzer';

export interface SummaryHeaderProps {
  summary: TraceSummary | null;
  findings: Finding[];
  issues?: IssueWithOccurrences[];
  rangeStats?: RangeStatisticsResponse | null;
  targetFps: number;
  onTargetFpsChange: (fps: number) => void;
  onOpenInInsights: () => void;
  onPickFile: () => void;
  onPickExe: () => void;
  candidates: TraceCandidate[];
  onOpenTrace: (path: string) => void;
  insightsExists: boolean;
  isAnalyzing: boolean;
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
  targetFps,
  onTargetFpsChange,
  onOpenInInsights,
  onPickFile,
  onPickExe,
  candidates,
  onOpenTrace,
  insightsExists,
  isAnalyzing,
  onRefreshDiagnostic,
  onCleanTraceDatabase,
}: SummaryHeaderProps) {
  const [copied, setCopied] = useState(false);

  const medianFps =
    summary && (summary.medianMs ?? 0) > 0 ? Math.round(1000 / summary.medianMs) : 0;

  const handleCopyReport = () => {
    if (!summary) return;

    let md = `# Unreal Engine Trace Diagnosis Report (Full Trace: 0.00s – ${summary.durationS.toFixed(2)}s)\n\n`;

    md += `**Trace File**: \`${summary.path || 'Unknown'}\`\n`;
    md += `**Engine Version**: ${summary.engineVersion || 'Unknown'}\n`;
    md += `**Duration**: ${formatDuration(summary.durationS)} (${(summary.frameCount ?? 0).toLocaleString()} frames)\n`;

    const timeWeightedFps = summary.timeWeightedFps
      ? Math.round(summary.timeWeightedFps)
      : summary.durationS > 0
      ? Math.round(summary.frameCount / summary.durationS)
      : medianFps;

    md += `**Performance**: Median ${medianFps} FPS (${(summary.medianMs ?? 0).toFixed(1)} ms) | Time-weighted: ${timeWeightedFps} FPS | p95: ${(summary.p95Ms ?? 0).toFixed(1)} ms | p99: ${(summary.p99Ms ?? 0).toFixed(1)} ms\n`;
    if (summary.timeOverBudgetPct != null || summary.framesOverBudgetPct != null) {
      md += `**Budget Adherence**: ${(summary.timeOverBudgetPct ?? 0).toFixed(1)}% of time / ${(summary.framesOverBudgetPct ?? 0).toFixed(1)}% of frames over target (${summary.targetMs ? (1000 / summary.targetMs).toFixed(0) : targetFps} FPS target)\n`;
    }
    md += `**Issues**: ${summary.hitchCount ?? 0} hitch(es)\n\n`;

    if (summary.regimeSummary) {
      md += `**Regime Summary**: ${summary.regimeSummary}\n\n`;
    }

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

    // Export one entry per issue with every occurrence
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
        if (p?.actualTimeLostMs != null && p.actualTimeLostMs > 0) {
          md += `- **Actual Time Lost**: ${p.actualTimeLostMs.toFixed(1)} ms\n`;
        }
        if (isSustained) {
          md += `- **Time Impact**: ${(p?.explainsMs ?? 0).toFixed(1)} ms/frame explained (of ${(p?.ofExcessMs ?? 0).toFixed(1)} ms/frame excess gap)\n`;
        } else {
          md += `- **Time Impact**: ${(p?.explainsMs ?? 0).toFixed(1)} ms explained (of ${(p?.ofExcessMs ?? 0).toFixed(1)} ms peak excess)\n`;
        }

        if (p?.contributors && p.contributors.length > 0) {
          md += `- **Contributors**:\n`;
          p.contributors.forEach((c) => {
            md += `  - ${c.title || c.ruleId} (${c.threadRole}): +${c.explainsMs.toFixed(1)} ms (${c.sharePct.toFixed(0)}% share)\n`;
          });
        }
        md += `\n`;

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

  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const fileName = summary?.path ? summary.path.split(/[/\\]/).pop() : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 w-full bg-slate-900/90 border border-slate-800 rounded-xl p-2.5 shadow-md">
      {/* Left: File Name & Trace Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {fileName ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800/90 border border-slate-700/80 text-xs max-w-[280px] truncate" title={summary?.path || fileName}>
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

      {/* Right Controls: Target FPS (only if trace loaded), Open in Insights, Copy Report / Options */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {/* Target FPS Selector (only shown once a trace is loaded) */}
        {summary && (
          <div className="flex items-center gap-1.5 text-slate-400">
            <span className="text-[11px] font-medium text-slate-400">Target:</span>
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
        )}

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

        {/* Copy Report Button */}
        {summary && (
          <button
            type="button"
            onClick={handleCopyReport}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-700 transition-colors shadow-sm"
          >
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
            <span>{copied ? '✓ Copied' : 'Copy Report'}</span>
          </button>
        )}

        {/* More Actions Dropdown Menu (Refresh Diagnostic / Clean DB) */}
        {summary && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportMenuOpen(!exportMenuOpen)}
              className="flex items-center gap-1 px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 transition-colors shadow-sm"
              title="More actions"
            >
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
            </button>

            {exportMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setExportMenuOpen(false)}
                />
                <div className="absolute right-0 mt-1 w-44 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-40 py-1 text-xs flex flex-col">
                  {onRefreshDiagnostic && (
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
        )}
      </div>
    </div>
  );
}
