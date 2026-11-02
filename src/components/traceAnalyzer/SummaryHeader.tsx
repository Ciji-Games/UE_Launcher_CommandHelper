import { useState } from 'react';
import type { Finding, TraceCandidate, TraceSummary } from '../../types/traceAnalyzer';

export interface SummaryHeaderProps {
  summary: TraceSummary | null;
  findings: Finding[];
  targetFps: number;
  onTargetFpsChange: (fps: number) => void;
  onOpenInInsights: () => void;
  onPickFile: () => void;
  onPickExe: () => void;
  candidates: TraceCandidate[];
  onOpenTrace: (path: string) => void;
  availableEngines: { root: string; version: string }[];
  selectedEngineRoot: string;
  onEngineChange: (engineRoot: string) => void;
  insightsExists: boolean;
  isAnalyzing: boolean;
  selectedRange?: [number, number] | null;
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
  targetFps,
  onTargetFpsChange,
  onOpenInInsights,
  onPickFile,
  onPickExe,
  candidates,
  onOpenTrace,
  availableEngines,
  selectedEngineRoot,
  onEngineChange,
  insightsExists,
  isAnalyzing,
  selectedRange,
}: SummaryHeaderProps) {
  const [copied, setCopied] = useState(false);

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

    md += `### Scoped Findings (${findings.length})\n\n`;
    if (findings.length === 0) {
      md += `*No abnormal bottlenecks detected against frame budget.*\n`;
    } else {
      findings.forEach((f, idx) => {
        const p = f.parsedPayload;
        md += `#### ${idx + 1}. ${p?.title || f.ruleId}\n`;
        md += `- **Confidence**: ${p?.matchConfidence || 'N/A'}\n`;
        md += `- **Fix Likelihood**: ${p?.fixLikelihood || f.fixLikelihood}\n`;
        md += `- **Time Impact**: ${(p?.explainsMs ?? 0).toFixed(1)} ms explained (of ${(p?.ofExcessMs ?? 0).toFixed(1)} ms excess)\n\n`;

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

  return (
    <div className="flex flex-col gap-2.5 w-full bg-slate-900/90 border border-slate-800 rounded-xl p-3 shadow-md">
      {/* Top Row: Navigation Controls & Engine Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {/* Logo / Title */}
          <div className="flex items-center gap-2 mr-1">
            <span className="text-sm font-bold bg-gradient-to-r from-sky-400 via-indigo-300 to-purple-400 bg-clip-text text-transparent">
              Trace Analyzer
            </span>
          </div>

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

        {/* Right Controls: Engine Selector, Insights Dot, Target FPS, Copy Report, Open in Insights */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Engine Selector */}
          <div className="flex items-center gap-1">
            <select
              value={selectedEngineRoot}
              onChange={(e) => onEngineChange(e.target.value)}
              disabled={isAnalyzing}
              className="bg-slate-800 border border-slate-700 text-slate-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-sky-500 focus:outline-none max-w-[150px] truncate"
              title="Select Unreal Engine Installation"
            >
              {availableEngines.map((e: { root: string; version: string }) => (
                <option key={e.root} value={e.root}>
                  UE {e.version}
                </option>
              ))}
            </select>
          </div>

          {/* Insights Status Dot */}
          <div
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700"
            title={insightsExists ? 'Unreal Insights is available' : 'Unreal Insights executable not found'}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                insightsExists ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-rose-400'
              }`}
            />
            <span className="text-[11px] text-slate-400">Insights</span>
          </div>

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

          {/* Copy Report Button */}
          <button
            type="button"
            onClick={handleCopyReport}
            disabled={!summary}
            className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-700 transition-colors disabled:opacity-50"
          >
            {copied ? (
              <span className="text-emerald-400 font-medium">✓ Copied</span>
            ) : (
              <>
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                <span>Copy Report</span>
              </>
            )}
          </button>

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
        </div>
      </div>

      {/* Bottom Row: 4 Metric Pills only (Duration, Median FPS with ms, p95 ms, Hitches) */}
      {summary && (
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/60 text-xs">
          {/* 1. Duration */}
          <div className="flex items-center gap-1.5 bg-slate-950/60 text-slate-200 px-2.5 py-1 rounded-md border border-slate-800">
            <span className="text-slate-400">Duration:</span>
            <span className="font-semibold text-slate-100 font-mono">
              {formatDuration(summary.durationS)}
            </span>
          </div>

          {/* 2. Median FPS */}
          <div className="flex items-center gap-1.5 bg-slate-950/60 text-slate-200 px-2.5 py-1 rounded-md border border-slate-800">
            <span className="text-slate-400">Median:</span>
            <span className="font-semibold text-emerald-400 font-mono">
              {medianFps} fps
            </span>
            <span className="text-slate-400 font-mono text-[11px]">
              ({(summary.medianMs ?? 0).toFixed(1)} ms)
            </span>
          </div>

          {/* 3. p95 ms */}
          <div className="flex items-center gap-1.5 bg-slate-950/60 text-slate-200 px-2.5 py-1 rounded-md border border-slate-800">
            <span className="text-slate-400">p95:</span>
            <span className="font-semibold text-amber-300 font-mono">
              {(summary.p95Ms ?? 0).toFixed(1)} ms
            </span>
          </div>

          {/* 4. Hitch count */}
          <div className="flex items-center gap-1.5 bg-slate-950/60 text-slate-200 px-2.5 py-1 rounded-md border border-slate-800">
            <span className="text-slate-400">Hitches:</span>
            <span
              className={`font-semibold font-mono ${
                (summary.hitchCount ?? 0) > 0 ? 'text-rose-400 font-bold' : 'text-slate-300'
              }`}
            >
              {summary.hitchCount ?? 0}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
