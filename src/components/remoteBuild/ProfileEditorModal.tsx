import React, { useState, useEffect, useMemo, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  GitHubBranch,
  GitHubRepository,
  RemoteBuildProfile,
} from '../../types';
import { useEngines } from '../../hooks/useEngines';
import { useGitHub, openAppInstallUrl } from '../../hooks/useGitHub';
import { createRemoteBuildProfile } from '../../hooks/useRemoteBuildProfiles';

export interface ProfileEditorModalProps {
  profile: RemoteBuildProfile | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (profileData: RemoteBuildProfile) => Promise<void>;
}

export function ProfileEditorModal({
  profile,
  isOpen,
  onClose,
  onSave,
}: ProfileEditorModalProps) {
  const { engines } = useEngines();
  const { account, repositories, loading: githubLoading, loadRepositories, loadBranches } = useGitHub();

  const isEditing = Boolean(profile);

  const [name, setName] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepository | null>(null);
  const [repositoryPath, setRepositoryPath] = useState('');
  const [buildBranch, setBuildBranch] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [enginePath, setEnginePath] = useState('');
  const [platform, setPlatform] = useState('Win64');
  const [packageConfig, setPackageConfig] = useState('Development');
  const [outputPath, setOutputPath] = useState('');
  const [additionalArgs, setAdditionalArgs] = useState('');
  const [enabled, setEnabled] = useState(true);

  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [repoTooltipVisible, setRepoTooltipVisible] = useState(false);
  const repoTooltipTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRepoTooltip = () => {
    if (repoTooltipTimeout.current) {
      clearTimeout(repoTooltipTimeout.current);
      repoTooltipTimeout.current = null;
    }
    setRepoTooltipVisible(true);
  };

  const hideRepoTooltip = () => {
    if (repoTooltipTimeout.current) {
      clearTimeout(repoTooltipTimeout.current);
    }
    repoTooltipTimeout.current = setTimeout(() => {
      setRepoTooltipVisible(false);
    }, 450);
  };

  useEffect(() => {
    return () => {
      if (repoTooltipTimeout.current) {
        clearTimeout(repoTooltipTimeout.current);
      }
    };
  }, []);

  // Initialize or reset form when modal opens or profile changes
  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setSelectedRepo(profile.repository);
      setRepositoryPath(profile.repositoryPath);
      setBuildBranch(profile.buildBranch);
      setProjectPath(profile.projectPath);
      setEnginePath(profile.enginePath);
      setPlatform(profile.platform || 'Win64');
      setPackageConfig(profile.packageConfig || 'Development');
      setOutputPath(profile.outputPath || '');
      setAdditionalArgs(profile.additionalArgs || '');
      setEnabled(profile.enabled);
    } else {
      setName('');
      setSelectedRepo(null);
      setRepositoryPath('');
      setBuildBranch('main');
      setProjectPath('');
      setEnginePath('');
      setPlatform('Win64');
      setPackageConfig('Development');
      setOutputPath('');
      setAdditionalArgs('');
      setEnabled(true);
    }
    setValidationError(null);
  }, [profile, isOpen]);

  // Load repositories if list is empty
  useEffect(() => {
    if (isOpen && account && repositories.length === 0) {
      void loadRepositories();
    }
  }, [isOpen, account, repositories.length, loadRepositories]);

  // Load branches when selected repository changes
  useEffect(() => {
    if (selectedRepo) {
      setLoadingBranches(true);
      loadBranches(selectedRepo)
        .then((b) => {
          setBranches(b);
          if (b.length > 0 && !buildBranch) {
            setBuildBranch(selectedRepo.defaultBranch || b[0].name);
          }
        })
        .finally(() => setLoadingBranches(false));
    } else {
      setBranches([]);
    }
  }, [selectedRepo, loadBranches]);

  // Pick destination directory dialog
  const handlePickDirectory = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Destination Directory for Git Repository',
      });
      if (typeof selected === 'string') {
        setRepositoryPath(selected);
      }
    } catch (err) {
      console.warn('Failed to open directory dialog', err);
    }
  };

  // Filtered repository list
  const filteredRepositories = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repositories;
    return repositories.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.fullName.toLowerCase().includes(q) ||
        r.owner.toLowerCase().includes(q)
    );
  }, [repositories, repoSearch]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setValidationError('Profile name is required.');
      return;
    }

    if (!selectedRepo) {
      setValidationError('Please select a GitHub repository.');
      return;
    }

    if (!repositoryPath.trim()) {
      setValidationError('Destination directory path is required.');
      return;
    }

    if (!buildBranch.trim()) {
      setValidationError('Build branch is required.');
      return;
    }

    setSaving(true);
    try {
      if (profile) {
        const updated: RemoteBuildProfile = {
          ...profile,
          name: trimmedName,
          repository: selectedRepo,
          repositoryPath: repositoryPath.trim(),
          buildBranch: buildBranch.trim(),
          projectPath: projectPath.trim(),
          enginePath: enginePath.trim(),
          platform,
          packageConfig,
          outputPath: outputPath.trim(),
          additionalArgs: additionalArgs.trim() || undefined,
          enabled,
        };
        await onSave(updated);
      } else {
        const newProfile = createRemoteBuildProfile({
          name: trimmedName,
          repository: selectedRepo,
          repositoryPath: repositoryPath.trim(),
          buildBranch: buildBranch.trim(),
          projectPath: projectPath.trim(),
          enginePath: enginePath.trim(),
          platform,
          packageConfig,
          outputPath: outputPath.trim(),
          additionalArgs: additionalArgs.trim() || undefined,
          enabled,
        });
        await onSave(newProfile);
      }
      onClose();
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div>
            <h2 className="text-base font-bold text-slate-100">
              {isEditing ? 'Edit Build Profile' : 'Create Automatic Build Profile'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Configure Git synchronization and Unreal Engine packaging settings
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {validationError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{validationError}</span>
            </div>
          )}

          {/* Profile Name & Enable Toggle */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Profile Name <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. MyGame - Main Branch Build"
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Schedule Status
              </label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={`w-full py-2 px-3 text-xs font-semibold rounded-lg border transition-all flex items-center justify-center gap-2 ${
                  enabled
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                {enabled ? 'Schedule Enabled' : 'Paused'}
              </button>
            </div>
          </div>

          {/* GitHub Repository Picker */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <label className="block text-xs font-semibold text-slate-300">
                  GitHub Repository <span className="text-rose-400">*</span>
                </label>
                <div
                  className="relative inline-flex items-center"
                  onMouseEnter={showRepoTooltip}
                  onMouseLeave={hideRepoTooltip}
                >
                  <button
                    type="button"
                    onClick={() => void openAppInstallUrl()}
                    className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 transition-colors cursor-pointer"
                    title="Can't find the repo you are looking for?"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span className="underline decoration-dotted underline-offset-2">Can&apos;t find the repo you are looking for?</span>
                  </button>

                  {repoTooltipVisible && (
                    <div
                      onMouseEnter={showRepoTooltip}
                      onMouseLeave={hideRepoTooltip}
                      className="absolute left-0 top-full mt-1.5 z-50 w-72 p-3 rounded-xl bg-slate-950 border border-slate-700 text-slate-300 shadow-2xl text-[11px] leading-relaxed animate-in fade-in zoom-in-95 duration-150"
                    >
                      <p className="font-semibold text-slate-100 mb-1 flex items-center gap-1">
                        <span>📦 GitHub App Repository Access</span>
                      </p>
                      <p className="text-slate-400 mb-2">
                        GitHub Apps only list repositories from accounts or organizations where they are installed. If your desired repository isn&apos;t listed:
                      </p>
                      <button
                        type="button"
                        onClick={() => void openAppInstallUrl()}
                        className="w-full py-1.5 px-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium text-[11px] flex items-center justify-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                      >
                        <span>Install / Configure GitHub App ↗</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {account && (
                <button
                  type="button"
                  onClick={() => void loadRepositories()}
                  disabled={githubLoading}
                  className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 disabled:opacity-40 transition-colors"
                  title="Reload repositories from GitHub"
                >
                  <svg className={`w-3 h-3 ${githubLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>{githubLoading ? 'Refreshing…' : 'Refresh Repos'}</span>
                </button>
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setRepoPickerOpen(!repoPickerOpen)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-slate-950 text-slate-200 flex items-center justify-between hover:border-slate-600 transition-colors"
              >
                <span className={selectedRepo ? 'font-mono text-slate-200' : 'text-slate-500'}>
                  {selectedRepo ? selectedRepo.fullName : 'Select a GitHub repository…'}
                </span>
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {repoPickerOpen && (
                <div className="absolute z-20 top-full mt-1 left-0 right-0 p-2 bg-slate-900 border border-slate-700 rounded-xl shadow-xl max-h-56 overflow-y-auto">
                  <input
                    type="text"
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    placeholder="Search repositories…"
                    className="w-full px-2.5 py-1.5 text-xs rounded-md border border-slate-700 bg-slate-950 text-slate-200 mb-2 focus:outline-none focus:ring-1 focus:ring-sky-500"
                    autoFocus
                  />
                  <div className="space-y-1">
                    {filteredRepositories.map((repo) => (
                      <button
                        key={repo.id}
                        type="button"
                        onClick={() => {
                          setSelectedRepo(repo);
                          if (!name) setName(repo.name);
                          setRepoPickerOpen(false);
                        }}
                        className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors flex items-center justify-between ${
                          selectedRepo?.id === repo.id
                            ? 'bg-sky-600/30 text-sky-200 border border-sky-500/30'
                            : 'text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        <span>{repo.fullName}</span>
                        {repo.private && (
                          <span className="text-[10px] font-sans px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                            private
                          </span>
                        )}
                      </button>
                    ))}
                    {filteredRepositories.length === 0 && (
                      <div className="text-center py-3 text-xs text-slate-400 space-y-1.5">
                        <p>{githubLoading ? 'Loading repositories…' : 'No repositories found.'}</p>
                        <p className="text-[11px] text-slate-500">
                          Need a repo from another account or organization?
                        </p>
                        <div className="flex items-center justify-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => void openAppInstallUrl()}
                            className="px-2.5 py-1 rounded bg-sky-600/30 hover:bg-sky-600/50 text-sky-300 border border-sky-500/30 text-[11px] transition-colors"
                          >
                            Install GitHub App ↗
                          </button>
                          {!githubLoading && account && (
                            <button
                              type="button"
                              onClick={() => void loadRepositories()}
                              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-400 text-[11px] transition-colors"
                            >
                              Refresh
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Target Folder & Branch */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Destination Folder <span className="text-rose-400">*</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={repositoryPath}
                  onChange={(e) => setRepositoryPath(e.target.value)}
                  placeholder="C:\Builds\MyProject"
                  className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  required
                />
                <button
                  type="button"
                  onClick={handlePickDirectory}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 transition-colors"
                >
                  Browse…
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Build Branch <span className="text-rose-400">*</span>
              </label>
              {branches.length > 0 ? (
                <select
                  value={buildBranch}
                  onChange={(e) => setBuildBranch(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  required
                >
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={buildBranch}
                  onChange={(e) => setBuildBranch(e.target.value)}
                  placeholder={loadingBranches ? 'Loading branches…' : 'main'}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  required
                />
              )}
            </div>
          </div>

          {/* Unreal Engine & Platform Settings */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Unreal Engine
              </label>
              <select
                value={enginePath}
                onChange={(e) => setEnginePath(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              >
                <option value="">Auto-Detect from .uproject</option>
                {engines.map((eng) => (
                  <option key={eng.editorPath} value={eng.editorPath}>
                    {eng.displayName || `Unreal Engine ${eng.version}`}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Platform
              </label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              >
                <option value="Win64">Win64</option>
                <option value="Linux">Linux</option>
                <option value="Android">Android</option>
                <option value="IOS">iOS</option>
                <option value="Mac">Mac</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Configuration
              </label>
              <select
                value={packageConfig}
                onChange={(e) => setPackageConfig(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              >
                <option value="Development">Development</option>
                <option value="Shipping">Shipping</option>
                <option value="DebugGame">DebugGame</option>
                <option value="Test">Test</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Additional arguments
            </label>
            <input
              type="text"
              value={additionalArgs}
              onChange={(e) => setAdditionalArgs(e.target.value)}
              placeholder="-compressed -prereqs"
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-slate-950 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-800 bg-slate-950/40">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors"
          >
            {saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
