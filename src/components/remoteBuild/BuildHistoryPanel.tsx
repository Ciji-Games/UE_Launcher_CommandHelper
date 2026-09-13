import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RemoteBuildProfile, RemoteBuildRun } from '../../types';
import { formatDuration, formatRelativeTime } from '../../utils/formatDuration';
import { RunDiagnosticModal } from './RunDiagnosticModal';

export interface BuildHistoryPanelProps {
  profile: RemoteBuildProfile;
  onRebuild?: (commit: string) => void;
  className?: string;
}

export function BuildHistoryPanel({
  profile,
  onRebuild,
  className = '',
}: BuildHistoryPanelProps) {
  const [selectedRun, setSelectedRun] = useState<RemoteBuildRun | null>(null);
  const [expanded, setExpanded] = useState(false);

  const runs = profile.buildHistory || [];
  const displayRuns = expanded ? runs : runs.slice(0, 5);

  const openOutput = async (run: RemoteBuildRun) => {
    if (run.status !== 'success' || !run.outputPath) return;
    try {
      await invoke('open_folder_in_explorer', { path: run.outputPath });
    } catch (error) {
      console.error('Failed to open packaged build output:', error);
    }
  };

  const getStatusBadge = (run: RemoteBuildRun) => {
    switch (run.status) {
      case 'success':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Success
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/30">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Failed
          </span>
        );
      case 'running':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 animate-pulse">
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Running
          </span>
        );
      case 'blocked':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/30">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Blocked
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-400 border border-slate-700">
            {run.status}
          </span>
        );
    }
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Build Run History
          </h4>
          <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
            {runs.length}
          </span>
        </div>

        {runs.length > 5 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-sky-400 hover:text-sky-300 font-medium transition-colors"
          >
            {expanded ? 'Show Recent (5)' : `Show All (${runs.length})`}
          </button>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="p-4 rounded-xl border border-dashed border-slate-800 bg-slate-950/40 text-center">
          <p className="text-xs text-slate-400">No execution history recorded yet for this profile.</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {displayRuns.map((run) => (
            <div
              key={run.id}
              className="flex items-center justify-between p-2.5 rounded-xl border border-slate-800/80 bg-slate-950/60 hover:bg-slate-900/80 hover:border-slate-700/80 transition-all text-xs"
            >
              {/* Left Column: Status & Commit */}
              <div className="flex items-center gap-3 min-w-0">
                {getStatusBadge(run)}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-bold text-slate-200">
                      {run.commit ? run.commit.slice(0, 8) : '(unknown)'}
                    </span>
                    <span className="text-[10px] uppercase font-semibold px-1.5 py-0.2 rounded bg-slate-800/80 text-slate-300 border border-slate-700/50">
                      {run.trigger || 'manual'}
                    </span>
                    {run.count && run.count > 1 && (
                      <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30" title={`Repeated ${run.count} times`}>
                        ×{run.count}
                      </span>
                    )}
                  </div>
                  {run.errorSummary && (
                    <p className="text-[11px] text-rose-300 truncate max-w-xs sm:max-w-md mt-0.5">
                      {run.errorSummary}
                    </p>
                  )}
                </div>
              </div>

              {/* Right Column: Duration, Time, & Actions */}
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right hidden sm:block">
                  <div className="text-slate-300 font-mono text-[11px]">
                    {formatDuration(run.durationSeconds)}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {formatRelativeTime(run.completedAt || run.startedAt)}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setSelectedRun(run)}
                    className="px-2 py-1 rounded bg-slate-800/90 hover:bg-slate-700 text-[11px] font-medium text-slate-200 border border-slate-700/60 transition-colors"
                  >
                    Inspect
                  </button>
                  {run.status === 'success' && run.outputPath && (
                    <button
                      onClick={() => void openOutput(run)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-[11px] font-semibold text-emerald-300 border border-emerald-500/30 transition-colors"
                      title="Open the packaged build folder in Explorer"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H10l2 2h7.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" />
                        <path d="M8 12h8m-3-3 3 3-3 3" />
                      </svg>
                      Open output
                    </button>
                  )}
                  {onRebuild && run.commit && (
                    <button
                      onClick={() => onRebuild(run.commit)}
                      className="px-2 py-1 rounded bg-sky-600/80 hover:bg-sky-600 text-[11px] font-semibold text-white transition-colors"
                      title="Rebuild this commit"
                    >
                      Rebuild
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Diagnostics Inspection Modal */}
      {selectedRun && (
        <RunDiagnosticModal
          run={selectedRun}
          profileName={profile.name}
          onClose={() => setSelectedRun(null)}
          onRebuild={onRebuild}
        />
      )}
    </div>
  );
}
