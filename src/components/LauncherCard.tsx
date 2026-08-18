/**
 * LauncherCard - Project or Engine card.
 * Projects: Full card with thumbnail, name, version, Launch/Delete buttons, map dropdown.
 * Engines: Compact card without thumbnail (name + Launch button).
 * Mirrors LauncherBtn from UECommandHelper.
 */

import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ASSETS } from '../config/assets';
import type { ProjectInfo } from '../types';

const LAUNCH_COOLDOWN_MS = 5000;

function mapDisplayName(mapPath: string): string {
  return mapPath.split(/[/\\]/).pop() || mapPath;
}

type PreferredIdeKind = 'rider' | 'visual_studio' | 'unknown';

type ProjectFolderAvailability = Record<'project' | 'screenshots' | 'savegames' | 'packaged' | 'logs', boolean>;
type ProjectActionIcon = 'folder' | 'delete' | 'screenshots' | 'savegames' | 'packaged' | 'logs' | 'regenerate';

function ProjectActionIcon({ kind }: { kind: ProjectActionIcon }) {
  const paths: Record<ProjectActionIcon, string> = {
    folder: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
    delete: 'M6 7h12m-9 0V5h6v2m-7 4v5m4-5v5m4-5v5M5 7l1 14h12l1-14',
    screenshots: 'M4 5h16v14H4zM8 13l2.5-2.5L14 14l2-2 4 4M8 9h.01',
    savegames: 'M5 3h12l2 2v16H5V3zm3 0v6h8V3m-6 12h6',
    packaged: 'M4 7l8-4 8 4-8 4-8-4zm0 0v10l8 4 8-4V7m-8 4v10',
    logs: 'M6 3h9l3 3v15H6V3zm9 0v4h3m-9 4h6m-6 4h6m-6 4h4',
    regenerate: 'M20 11a8 8 0 00-14.9-4M4 5v4h4m-4 2a8 8 0 0014.9 4M20 19v-4h-4',
  };

  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={paths[kind]} />
    </svg>
  );
}

interface LauncherCardProps {
  project: ProjectInfo;
  isEngine?: boolean;
  isCustomEngine?: boolean;
  onRemove?: (projectPath: string) => void;
  onUpdateAlias?: (alias: string) => Promise<void>;
  onQuickRegenerate?: (projectPath: string) => void;
  ideKind?: PreferredIdeKind;
  ideExePath?: string | null;
}

export function LauncherCard({ project, isEngine = false, isCustomEngine = false, onRemove, onUpdateAlias, onQuickRegenerate, ideKind, ideExePath }: LauncherCardProps) {
  const [thumbnailSrc, setThumbnailSrc] = useState<string>(ASSETS.ueIcon);
  const [launchDisabled, setLaunchDisabled] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [actionMenuPosition, setActionMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [folderAvailability, setFolderAvailability] = useState<ProjectFolderAvailability | null>(null);
  const [thumbnailReady, setThumbnailReady] = useState(isEngine);
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState(project.projectAlias ?? '');
  const mapDropdownRef = useRef<HTMLDivElement>(null);
  const actionMenuContainerRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEngine) return;

    let cancelled = false;
    setFolderAvailability(null);
    void invoke<ProjectFolderAvailability>('get_project_folder_availability', { projectPath: project.projectPath })
      .then((availability) => {
        if (!cancelled) setFolderAvailability(availability);
      })
      .catch((e) => {
        console.error('Failed to check project folders:', e);
        if (!cancelled) setFolderAvailability({ project: false, screenshots: false, savegames: false, packaged: false, logs: false });
      });
    return () => {
      cancelled = true;
    };
  }, [actionMenuOpen, isEngine, project.projectPath]);

  useEffect(() => {
    if (isEngine) {
      setThumbnailReady(true);
      return;
    }

    setThumbnailReady(false);
    if (!('IntersectionObserver' in window) || !cardRef.current) {
      setThumbnailReady(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setThumbnailReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [isEngine, project.projectPath]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (mapDropdownRef.current && !mapDropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        actionMenuContainerRef.current &&
        !actionMenuContainerRef.current.contains(target) &&
        !actionMenuRef.current?.contains(target)
      ) {
        setActionMenuOpen(false);
      }
    };
    if (actionMenuOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [actionMenuOpen]);

  useEffect(() => {
    if (!actionMenuOpen) return;

    const updateActionMenuPosition = () => {
      const button = actionButtonRef.current;
      const menu = actionMenuRef.current;
      if (!button || !menu) return;

      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const edgePadding = 8;
      const left = Math.max(
        edgePadding,
        Math.min(buttonRect.right - menuRect.width, window.innerWidth - menuRect.width - edgePadding)
      );
      const spaceBelow = window.innerHeight - buttonRect.bottom - edgePadding;
      const top = spaceBelow >= menuRect.height
        ? buttonRect.bottom + 4
        : Math.max(edgePadding, buttonRect.top - menuRect.height - 4);

      setActionMenuPosition({ top, left });
    };

    const frame = requestAnimationFrame(updateActionMenuPosition);
    window.addEventListener('resize', updateActionMenuPosition);
    window.addEventListener('scroll', updateActionMenuPosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateActionMenuPosition);
      window.removeEventListener('scroll', updateActionMenuPosition, true);
    };
  }, [actionMenuOpen]);

  useEffect(() => {
    if (isEngine || !thumbnailReady) {
      setThumbnailSrc(ASSETS.ueIcon);
      return;
    }
    invoke<string | null>('get_project_thumbnail_path', { projectPath: project.projectPath })
      .then((path) => {
        if (path) {
          try {
            setThumbnailSrc(convertFileSrc(path));
          } catch {
            setThumbnailSrc(ASSETS.ueIcon);
          }
        } else {
          setThumbnailSrc(ASSETS.ueIcon);
        }
      })
      .catch(() => setThumbnailSrc(ASSETS.ueIcon));
  }, [project.projectPath, isEngine, thumbnailReady]);

  const startLaunchCooldown = () => {
    setLaunchDisabled(true);
    setTimeout(() => setLaunchDisabled(false), LAUNCH_COOLDOWN_MS);
  };

  const handleLaunchProject = async () => {
    if (launchDisabled) return;
    try {
      startLaunchCooldown();
      await invoke('open_file', { path: project.projectPath });
    } catch (e) {
      console.error('Failed to launch:', e);
      setLaunchDisabled(false);
    }
  };

  const handleLaunchWithMap = async (mapPath: string) => {
    if (launchDisabled) return;
    const enginePath = project.engineInstallPath;
    if (!enginePath || enginePath === 'Unknown') {
      console.error('Engine path not found for this project');
      return;
    }
    setDropdownOpen(false);
    try {
      startLaunchCooldown();
      await invoke('launch_project_with_map', {
        projectPath: project.projectPath,
        mapPath,
        enginePath,
      });
    } catch (e) {
      console.error('Failed to launch with map:', e);
      setLaunchDisabled(false);
    }
  };

  const handleLaunchSln = async () => {
    if (launchDisabled) return;
    try {
      startLaunchCooldown();
      await invoke('launch_ide_for_project', {
        uprojectPath: project.projectPath,
        ideKind: ideKind ?? 'unknown',
        ideExePath: ideExePath ?? null,
      });
    } catch (e) {
      console.error('Failed to launch IDE:', e);
      setLaunchDisabled(false);
    }
  };

  const ideButtonLabel = 'Launch IDE';

  const handleDelete = () => {
    setActionMenuOpen(false);
    onRemove?.(project.projectPath);
  };

  const handleOpenFolder = async (folder: string) => {
    try {
      setActionMenuOpen(false);
      await invoke('open_project_folder', { projectPath: project.projectPath, folder });
    } catch (e) {
      console.error(`Failed to open ${folder}:`, e);
    }
  };

  const handleAliasSave = async () => {
    const alias = aliasDraft.trim();
    try {
      await onUpdateAlias?.(alias);
      setEditingAlias(false);
    } catch (e) {
      console.error('Failed to save project alias:', e);
    }
  };

  const handleAliasReset = async () => {
    try {
      await onUpdateAlias?.('');
      setAliasDraft('');
      setEditingAlias(false);
    } catch (e) {
      console.error('Failed to reset project alias:', e);
    }
  };

  const displayName = project.projectAlias?.trim() || project.projectName;

  /* Compact engine card: same layout as non-compact but without thumbnail */
  if (isEngine) {
    return (
      <div className="flex flex-col rounded-lg border border-slate-600/60 bg-slate-800/50 w-36 shrink-0 shadow-sm hover:border-slate-500/50 transition-colors">
        <div className="p-3 space-y-2 relative">
          {isCustomEngine && (
            <span className="absolute top-1.5 right-1.5 p-1 rounded-md bg-slate-700/80" title="Custom engine">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </span>
          )}
          <h3 className="font-medium text-slate-100 truncate text-sm text-center" title={project.projectName}>
            {project.projectName}
          </h3>
          <button
            type="button"
            onClick={handleLaunchProject}
            disabled={launchDisabled}
            className="w-full px-2 py-1.5 text-xs font-medium rounded-md bg-sky-600/80 hover:bg-sky-500/80 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-sky-600/80"
            title="Launches UnrealEditor.exe (engine entry point)."
          >
            {launchDisabled ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={cardRef} className="relative flex flex-col rounded-lg border border-slate-600/60 bg-slate-800/50 w-36 shrink-0 shadow-sm hover:border-slate-500/50 transition-colors">
      {/* Card header: square thumbnail (1:1) + overlays */}
      <div className="relative aspect-square w-full bg-slate-700/50 flex items-center justify-center rounded-t-lg">
        <img
          src={thumbnailSrc}
          alt={project.projectName}
          className="absolute inset-0 w-full h-full rounded-t-lg object-cover"
        />
        {/* Project actions */}
        <div className="absolute top-1.5 right-1.5" ref={actionMenuContainerRef}>
          <button
            type="button"
            ref={actionButtonRef}
            onClick={() => {
              setActionMenuOpen((open) => {
                if (!open) setActionMenuPosition(null);
                return !open;
              });
            }}
            className="p-1 rounded-md bg-slate-900/50 text-slate-300 hover:text-sky-400 hover:bg-slate-900/90 transition-colors"
            title="Project actions"
            aria-label="Open project actions"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.75h.008v.008H12V6.75zm0 5.25h.008v.008H12V12zm0 5.25h.008v.008H12V17.25z" />
            </svg>
          </button>
          {actionMenuOpen && (
            <div
              ref={actionMenuRef}
              className="fixed z-50 w-72 rounded-md border border-slate-600 bg-slate-800 py-1 shadow-xl"
              style={{
                top: actionMenuPosition?.top ?? 0,
                left: actionMenuPosition?.left ?? 0,
                visibility: actionMenuPosition ? 'visible' : 'hidden',
              }}
            >
              <button type="button" onClick={() => void handleOpenFolder('project')} disabled={!folderAvailability?.project} className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"><ProjectActionIcon kind="folder" />Open project file location</button>
              <button type="button" onClick={handleDelete} className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs text-red-300 hover:bg-slate-700"><ProjectActionIcon kind="delete" />Delete this project from the launcher</button>
              <button type="button" onClick={() => void handleOpenFolder('screenshots')} disabled={!folderAvailability?.screenshots} className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"><ProjectActionIcon kind="screenshots" />Open screenshot folder</button>
              <button type="button" onClick={() => void handleOpenFolder('savegames')} disabled={!folderAvailability?.savegames} className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"><ProjectActionIcon kind="savegames" />Open editor save games folder</button>
              <button type="button" onClick={() => void handleOpenFolder('packaged')} disabled={!folderAvailability?.packaged} className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"><ProjectActionIcon kind="packaged" />Open packaged game data folder</button>
              <button type="button" onClick={() => void handleOpenFolder('logs')} disabled={!folderAvailability?.logs} className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"><ProjectActionIcon kind="logs" />Open editor logs</button>
              {project.isCpp && onQuickRegenerate && <button type="button" onClick={() => { setActionMenuOpen(false); onQuickRegenerate(project.projectPath); }} className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-xs text-sky-300 hover:bg-slate-700"><ProjectActionIcon kind="regenerate" />Quick regenerate project</button>}
            </div>
          )}
        </div>
        {/* Bottom left: C++ icon (when C++) */}
        {project.isCpp && (
          <span className="absolute bottom-1.5 left-1.5 p-1 rounded-md bg-slate-900/30" title="C++ project">
            <img src={ASSETS.cppLogo} alt="C++" className="w-4 h-4" />
          </span>
        )}
        {/* Bottom right: short engine version + custom icon */}
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium text-slate-300 bg-slate-900/30">
          {isCustomEngine && (
            <span title="Custom engine">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </span>
          )}
          {project.engineVersion}
        </span>
      </div>

      <div className="p-2.5 space-y-1.5">
        <div className="flex items-center justify-center gap-1 min-w-0">
          {editingAlias ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <input
                autoFocus
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onBlur={() => void handleAliasSave()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAliasSave();
                  if (e.key === 'Escape') {
                    setAliasDraft(project.projectAlias ?? '');
                    setEditingAlias(false);
                  }
                }}
                className="min-w-0 flex-1 rounded border border-sky-500/70 bg-slate-900 px-1 py-0.5 text-sm text-slate-100 text-center focus:outline-none"
                aria-label="Project alias"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void handleAliasReset()}
                className="shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-amber-400 transition-colors"
                title="Reset to default project name"
                aria-label="Reset to default project name"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 4v5h5M20 20v-5h-5M5.5 9A7 7 0 0118 6.5L20 9M18.5 15A7 7 0 016 17.5L4 15" />
                </svg>
              </button>
            </div>
          ) : (
            <h3 className="font-medium text-slate-100 truncate text-sm text-center" title={displayName}>
              {displayName}
            </h3>
          )}
          {onUpdateAlias && !editingAlias && (
            <button
              type="button"
              onClick={() => {
                setAliasDraft(project.projectAlias ?? '');
                setEditingAlias(true);
              }}
              className="shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-sky-400 transition-colors"
              title="Edit launcher project name"
              aria-label="Edit launcher project name"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M16.862 3.487a2.25 2.25 0 113.182 3.182L8.25 18.465 4.5 19.5l1.035-3.75L16.862 3.487z" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1">
          {project.maps.length > 0 ? (
            <div className="relative flex" ref={mapDropdownRef}>
              <button
                type="button"
                onClick={handleLaunchProject}
                disabled={launchDisabled}
                className="flex-1 px-2 py-1.5 text-xs font-medium rounded-l-md bg-sky-600/80 hover:bg-sky-500/80 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-sky-600/80 border-r border-sky-500/40"
                title="Launches UnrealEditor.exe with the project. Opens the editor."
              >
                {launchDisabled ? 'Launching…' : 'Launch'}
              </button>
              <button
                type="button"
                onClick={() => setDropdownOpen((o) => !o)}
                disabled={launchDisabled}
                className="px-2 py-1.5 rounded-r-md bg-sky-600/80 hover:bg-sky-500/80 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-sky-600/80"
                title="Launches UnrealEditor.exe with the project and a specific map loaded."
                aria-label="Open map selection"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {dropdownOpen && (
                <div className="absolute left-0 right-0 top-full mt-0.5 z-50 rounded-md border border-slate-600/80 bg-[var(--color-bg-card)] shadow-xl max-h-32 overflow-y-auto">
                  {project.maps.map((mapPath) => (
                    <button
                      key={mapPath}
                      type="button"
                      onClick={() => handleLaunchWithMap(mapPath)}
                      className="w-full px-2 py-1.5 text-left text-xs text-slate-200 hover:bg-slate-700/80 hover:text-slate-100 truncate"
                      title={`Launches UnrealEditor.exe with project and map: ${mapPath}`}
                    >
                      {mapDisplayName(mapPath)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={handleLaunchProject}
              disabled={launchDisabled}
              className="w-full px-2 py-1.5 text-xs font-medium rounded-md bg-sky-600/80 hover:bg-sky-500/80 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-sky-600/80"
              title={`Launch ${project.projectName}`}
            >
              {launchDisabled ? 'Launching…' : 'Launch'}
            </button>
          )}

          {project.isCpp && (
            <button
              type="button"
              onClick={handleLaunchSln}
              disabled={launchDisabled}
              className="w-full px-2 py-1.5 text-xs font-medium rounded-md bg-slate-600/80 hover:bg-slate-500/80 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-600/80"
              title={
                ideKind === 'rider'
                  ? 'Opens the project in Rider (.uproject)'
                  : ideKind === 'visual_studio'
                    ? 'Opens the .sln file in Visual Studio'
                    : 'Opens the .sln file in the default IDE'
              }
            >
              {ideButtonLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
