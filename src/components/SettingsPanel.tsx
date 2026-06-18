/**
 * Settings panel - modal slide-over with General, Engine Management, Engine Association.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettings } from '../hooks/useSettings';
import { useEngines } from '../hooks/useEngines';
import { useProjects } from '../hooks/useProjects';
import useIde from '../hooks/useIde';
import { Select } from './Select';
import type { CustomEngineEntry, IdeCandidate } from '../types';
import { getShortEngineVersion, getEngineLabel } from '../utils/project';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** When set, scroll to and focus Engine Management section (e.g. from Add Engine card) */
  initialSection?: 'general' | 'engines' | 'association';
}

export function SettingsPanel({ open: isOpen, onClose }: SettingsPanelProps) {
  const { settings, setSetting } = useSettings();
  const { engines, allEngines, refresh: refreshEngines } = useEngines();
  const { projects } = useProjects();
  const [addEnginePath, setAddEnginePath] = useState('');
  const [addEngineVersion, setAddEngineVersion] = useState('');
  const [addEngineName, setAddEngineName] = useState('');
  const [addEngineError, setAddEngineError] = useState('');
  const [editingEngineId, setEditingEngineId] = useState<string | null>(null);
  const { candidates: ideCandidates, loading: ideLoading, refresh: refreshIdeCandidates } = useIde();

  useEffect(() => {
    if (isOpen) {
      void refreshIdeCandidates();
    }
  }, [isOpen, refreshIdeCandidates]);

  useEffect(() => {
    if (!isOpen) return;
    const hasPreferred =
      !!settings.preferredIdeId && ideCandidates.some((c: IdeCandidate) => c.id === settings.preferredIdeId);
    if (!hasPreferred) {
      const fallbackId = ideCandidates[0]?.id ?? '';
      if (fallbackId && fallbackId !== settings.preferredIdeId) {
        void setSetting('preferredIdeId', fallbackId);
      }
    }
  }, [isOpen, ideCandidates, settings.preferredIdeId, setSetting]);

  const ideOptions = useMemo(
    () => ideCandidates.map((ide: IdeCandidate) => ({ value: ide.id, label: ide.label })),
    [ideCandidates]
  );

  const handleStartWithWindowsChange = useCallback(async () => {
    const next = !settings.startWithWindows;
    await setSetting('startWithWindows', next);
  }, [settings.startWithWindows, setSetting]);

  const handleNotificationOnCompleteChange = useCallback(async () => {
    const next = !settings.notificationOnComplete;
    await setSetting('notificationOnComplete', next);
  }, [settings.notificationOnComplete, setSetting]);

  const toggleEngineDisabled = useCallback(
    async (editorPath: string) => {
      const lowerPath = editorPath.toLowerCase();
      const currentDisabled = settings.disabledEnginePaths.map(p => p.toLowerCase());
      let nextDisabled: string[];
      
      if (currentDisabled.includes(lowerPath)) {
        nextDisabled = settings.disabledEnginePaths.filter(p => p.toLowerCase() !== lowerPath);
      } else {
        nextDisabled = [...settings.disabledEnginePaths, editorPath];
      }
      
      await setSetting('disabledEnginePaths', nextDisabled);
      refreshEngines();
    },
    [settings.disabledEnginePaths, setSetting, refreshEngines]
  );

  const removeCustomEngine = useCallback(
    async (id: string) => {
      const next = settings.customEngines.filter((c) => c.id !== id);
      await setSetting('customEngines', next);
      await setSetting('disabledEnginePaths', settings.disabledEnginePaths.filter((p) => {
        const eng = settings.customEngines.find((c) => c.id === id);
        return !eng || p.toLowerCase() !== eng.editorPath.toLowerCase();
      }));
      refreshEngines();
      setEditingEngineId(null);
    },
    [settings.customEngines, settings.disabledEnginePaths, setSetting, refreshEngines]
  );

  const handleBrowseEngine = useCallback(async () => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Unreal Editor (UnrealEditor.exe or UE4Editor.exe)', extensions: ['exe'] }],
    });
    if (path && typeof path === 'string') {
      setAddEnginePath(path);
      setAddEngineError('');
      try {
        const valid = await invoke<boolean>('validate_engine_path', { path });
        if (!valid) {
          setAddEngineError('Path does not point to a valid Unreal Engine installation.');
          return;
        }
        const version = await invoke<string>('read_engine_version_from_path', { editorPath: path });
        setAddEngineVersion(version);
      } catch (e) {
        setAddEngineError(String(e));
      }
    }
  }, []);

  const handleAddCustomEngine = useCallback(async () => {
    if (!addEnginePath.trim()) {
      setAddEngineError('Please select an engine path.');
      return;
    }
    try {
      const valid = await invoke<boolean>('validate_engine_path', { path: addEnginePath });
      if (!valid) {
        setAddEngineError('Path does not point to a valid Unreal Engine installation.');
        return;
      }
    } catch {
      setAddEngineError('Failed to validate path.');
      return;
    }
    const displayName = addEngineName.trim() || `UE ${addEngineVersion}`;
    const version = addEngineVersion.trim() || 'Unknown';
    const existingNames = new Set(settings.customEngines.map((c) => c.displayName.toLowerCase()));
    if (existingNames.has(displayName.toLowerCase())) {
      setAddEngineError('A custom engine with this name already exists.');
      return;
    }
    const existingPaths = new Set(settings.customEngines.map((c) => c.editorPath.toLowerCase()));
    if (existingPaths.has(addEnginePath.toLowerCase())) {
      setAddEngineError('This engine path is already added as a custom engine.');
      return;
    }
    // Check if it's already in allEngines (registry or custom)
    const alreadyExists = allEngines.some(e => e.editorPath.toLowerCase() === addEnginePath.toLowerCase());
    if (alreadyExists) {
        // If it exists but is not in customEngines, it's a registry engine.
        // We might want to allow adding it as custom to give it a name, 
        // but EnginesContext will deduplicate it anyway.
        // Given the user's issue with duplicates, let's be strict or at least aware.
    }
    const id = crypto.randomUUID();
    const newEngine: CustomEngineEntry = {
      id,
      displayName,
      editorPath: addEnginePath,
      version,
      enabled: true,
    };
    await setSetting('customEngines', [...settings.customEngines, newEngine]);
    refreshEngines();
    setAddEnginePath('');
    setAddEngineVersion('');
    setAddEngineName('');
    setAddEngineError('');
  }, [addEnginePath, addEngineVersion, addEngineName, settings.customEngines, setSetting, refreshEngines]);

  const setProjectOverride = useCallback(
    async (projectPath: string, editorPath: string) => {
      const next = { ...settings.projectEngineOverrides };
      const lowerPath = projectPath.toLowerCase();
      // Remove any existing entry with same path (case-insensitive)
      Object.keys(next).forEach(k => {
        if (k.toLowerCase() === lowerPath) {
          delete next[k];
        }
      });

      if (editorPath !== '') {
        next[projectPath] = editorPath;
      }
      await setSetting('projectEngineOverrides', next);
    },
    [settings.projectEngineOverrides, setSetting]
  );

  const setDefaultEngineForVersion = useCallback(
    async (version: string, editorPath: string) => {
      const next = { ...settings.defaultEngineByVersion };
      const short = getShortEngineVersion(version);
      if (editorPath === '') {
        delete next[short];
      } else {
        next[short] = editorPath;
      }
      await setSetting('defaultEngineByVersion', next);
    },
    [settings.defaultEngineByVersion, setSetting]
  );

  const projectsForOverride = projects;

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg bg-slate-900 border-l border-slate-700 shadow-xl overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-700 px-6 py-4 flex items-center justify-between">
          <h2 id="settings-title" className="text-lg font-semibold text-slate-100">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            aria-label="Close settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-8">
          {/* General */}
          <section id="settings-general" className="space-y-3">
            <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider">General</h3>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.startWithWindows}
                onChange={handleStartWithWindowsChange}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              <span className="text-slate-200">Start with Windows</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.notificationOnComplete}
                onChange={handleNotificationOnCompleteChange}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              <span className="text-slate-200">Notification on complete</span>
            </label>
            <div className="space-y-1">
              <label className="block text-sm text-slate-300">Preferred IDE</label>
              <Select
                value={settings.preferredIdeId}
                onChange={(v) => setSetting('preferredIdeId', v)}
                placeholder={ideLoading ? 'Detecting IDEs...' : 'No IDE detected'}
                options={ideOptions}
                className="min-w-[16rem]"
              />
              <p className="text-xs text-slate-500">
                Used by Launch IDE actions. Rider opens `.uproject`, Visual Studio opens `.sln`.
              </p>
            </div>
          </section>

          {/* Engine Management */}
          <section id="settings-engines" className="space-y-3">
            <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider">Engine Management</h3>
            <p className="text-sm text-slate-400">
              Registry engines are validated on disk. Disabled engines are hidden. Custom engines can be added for source builds.
            </p>

            <div className="space-y-2">
              {allEngines.map((e) => {
                const isDisabled = settings.disabledEnginePaths.some((p) => p.toLowerCase() === e.editorPath.toLowerCase());
                const isCustom = e.isCustom ?? false;
                return (
                  <div
                    key={e.id ?? e.editorPath}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                      isDisabled ? 'border-slate-700/50 bg-slate-800/30 opacity-70' : 'border-slate-600/60 bg-slate-800/50'
                    }`}
                  >
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!isDisabled}
                      onClick={() => toggleEngineDisabled(e.editorPath)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500/50 ${
                        isDisabled ? 'bg-slate-600' : 'bg-sky-500'
                      }`}
                      title={isDisabled ? 'Enable engine' : 'Disable engine'}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                          isDisabled ? 'translate-x-1' : 'translate-x-5'
                        }`}
                      />
                    </button>
                    <div className="flex-1 min-w-0">
                      <span className="text-slate-200 font-medium truncate block">
                        {getEngineLabel(e)}
                      </span>
                      <span className="text-xs text-slate-500 truncate block">{e.editorPath}</span>
                    </div>
                    {isCustom && (
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-400" title="Custom engine">
                        Custom
                      </span>
                    )}
                    {isCustom && (
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingEngineId(editingEngineId === e.id ? null : (e.id ?? null))}
                          className="p-1.5 rounded text-slate-400 hover:text-sky-400 hover:bg-slate-700"
                          title="Edit"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => e.id && removeCustomEngine(e.id)}
                          className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-slate-700"
                          title="Remove"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add custom engine */}
            <div className="rounded-lg border border-dashed border-slate-600/60 p-4 space-y-3">
              <h4 className="text-sm font-medium text-slate-300">Add custom engine</h4>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={addEnginePath}
                  onChange={(e) => setAddEnginePath(e.target.value)}
                  placeholder="UnrealEditor.exe path"
                  className="flex-1 rounded-md bg-slate-800 border border-slate-600/60 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleBrowseEngine}
                  className="rounded-md px-3 py-2 bg-slate-700/80 hover:bg-slate-600/80 text-slate-200 text-sm font-medium"
                >
                  Browse
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={addEngineVersion}
                  onChange={(e) => setAddEngineVersion(e.target.value)}
                  placeholder="Version (e.g. 5.4.1)"
                  className="flex-1 rounded-md bg-slate-800 border border-slate-600/60 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
                <input
                  type="text"
                  value={addEngineName}
                  onChange={(e) => setAddEngineName(e.target.value)}
                  placeholder="Display name (optional)"
                  className="flex-1 rounded-md bg-slate-800 border border-slate-600/60 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </div>
              {addEngineError && (
                <p className="text-sm text-red-400">{addEngineError}</p>
              )}
              <button
                type="button"
                onClick={handleAddCustomEngine}
                disabled={!addEnginePath.trim()}
                className="rounded-md px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 disabled:bg-slate-600 disabled:text-slate-500 text-white text-sm font-medium transition-colors"
              >
                Add engine
              </button>
            </div>
          </section>

          {/* Engine Association */}
          <section id="settings-association" className="space-y-3">
            <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wider">Engine Association</h3>
            <p className="text-sm text-slate-400">
              Override which engine to use for projects. Set default engine when multiple versions match.
            </p>

            {projectsForOverride.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-slate-300">Project engine overrides</h4>
                {projectsForOverride.map((p) => (
                  <div key={p.projectPath} className="flex items-center gap-3">
                    <span className="flex-1 min-w-0 truncate text-sm text-slate-300" title={p.projectPath}>
                      {p.projectName} ({p.engineVersion})
                    </span>
                    <Select
                      value={Object.entries(settings.projectEngineOverrides).find(([path]) => path.toLowerCase() === p.projectPath.toLowerCase())?.[1] ?? ''}
                      onChange={(v) => setProjectOverride(p.projectPath, v)}
                      placeholder="Select engine"
                      options={[
                        { value: '', label: p.engineInstallPath === 'Unknown' ? 'No engine' : 'Use default' },
                        ...engines.map((e) => ({
                          value: e.editorPath,
                          label: getEngineLabel(e),
                        })),
                      ]}
                      className="min-w-[12rem]"
                    />
                  </div>
                ))}
              </div>
            )}

            {engines.filter((e) => engines.filter((x) => getShortEngineVersion(x.version) === getShortEngineVersion(e.version)).length > 1).length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-slate-300">Default engine per version</h4>
                {Array.from(
                  new Set(engines.map((e) => getShortEngineVersion(e.version))).values()
                )
                  .filter((v) => v && engines.filter((e) => getShortEngineVersion(e.version) === v).length > 1)
                  .map((version) => (
                    <div key={version} className="flex items-center gap-3">
                      <span className="text-sm text-slate-300 w-16">UE {version}</span>
                      <Select
                        value={settings.defaultEngineByVersion[version] ?? ''}
                        onChange={(v) => setDefaultEngineForVersion(version, v)}
                        placeholder="Select default"
                        options={[
                          { value: '', label: 'Auto' },
                          ...engines
                            .filter((e) => getShortEngineVersion(e.version) === version)
                            .map((e) => ({
                              value: e.editorPath,
                              label: getEngineLabel(e),
                            })),
                        ]}
                        className="min-w-[12rem]"
                      />
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
