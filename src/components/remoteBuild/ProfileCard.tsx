import { useState } from 'react';
import { TbClockPlay } from 'react-icons/tb';
import type {
  ProfilePrerequisites,
  RemoteBuildProfile,
} from '../../types';
import { PipelineStepper } from './PipelineStepper';
import { BuildHistoryPanel } from './BuildHistoryPanel';
import { formatRelativeTime } from '../../utils/formatDuration';

export interface ProfileCardProps {
  profile: RemoteBuildProfile;
  prerequisites?: ProfilePrerequisites;
  onPullNow: (profile: RemoteBuildProfile) => Promise<void>;
  onCloneNow?: (profile: RemoteBuildProfile) => Promise<void>;
  onToggleEnabled: (profile: RemoteBuildProfile) => Promise<void>;
  onEdit: (profile: RemoteBuildProfile) => void;
  onDelete: (profile: RemoteBuildProfile) => Promise<void>;
  onRebuildCommit?: (commit: string) => void;
  isBusy?: boolean;
}

export function ProfileCard({
  profile,
  prerequisites,
  onPullNow,
  onCloneNow,
  onToggleEnabled,
  onEdit,
  onDelete,
  onRebuildCommit,
  isBusy = false,
}: ProfileCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isCloned = profile.cloneStatus === 'ready' && (prerequisites ? prerequisites.isCloned : true);
  const isCloning = profile.cloneStatus === 'cloning';
  const isRunning = profile.lastStatus === 'running' || profile.lastStatus === 'pulling' || profile.lastStatus === 'fetching' || profile.lastStatus === 'checking';
  const latestRun = profile.buildHistory?.[0];
  const lastRunFailed = latestRun?.status === 'failed';

  const getStatusBadge = () => {
    if (isRunning) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30 animate-pulse">
          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          {profile.lastStatus === 'running'
            ? 'Packaging…'
            : profile.lastStatus === 'pulling'
            ? 'Pulling Changes…'
            : profile.lastStatus === 'fetching'
            ? 'Fetching Remote…'
            : 'Checking Remote…'}
        </span>
      );
    }

    if (!isCloned) {
      if (profile.cloneStatus === 'failed') {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30">
            Clone Failed
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
          Not Cloned
        </span>
      );
    }

    if (profile.lastStatus === 'failed') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Failed
        </span>
      );
    }

    if (profile.lastStatus === 'blocked') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Blocked
        </span>
      );
    }

    if (profile.lastStatus === 'success') {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Succeeded
        </span>
      );
    }

    return (
      <div className="inline-flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${
          profile.enabled
            ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
            : 'bg-slate-800 text-slate-400 border-slate-700'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${profile.enabled ? 'bg-emerald-400' : 'bg-slate-500'}`} />
          {profile.enabled ? 'Scheduled' : 'Paused'}
        </span>
        {lastRunFailed && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30"
            title={`Last build attempt failed${latestRun?.errorSummary ? `: ${latestRun.errorSummary}` : ''}`}
          >
            <svg className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Last build failed
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-2xl border border-slate-700/80 bg-slate-900/90 shadow-xl overflow-hidden transition-all">
      {/* Header Bar */}
      <div
        className="flex items-center justify-between p-4 bg-slate-950/40 hover:bg-slate-950/60 cursor-pointer transition-colors border-b border-slate-800/80"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Left Side: Chevron & Profile Info */}
        <div className="flex items-center gap-3.5 min-w-0">
          <button
            type="button"
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 transition-transform"
            aria-label={expanded ? 'Collapse profile details' : 'Expand profile details'}
          >
            <svg
              className={`w-5 h-5 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-sm font-bold text-slate-100 tracking-tight truncate">
                {profile.name}
              </h3>
              {getStatusBadge()}
            </div>

            <div className="flex items-center gap-2 mt-1 text-xs text-slate-400 flex-wrap">
              {profile.repository && (
                <span className="font-mono text-slate-300 truncate max-w-xs">
                  {profile.repository.fullName}
                </span>
              )}
              <span className="text-slate-600">•</span>
              <span className="font-mono text-sky-400 font-medium">
                {profile.buildBranch}
              </span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-400">
                {profile.platform || 'Win64'} / {profile.packageConfig || 'Development'}
              </span>
              {profile.lastBuiltCommit && (
                <>
                  <span className="text-slate-600">•</span>
                  <span className="font-mono text-[11px] text-emerald-400">
                    Built {profile.lastBuiltCommit.slice(0, 7)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Side: Quick Action Toggles */}
        <div
          className="flex items-center gap-2 shrink-0 ml-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Enable / Pause Schedule Switch */}
          <button
            type="button"
            role="switch"
            aria-checked={profile.enabled}
            onClick={() => onToggleEnabled(profile)}
            className={`group relative inline-flex items-center h-8 px-2.5 rounded-full border transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-sky-500/50 ${
              profile.enabled
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-slate-800/90 border-slate-700 text-slate-400 hover:bg-slate-700/80 hover:text-slate-300'
            }`}
            title={profile.enabled ? 'Automatic build schedule is active (click to pause)' : 'Automatic build schedule is paused (click to enable)'}
          >
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <TbClockPlay
                className={`w-3.5 h-3.5 shrink-0 transition-colors ${
                  profile.enabled ? 'text-emerald-400' : 'text-slate-500 group-hover:text-slate-400'
                }`}
              />
              <span className="text-[11px] font-semibold tracking-wide select-none">
                {profile.enabled ? 'Active' : 'Paused'}
              </span>
              <span
                className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  profile.enabled ? 'bg-emerald-500' : 'bg-slate-600'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                    profile.enabled ? 'translate-x-3' : 'translate-x-0'
                  }`}
                />
              </span>
            </div>
          </button>

          {/* Build Now / Clone Now Action */}
          {!isCloned && onCloneNow ? (
            <button
              type="button"
              onClick={() => onCloneNow(profile)}
              disabled={isCloning || isBusy}
              className="px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors flex items-center gap-1.5 shadow-sm shadow-sky-600/30"
            >
              {isCloning ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>Cloning…</span>
                </>
              ) : (
                <span>Clone Repo</span>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onPullNow(profile)}
              disabled={isRunning || isBusy}
              className="px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors flex items-center gap-1.5 shadow-sm shadow-sky-600/30"
              title="Fetch remote, pull updates, and build now"
            >
              {isRunning ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>In Progress</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>Build Now</span>
                </>
              )}
            </button>
          )}

          {/* Edit Profile */}
          <button
            type="button"
            onClick={() => onEdit(profile)}
            className="p-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
            title="Edit profile settings"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Accordion Body */}
      {expanded && (
        <div className="p-5 space-y-5 bg-slate-900/60">
          {/* Error Banner if Last Build Failed / Blocked */}
          {profile.lastError && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5">
              <svg className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div className="flex-1 min-w-0">
                <span className="font-semibold text-rose-200">Last Execution Notice: </span>
                <span className="font-mono">{profile.lastError}</span>
              </div>
            </div>
          )}

          {/* Interactive Pipeline Stepper with Hover Tooltips */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Pipeline Stages & Pre-Flight Checks
              </h4>
              <span className="text-[11px] text-slate-400">
                Hover any stage to inspect diagnostic requirements
              </span>
            </div>
            <PipelineStepper
              profile={profile}
              prerequisites={prerequisites}
            />
          </div>

          {/* Configuration Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            {/* Repository Info */}
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
              <div className="text-[11px] font-semibold text-slate-400">Checkout Location</div>
              <div className="font-mono text-slate-300 truncate" title={profile.repositoryPath}>
                {profile.repositoryPath || '(not configured)'}
              </div>
              <div className="text-[11px] text-slate-400 flex items-center gap-1.5 pt-0.5">
                <span>Branch:</span>
                <span className="font-mono text-sky-400 font-semibold">{profile.buildBranch}</span>
              </div>
            </div>

            {/* Unreal Engine Info */}
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
              <div className="text-[11px] font-semibold text-slate-400">Engine & Project</div>
              <div className="font-mono text-slate-300 truncate" title={profile.projectPath}>
                {profile.projectPath ? profile.projectPath.split(/[/\\]/).pop() : 'Auto-detected uproject'}
              </div>
              <div className="text-[11px] text-slate-400 flex items-center gap-1.5 pt-0.5">
                <span>Platform:</span>
                <span className="font-medium text-slate-300">{profile.platform || 'Win64'} ({profile.packageConfig || 'Development'})</span>
              </div>
            </div>

            {/* Output & Timing */}
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
              <div className="text-[11px] font-semibold text-slate-400">Build Artifacts & Sync</div>
              <div className="text-[11px] text-slate-300 flex items-center justify-between">
                <span>Last Checked:</span>
                <span className="text-slate-400">{formatRelativeTime(profile.lastCheckedAt)}</span>
              </div>
              <div className="text-[11px] text-slate-300 flex items-center justify-between">
                <span>Last Built:</span>
                <span className="text-slate-400">{formatRelativeTime(profile.lastRunAt)}</span>
              </div>
            </div>
          </div>

          {/* Embedded Build Run History */}
          <div className="pt-2 border-t border-slate-800/80">
            <BuildHistoryPanel
              profile={profile}
              onRebuild={onRebuildCommit}
            />
          </div>

          {/* Danger Zone: Delete Profile */}
          <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
            <div className="text-[11px] text-slate-400">
              Profile ID: <span className="font-mono text-slate-400">{profile.id.slice(0, 8)}</span>
            </div>

            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-rose-400">Delete this profile?</span>
                <button
                  type="button"
                  onClick={() => onDelete(profile)}
                  className="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white transition-colors"
                >
                  Yes, Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-2.5 py-1 rounded bg-slate-800 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-rose-400/80 hover:text-rose-300 transition-colors"
              >
                Delete Profile
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
