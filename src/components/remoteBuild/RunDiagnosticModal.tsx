import { useState } from 'react';
import type { RemoteBuildRun } from '../../types';
import { formatDuration, formatRelativeTime } from '../../utils/formatDuration';

export interface RunDiagnosticModalProps {
  run: RemoteBuildRun | null;
  profileName: string;
  onClose: () => void;
  onRebuild?: (commit: string) => void;
}

export function RunDiagnosticModal({
  run,
  profileName,
  onClose,
  onRebuild,
}: RunDiagnosticModalProps) {
  const [copied, setCopied] = useState(false);

  if (!run) return null;

  const copyDiagnostics = async () => {
    const text = [
      `Profile: ${profileName}`,
      `Run ID: ${run.id}`,
      `Commit: ${run.commit}`,
      `Status: ${run.status}`,
      `Trigger: ${run.trigger || 'manual'}`,
      `Started: ${run.startedAt || 'unknown'}`,
      `Completed: ${run.completedAt || 'unknown'}`,
      `Duration: ${formatDuration(run.durationSeconds)}`,
      run.failedStage ? `Failed Stage: ${run.failedStage}` : null,
      run.error ? `Error: ${run.error}` : null,
      run.errorSummary ? `Summary: ${run.errorSummary}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const statusBadge = () => {
    switch (run.status) {
      case 'success':
        return <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Succeeded</span>;
      case 'failed':
        return <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30">Failed</span>;
      case 'blocked':
        return <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30">Blocked</span>;
      case 'running':
        return <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30 animate-pulse">Running</span>;
      default:
        return <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">{run.status}</span>;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-slate-100">Run Diagnostics</h2>
              {statusBadge()}
              {run.count && run.count > 1 && (
                <span className="px-2 py-0.5 rounded text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  {run.count} consecutive failures
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">{profileName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400 font-medium">Commit</div>
              <div className="text-xs font-mono font-bold text-slate-200 mt-0.5 truncate">
                {run.commit ? run.commit.slice(0, 10) : '(unknown)'}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400 font-medium">Duration</div>
              <div className="text-xs font-bold text-slate-200 mt-0.5">
                {formatDuration(run.durationSeconds)}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400 font-medium">Trigger</div>
              <div className="text-xs font-semibold text-slate-200 mt-0.5 capitalize">
                {run.trigger || 'manual'}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400 font-medium">Completed</div>
              <div className="text-xs text-slate-200 mt-0.5 truncate" title={run.completedAt}>
                {formatRelativeTime(run.completedAt || run.startedAt)}
              </div>
            </div>
          </div>

          {/* Failed Stage Indicator */}
          {run.failedStage && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center gap-3">
              <svg className="w-5 h-5 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div>
                <span className="text-xs font-bold text-rose-300">Failure Stage: </span>
                <span className="text-xs font-mono text-rose-200 uppercase">{run.failedStage}</span>
              </div>
            </div>
          )}

          {/* Error Details */}
          {(run.error || run.errorSummary) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">Error Summary</span>
                <button
                  onClick={copyDiagnostics}
                  className="text-xs text-sky-400 hover:text-sky-300 font-medium transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy Error'}
                </button>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs text-rose-300/90 whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto select-text">
                {run.errorSummary || run.error}
              </div>
            </div>
          )}

          {/* Run Log File Reference */}
          {run.logPath && (
            <div className="space-y-1 text-xs">
              <span className="font-semibold text-slate-400">Log Path:</span>
              <div className="p-2 rounded bg-slate-950/70 border border-slate-800 font-mono text-[11px] text-slate-300 select-all truncate">
                {run.logPath}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-950/40">
          <button
            onClick={copyDiagnostics}
            className="px-3.5 py-2 rounded-lg border border-slate-700 bg-slate-800 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors"
          >
            {copied ? 'Copied to Clipboard' : 'Copy Run Summary'}
          </button>

          <div className="flex items-center gap-2">
            {onRebuild && run.commit && (
              <button
                onClick={() => {
                  onRebuild(run.commit);
                  onClose();
                }}
                className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white transition-colors"
              >
                Rebuild Commit
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
