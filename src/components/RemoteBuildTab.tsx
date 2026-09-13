import { useEffect, useState } from 'react';
import {
  REMOTE_BUILD_INTERVALS,
  remoteBuildCheckoutPath,
  useRemoteBuildProfiles,
} from '../hooks/useRemoteBuildProfiles';
import { useRemoteBuild } from '../hooks/useRemoteBuild';
import { useGitHub } from '../hooks/useGitHub';
import { useProgress } from '../contexts/ProgressContext';
import { OutputLogPanel } from './OutputLogPanel';
import { ProfileCard } from './remoteBuild/ProfileCard';
import { ProfileEditorModal } from './remoteBuild/ProfileEditorModal';
import { invoke } from '@tauri-apps/api/core';
import { TbClockPlay } from 'react-icons/tb';
import type { CheckoutStatus, RemoteBuildProfile } from '../types';

function formatCountdown(nextCheckAt: string | undefined, now: number) {
  if (!nextCheckAt) return null;
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(nextCheckAt) - now) / 1000));
  if (remainingSeconds === 0) return 'Checking now…';
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `Next check in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function RemoteBuildTab() {
  const { profiles, addProfile, updateProfile, removeProfile } = useRemoteBuildProfiles();
  const {
    pullNow,
    checkProfile,
    scheduleNextAt,
    scheduleRunning,
    scheduleIntervalMinutes,
    keepBuildsEnabled,
    keepBuildsCount,
    archiveOnly,
    applyScheduleSettings,
    prerequisites,
  } = useRemoteBuild();

  const {
    account,
    loading: githubLoading,
    message: githubMessage,
    authorization,
    showInstallGuide,
    setShowInstallGuide,
    openAppInstall,
    connect: connectGitHub,
    openVerification,
    cancelAuthorization,
    disconnect: disconnectGitHub,
  } = useGitHub();

  const { running } = useProgress();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<RemoteBuildProfile | null>(null);
  const [scheduleSettingsOpen, setScheduleSettingsOpen] = useState(false);
  const [showOutputLog, setShowOutputLog] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [codeCopied, setCodeCopied] = useState(false);

  // Settings drafts
  const [draftInterval, setDraftInterval] = useState(scheduleIntervalMinutes);
  const [draftKeepEnabled, setDraftKeepEnabled] = useState(keepBuildsEnabled);
  const [draftKeepCount, setDraftKeepCount] = useState(String(keepBuildsCount));
  const [draftArchiveOnly, setDraftArchiveOnly] = useState(archiveOnly);

  // Live timer tick
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Show output log automatically when a build starts running
  useEffect(() => {
    if (running) setShowOutputLog(true);
  }, [running]);

  const openScheduleSettings = () => {
    setDraftInterval(scheduleIntervalMinutes);
    setDraftKeepEnabled(keepBuildsEnabled);
    setDraftKeepCount(String(keepBuildsCount));
    setDraftArchiveOnly(archiveOnly);
    setScheduleSettingsOpen(true);
  };

  const applySettings = async () => {
    await applyScheduleSettings({
      intervalMinutes: draftInterval,
      keepBuildsEnabled: draftKeepEnabled,
      keepBuildsCount: Number(draftKeepCount) || 3,
      archiveOnly: draftArchiveOnly,
    });
    setScheduleSettingsOpen(false);
  };

  const copyAuthorizationCode = async () => {
    if (!authorization) return;
    try {
      await navigator.clipboard.writeText(authorization.userCode);
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      setCodeCopied(false);
    }
  };

  const handleCreateNew = () => {
    setEditingProfile(null);
    setEditorOpen(true);
  };

  const handleEditProfile = (profile: RemoteBuildProfile) => {
    setEditingProfile(profile);
    setEditorOpen(true);
  };

  const handleSaveProfile = async (profileData: RemoteBuildProfile) => {
    if (editingProfile) {
      await updateProfile(editingProfile.id, profileData);
    } else {
      await addProfile(profileData);
    }
  };

  const handleDeleteProfile = async (profile: RemoteBuildProfile) => {
    await removeProfile(profile.id);
  };

  const handleToggleEnabled = async (profile: RemoteBuildProfile) => {
    const isProfileCloned = profile.cloneStatus === 'ready' && (prerequisites[profile.id] ? prerequisites[profile.id].isCloned : true);
    if (!profile.enabled && !isProfileCloned) return;
    await updateProfile(profile.id, {
      enabled: !profile.enabled,
      lastStatus: 'idle',
      nextCheckAt: undefined,
    });
  };

  const handleCloneNow = async (profile: RemoteBuildProfile) => {
    if (!profile.repository || !profile.repositoryPath || !profile.buildBranch) return;
    setBusyId(profile.id);
    await updateProfile(profile.id, {
      cloneStatus: 'cloning',
      cloneProgress: 0,
      setupStatus: 'untested',
      lastError: undefined,
      progressStages: {
        ...profile.progressStages,
        clone: 'running',
        repo: 'pending',
        package: 'disabled',
        zip: 'disabled',
        cleanup: 'pending',
      },
    });

    try {
      const checkoutPath = remoteBuildCheckoutPath(profile.repositoryPath);
      const result = await invoke<{ ok: boolean; error?: string }>('clone_github_repository', {
        cloneUrl: profile.repository.cloneUrl,
        destination: checkoutPath,
        buildBranch: profile.buildBranch,
      });

      if (!result.ok) throw new Error(result.error ?? 'Clone failed.');

      let projectPath = profile.projectPath;
      try {
        const status = await invoke<CheckoutStatus>('inspect_remote_build_checkout', {
          repositoryPath: checkoutPath,
          remoteName: profile.remoteName || 'origin',
          buildBranch: profile.buildBranch,
        });
        if (status.projects.length > 0 && !projectPath) {
          projectPath = status.projects[0].projectPath;
        }
      } catch {
        // inspection will also occur on check
      }

      const updatedProfile = {
        ...profile,
        cloneStatus: 'ready' as const,
        cloneProgress: undefined,
        setupStatus: 'passed' as const,
        projectPath,
        lastError: undefined,
        progressStages: {
          ...profile.progressStages,
          clone: 'success' as const,
          repo: 'pending' as const,
          package: 'disabled' as const,
          zip: 'disabled' as const,
          cleanup: 'pending' as const,
        },
      };

      await updateProfile(profile.id, {
        cloneStatus: 'ready',
        cloneProgress: undefined,
        setupStatus: 'passed',
        projectPath,
        lastError: undefined,
        progressStages: {
          ...profile.progressStages,
          clone: 'success',
          repo: 'pending',
          package: 'disabled',
          zip: 'disabled',
          cleanup: 'pending',
        },
      });

      // Automatically run pre-flight check and build pipeline if no build exists for the current commit
      void checkProfile(updatedProfile, true, true);
    } catch (error) {
      await updateProfile(profile.id, {
        cloneStatus: 'failed',
        cloneProgress: undefined,
        setupStatus: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        progressStages: {
          ...profile.progressStages,
          clone: 'failed',
        },
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleRebuildCommit = (commit: string) => {
    const target = profiles.find((p) => p.buildHistory?.some((r) => r.commit === commit));
    if (target) {
      void pullNow(target);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 pr-1">
      <div className={`flex min-h-0 flex-col gap-5 overflow-y-auto pr-1 ${showOutputLog ? 'flex-[4_1_0]' : 'flex-1'}`}>
        {/* Top Header Card */}
        <div className="rounded-2xl border border-slate-700/80 bg-slate-900/95 p-5 shadow-xl">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0 shadow-sm shadow-sky-500/10">
                  <TbClockPlay className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-xl font-bold tracking-tight text-slate-100">
                      Automatic Build
                    </h1>
                    <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/30">
                      Pipeline Engine
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Continuous repository synchronization, Unreal Engine packaging, compression, and artifact retention
                  </p>
                </div>
              </div>
            </div>

            {/* Header Right Actions */}
            <div className="flex flex-wrap items-center gap-2.5">
              {/* GitHub Auth Status Badge with Pulsing Dot */}
              {account ? (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-xs shadow-sm shadow-emerald-500/5">
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <span className="font-semibold text-emerald-300">@{account.login}</span>
                  <button
                    type="button"
                    onClick={() => void openAppInstall()}
                    className="p-1 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 transition-colors cursor-pointer"
                    title="Configure GitHub App access & permissions"
                    aria-label="Configure GitHub App access"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => void disconnectGitHub()}
                    className="px-2 py-0.5 rounded-lg border border-slate-700/80 bg-slate-800/80 hover:bg-slate-700 text-[11px] font-medium text-slate-300 hover:text-rose-300 transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 text-xs shadow-sm shadow-rose-500/5">
                  <span className="flex h-2 w-2 relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
                  </span>
                  <span className="font-semibold text-rose-300">GitHub Disconnected</span>
                  <button
                    type="button"
                    disabled={githubLoading || authorization?.status === 'ready' || authorization?.status === 'waiting'}
                    onClick={() => void connectGitHub()}
                    className="ml-1 px-2.5 py-0.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-[11px] font-semibold text-white transition-colors"
                  >
                    {githubLoading ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={openScheduleSettings}
                className="px-3.5 py-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span>Schedule Settings</span>
              </button>

              <button
                type="button"
                disabled={!account || githubLoading}
                onClick={handleCreateNew}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-xs font-semibold text-white transition-all shadow-md shadow-sky-600/30 flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>New Profile</span>
              </button>
            </div>
          </div>

          {/* Schedule Countdown Status Bar */}
          <div className="mt-4 pt-3.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 relative">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  !account
                    ? 'bg-rose-400'
                    : scheduleRunning
                    ? 'bg-sky-400'
                    : scheduleNextAt
                    ? 'bg-emerald-400'
                    : 'bg-slate-400'
                }`} />
                <span className={`relative inline-flex rounded-full h-2 w-2 ${
                  !account
                    ? 'bg-rose-500'
                    : scheduleRunning
                    ? 'bg-sky-500'
                    : scheduleNextAt
                    ? 'bg-emerald-500'
                    : 'bg-slate-500'
                }`} />
              </span>
              <span className="font-mono text-slate-300 font-medium">
                {!account
                  ? 'Schedule paused: GitHub disconnected'
                  : scheduleRunning
                  ? 'Running scheduled check cycle…'
                  : formatCountdown(scheduleNextAt, now) ?? 'Schedule waiting for enabled profiles'}
              </span>
            </div>

            <div className="text-slate-400 font-mono text-[11px] flex items-center gap-3">
              <span>Interval: {scheduleIntervalMinutes}m</span>
              <span>•</span>
              <span>Retention: {keepBuildsEnabled ? `${keepBuildsCount} builds` : 'Keep all'}</span>
              <span>•</span>
              <span>Archive: {archiveOnly ? 'Zip Only' : 'Unpacked + Zip'}</span>
            </div>
          </div>
        </div>

        {/* Post-Connection / Missing Repos Installation Guidance Banner */}
        {account && showInstallGuide && (
          <div className="rounded-2xl border border-sky-500/40 bg-sky-950/40 p-4 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-slate-300 animate-in fade-in duration-200">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-base">📦</span>
                <span className="font-semibold text-slate-100">Step 2: Install GitHub App on Your Accounts</span>
              </div>
              <p className="text-slate-400 text-[11px] leading-relaxed">
                GitHub Apps only show repositories from accounts or organizations where they are explicitly installed. Please install the <strong className="text-sky-300">UE Launcher Login</strong> GitHub App on your personal account or organizations.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void openAppInstall()}
                className="px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs transition-colors flex items-center gap-1.5 shadow-md shadow-sky-600/20 cursor-pointer"
              >
                <span>Install GitHub App ↗</span>
              </button>
              <button
                type="button"
                onClick={() => setShowInstallGuide(false)}
                className="px-2.5 py-1.5 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs transition-colors cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* When disconnected from GitHub, display GitHub Authentication section INSTEAD of Build Profiles */}
        {!account ? (
          <div className="rounded-2xl border border-slate-700/80 bg-slate-900/90 p-6 shadow-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center text-slate-200 shrink-0">
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-100">GitHub Authentication Required</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Connect your GitHub account to load repositories, configure build profiles, and automate synchronization.
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={githubLoading || authorization?.status === 'ready' || authorization?.status === 'waiting'}
                onClick={() => void connectGitHub()}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors flex items-center gap-2 shadow-md shadow-sky-600/20 shrink-0"
              >
                {githubLoading ? 'Connecting…' : 'Connect GitHub'}
              </button>
            </div>

            {/* Device Code Flow Box */}
            {authorization && (
              <div className="mt-4 p-4 rounded-xl border border-sky-800/70 bg-sky-950/30 text-xs space-y-3">
                <p className="font-semibold text-slate-200">Device Authorization Code</p>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    aria-label="GitHub authorization code"
                    readOnly
                    value={authorization.userCode}
                    className="w-48 py-2 px-3 rounded-lg border border-slate-600 bg-slate-950 text-center font-mono text-lg font-bold tracking-widest text-slate-100 select-all"
                  />
                  <button
                    type="button"
                    onClick={() => void copyAuthorizationCode()}
                    className="px-3.5 py-2 rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors"
                  >
                    {codeCopied ? 'Copied to Clipboard' : 'Copy Code'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void openVerification()}
                    disabled={authorization.status === 'expired' || authorization.status === 'cancelled'}
                    className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors"
                  >
                    Open GitHub Verification
                  </button>
                  <button
                    type="button"
                    onClick={cancelAuthorization}
                    className="px-3.5 py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs font-medium text-slate-400 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
                <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1">
                  <span>
                    {authorization.status === 'waiting'
                      ? 'Waiting for authorization on GitHub…'
                      : authorization.status === 'ready'
                      ? 'Ready to authorize on GitHub.'
                      : authorization.status === 'expired'
                      ? 'Authorization code expired.'
                      : 'Authorization failed.'}
                  </span>
                  <span className="font-mono">
                    Expires in {(() => {
                      const seconds = Math.max(0, Math.ceil((authorization.expiresAt - now) / 1000));
                      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
                    })()}
                  </span>
                </div>
              </div>
            )}

            {githubMessage && (
              <p className="mt-3 text-xs text-amber-300">{githubMessage}</p>
            )}
          </div>
        ) : (
          /* Profiles Section (Stacked Accordion Cards) */
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">
                  Build Profiles
                </h2>
                <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                  {profiles.length}
                </span>
              </div>
            </div>

            {profiles.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-700/80 bg-slate-900/40 p-8 text-center space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-slate-400 mx-auto">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </div>
                <h3 className="text-sm font-bold text-slate-200">No Build Profiles Configured</h3>
                <p className="text-xs text-slate-400 max-w-sm mx-auto">
                  Create a profile to connect your repository and automate Unreal Engine project packaging.
                </p>
                <button
                  type="button"
                  onClick={handleCreateNew}
                  className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white transition-all shadow-md shadow-sky-600/20"
                >
                  Create First Profile
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {profiles.map((profile) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    prerequisites={prerequisites[profile.id]}
                    onPullNow={(p) => pullNow(p)}
                    onCloneNow={handleCloneNow}
                    onToggleEnabled={handleToggleEnabled}
                    onEdit={handleEditProfile}
                    onDelete={handleDeleteProfile}
                    onRebuildCommit={handleRebuildCommit}
                    isBusy={busyId === profile.id}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Global Schedule Settings Modal */}
      {scheduleSettingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setScheduleSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl p-6 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-base font-bold text-slate-100">Schedule Settings</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Global scheduler polling and artifact retention rules
                </p>
              </div>
              <button
                type="button"
                onClick={() => setScheduleSettingsOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 rounded-lg"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-300 mb-1">
                  Polling Interval
                </label>
                <select
                  value={draftInterval}
                  onChange={(e) => setDraftInterval(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                >
                  {REMOTE_BUILD_INTERVALS.map((mins) => (
                    <option key={mins} value={mins}>
                      Every {mins} minute{mins === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
                <label className="flex items-center gap-2.5 font-semibold text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draftKeepEnabled}
                    onChange={(e) => setDraftKeepEnabled(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-sky-600 focus:ring-sky-500 accent-sky-500"
                  />
                  <span>Enable Build Retention Cleanup</span>
                </label>
                <p className="text-[11px] text-slate-400 pl-6">
                  Automatically prunes older build outputs after successful packaging runs.
                </p>
                {draftKeepEnabled && (
                  <div className="pl-6 pt-1.5 flex items-center gap-2">
                    <span className="text-slate-400">Keep latest:</span>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={draftKeepCount}
                      onChange={(e) => setDraftKeepCount(e.target.value)}
                      className="w-20 px-2 py-1 rounded border border-slate-700 bg-slate-950 text-slate-200 text-center font-mono"
                    />
                    <span className="text-slate-400">builds</span>
                  </div>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                <label className="flex items-center gap-2.5 font-semibold text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draftArchiveOnly}
                    onChange={(e) => setDraftArchiveOnly(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-sky-600 focus:ring-sky-500 accent-sky-500"
                  />
                  <span>Store Builds as Zip Archives Only</span>
                </label>
                <p className="text-[11px] text-slate-400 pl-6">
                  Compresses packaged builds into .zip archives and removes unpacked build folders to conserve disk space.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setScheduleSettingsOpen(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void applySettings()}
                className="px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white transition-colors"
              >
                Apply Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Profile Create / Edit Modal */}
      <ProfileEditorModal
        profile={editingProfile}
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSave={handleSaveProfile}
      />

      {/* Output Log - hidden by default, shown when job runs or user toggles */}
      <div
        className={`flex flex-col min-w-0 transition-all overflow-hidden rounded-lg border border-slate-600/60 bg-slate-800/40 ${
          showOutputLog ? 'flex-[6_1_0] min-h-0' : 'shrink-0'
        }`}
      >
        <button
          type="button"
          onClick={() => setShowOutputLog((prev) => !prev)}
          className="flex items-center justify-between w-full px-4 py-2 hover:bg-slate-700/50 text-left transition-colors"
        >
          <span className="text-sm font-medium text-slate-300">
            Output Log
          </span>
          <span
            className={`inline-block text-slate-400 text-xs transition-transform ${
              showOutputLog ? 'rotate-180' : ''
            }`}
          >
            ▼
          </span>
        </button>
        {showOutputLog && (
          <div className="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden border-t border-slate-600/60 p-4">
            <OutputLogPanel />
          </div>
        )}
      </div>
    </section>
  );
}
