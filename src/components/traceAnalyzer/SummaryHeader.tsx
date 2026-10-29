import { useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { Finding, TraceSummary } from '../../types/traceAnalyzer';

interface SummaryHeaderProps {
  summary: TraceSummary | null;
  findings: Finding[];
  targetFps: number;
  onTargetFpsChange: (fps: number) => void;
  onOpenInInsights: () => void;
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
}: SummaryHeaderProps) {
  const [copied, setCopied] = useState(false);

  if (!summary) return null;

  const medianFps = (summary.medianMs ?? 0) > 0 ? Math.round(1000 / summary.medianMs) : 0;

  const handleOpenInExplorer = async () => {
    if (!summary.path) return;
    try {
      await revealItemInDir(summary.path);
    } catch (err) {
      console.error('Failed to open trace in explorer:', err);
    }
  };

  const handleCopyReport = () => {
    let md = `# Unreal Engine Trace Diagnosis Report\n\n`;
    md += `**Trace File**: \`${summary.path || 'Unknown'}\`\n`;
    md += `**Engine Version**: ${summary.engineVersion || 'Unknown'}\n`;
    md += `**Duration**: ${formatDuration(summary.durationS)} (${(summary.frameCount ?? 0).toLocaleString()} frames)\n`;
    md += `**Performance**: Median ${medianFps} FPS (${(summary.medianMs ?? 0).toFixed(1)} ms) | p95: ${(summary.p95Ms ?? 0).toFixed(1)} ms | p99: ${(summary.p99Ms ?? 0).toFixed(1)} ms\n`;
    md += `**Issues Detected**: ${summary.hitchCount ?? 0} hitch(es), ${summary.slowRegionCount ?? 0} slow region(s)\n`;
    if (summary.detectedChannels && summary.detectedChannels.length > 0) {
      md += `**Detected Channels**: ${summary.detectedChannels.map((c) => `✓ ${c}`).join(', ')}`;
      if (summary.missingChannels && summary.missingChannels.length > 0) {
        md += ` *(Missing: ${summary.missingChannels.join(', ')})*`;
      }
      md += `\n`;
    }
    md += `\n### Verdict\n${summary.verdict || 'No verdict generated.'}\n\n`;

    if (summary.isEditorBuild) {
      md += `> **Note**: Captured in Unreal Editor session. Editor and Slate overhead are included.\n\n`;
    }

    md += `### Diagnostic Findings\n\n`;
    if (findings.length === 0) {
      md += `*No abnormal bottlenecks detected against frame budget.*\n`;
    } else {
      findings.forEach((f, idx) => {
        const p = f.parsedPayload;
        md += `#### ${idx + 1}. ${p?.title || f.ruleId}\n`;
        md += `- **Match Confidence**: ${p?.matchConfidence || 'N/A'} (${Math.round((p?.matchScore || 0) * 100)}%)\n`;
        md += `- **Fix Likelihood**: ${p?.fixLikelihood || f.fixLikelihood}\n`;
        md += `- **Excess Time Explained**: ${(p?.explainsMs ?? 0).toFixed(1)} ms of +${(p?.ofExcessMs ?? 0).toFixed(1)} ms\n\n`;

        if (p?.evidence && p.evidence.length > 0) {
          md += `**Evidence Observed**:\n`;
          p.evidence.forEach((ev) => {
            md += `- ${ev.label}\n`;
          });
          md += `\n`;
        }

        if (p?.fixes && p.fixes.length > 0) {
          md += `**Recommended Fixes**:\n`;
          p.fixes.forEach((fix, fixIdx) => {
            md += `${fixIdx + 1}. [Effort: ${fix.effort}] ${fix.text}\n`;
            if (fix.cvarsOrApis && fix.cvarsOrApis.length > 0) {
              md += `   - Associated cvars/APIs: \`${fix.cvarsOrApis.join('`, `')}\`\n`;
            }
          });
          md += `\n`;
        }

        if (p?.verify) {
          md += `**Verification Method**:\n- ${p.verify}\n\n`;
        }

        if (p?.channelSuggestion) {
          md += `> 💡 **${p.channelSuggestion.badge}**: ${p.channelSuggestion.description}\n`;
          md += `> **Recommended Flags**: \`${p.channelSuggestion.channelFlags}\`\n\n`;
        }
      });
    }

    navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex flex-col gap-3 w-full bg-slate-800/40 border border-slate-700/60 rounded-lg p-4">
      {/* Top Row: Metrics & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Metric Pills */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="bg-slate-700/60 text-slate-200 px-2.5 py-1 rounded border border-slate-600/50">
            <span className="text-slate-400">Frames:</span>{' '}
            <span className="font-semibold text-sky-300">{(summary.frameCount ?? 0).toLocaleString()}</span>
          </div>

          <div className="bg-slate-700/60 text-slate-200 px-2.5 py-1 rounded border border-slate-600/50">
            <span className="text-slate-400">Duration:</span>{' '}
            <span className="font-semibold text-slate-200">{formatDuration(summary.durationS)}</span>
          </div>

          <div className="bg-slate-700/60 text-slate-200 px-2.5 py-1 rounded border border-slate-600/50">
            <span className="text-slate-400">Median:</span>{' '}
            <span className="font-semibold text-emerald-400">{medianFps} fps</span>{' '}
            <span className="text-slate-400">({(summary.medianMs ?? 0).toFixed(1)} ms)</span>
          </div>

          <div className="bg-slate-700/60 text-slate-200 px-2.5 py-1 rounded border border-slate-600/50">
            <span className="text-slate-400">p95 / p99:</span>{' '}
            <span className="text-amber-300 font-mono">{(summary.p95Ms ?? 0).toFixed(1)} ms</span> /{' '}
            <span className="text-rose-300 font-mono">{(summary.p99Ms ?? 0).toFixed(1)} ms</span>
          </div>

          <div className="bg-slate-700/60 text-slate-200 px-2.5 py-1 rounded border border-slate-600/50">
            <span className="text-slate-400">Hitches:</span>{' '}
            <span className={`font-semibold ${(summary.hitchCount ?? 0) > 0 ? 'text-rose-400' : 'text-slate-300'}`}>
              {summary.hitchCount ?? 0}
            </span>
          </div>

          <div className="bg-slate-700/60 text-slate-200 px-2.5 py-1 rounded border border-slate-600/50">
            <span className="text-slate-400">Slow Regions:</span>{' '}
            <span className={`font-semibold ${(summary.slowRegionCount ?? 0) > 0 ? 'text-amber-400' : 'text-slate-300'}`}>
              {summary.slowRegionCount ?? 0}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* Target FPS Selector */}
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>Target:</span>
            <select
              value={targetFps}
              onChange={(e) => onTargetFpsChange(Number(e.target.value))}
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-200 text-xs focus:ring-1 focus:ring-sky-500 focus:outline-none"
            >
              <option value={30}>30 fps (33.3 ms)</option>
              <option value={60}>60 fps (16.7 ms)</option>
              <option value={120}>120 fps (8.3 ms)</option>
            </select>
          </div>

          {/* Open in Explorer */}
          <button
            type="button"
            onClick={handleOpenInExplorer}
            disabled={!summary.path}
            className="flex items-center gap-1.5 px-3 py-1 bg-slate-700/80 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs rounded border border-slate-600/70 transition-colors"
            title={summary.path ? `Open folder containing ${summary.path}` : 'No trace path available'}
          >
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span>Open in Explorer</span>
          </button>

          {/* Copy Report */}
          <button
            type="button"
            onClick={handleCopyReport}
            className="flex items-center gap-1.5 px-3 py-1 bg-slate-700/80 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-600/70 transition-colors"
          >
            {copied ? (
              <span className="text-emerald-400 font-medium">✓ Report Copied!</span>
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
            className="flex items-center gap-1.5 px-3 py-1 bg-sky-600/70 hover:bg-sky-600 text-sky-100 text-xs rounded border border-sky-500/60 font-medium transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-sky-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            <span>Open in Insights</span>
          </button>
        </div>
      </div>

      {/* Editor Capture Warning Banner */}
      {summary.isEditorBuild && (
        <div className="flex items-center gap-2 bg-amber-950/30 border border-amber-600/40 text-amber-200 px-3 py-1.5 rounded text-xs">
          <span className="text-amber-400 font-bold">ℹ</span>
          <span>
            <strong>Editor Capture Detected</strong>: UI costs (Slate viewport, window updates) are present in this trace. For final performance decisions, capture a packaged Development or Test build.
          </span>
        </div>
      )}

      {/* Diagnostic Verdict */}
      <div className="flex items-center gap-2.5 bg-slate-900/60 border border-slate-700/60 rounded px-3 py-2 text-xs text-slate-200">
        <span className="font-semibold text-sky-400 uppercase tracking-wide text-[10px]">Diagnosis:</span>
        <span className="leading-relaxed">{summary.verdict}</span>
      </div>

      {/* Trace Channels Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-700/50 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider">
            Trace Channels:
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {['cpu', 'gpu', 'frame', 'loadtime', 'memory', 'counters', 'bookmark', 'log'].map((channel) => {
              const isDetected = summary.detectedChannels?.includes(channel);
              return (
                <span
                  key={channel}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border font-mono transition-colors ${
                    isDetected
                      ? 'bg-emerald-950/40 text-emerald-300 border-emerald-600/40 font-medium'
                      : 'bg-slate-900/40 text-slate-500 border-slate-700/40 opacity-60'
                  }`}
                  title={
                    isDetected
                      ? `Channel '${channel}' is active in this trace capture.`
                      : `Channel '${channel}' was not detected in this trace. Capture with -trace=${channel} for additional diagnostic depth.`
                  }
                >
                  <span className={isDetected ? 'text-emerald-400 font-bold' : 'text-slate-500'}>
                    {isDetected ? '✓' : '✗'}
                  </span>
                  <span>{channel}</span>
                </span>
              );
            })}
          </div>
        </div>

        {summary.missingChannels && summary.missingChannels.length > 0 && (
          <span className="text-[11px] text-slate-400">
            For deeper diagnosis, capture with: <code className="text-amber-300 bg-slate-900 px-1 py-0.5 rounded border border-slate-700 font-mono">-trace=cpu,gpu,frame,loadtime,counters,bookmark -cpuprofilertrace</code>
          </span>
        )}
      </div>
    </div>
  );
}
