/**
 * Hook for Include & Module Finder state, search, and indexing operations.
 */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useProjects } from './useProjects';
import { useEngines } from './useEngines';
import { getShortEngineVersion } from '../utils/project';
import type {
  IncludeEntry,
  IndexStatus,
  ScanProgressPayload,
  SearchFilterOptions,
} from '../types/includeFinder';
import type { ProjectInfo, EngineEntry } from '../types';

export function useIncludeFinder() {
  const { projects } = useProjects();
  const { engines, allEngines } = useEngines();

  const [selectedProjectPath, setSelectedProjectPath] = useState<string>(() => {
    return projects.length > 0 ? projects[0].projectPath : '';
  });

  // Keep selectedProjectPath valid if projects change
  useEffect(() => {
    if (projects.length > 0 && !projects.some((p) => p.projectPath === selectedProjectPath)) {
      setSelectedProjectPath(projects[0].projectPath);
    }
  }, [projects, selectedProjectPath]);

  const selectedProject: ProjectInfo | undefined = useMemo(() => {
    return projects.find((p) => p.projectPath === selectedProjectPath);
  }, [projects, selectedProjectPath]);

  // Deduce attached engine version and installation path
  const { engineVersion, engineRoot } = useMemo(() => {
    if (!selectedProject) {
      return { engineVersion: '', engineRoot: '' };
    }

    const version = selectedProject.engineVersion || '';
    let installPath = selectedProject.engineInstallPath || '';

    const normalizePath = (p?: string) => (p || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
    const cleanInstallPath = normalizePath(installPath);
    const cleanGuid = version.replace(/[{}]/g, '').toLowerCase();

    // Match engine from engines list
    const findEngine = (list: EngineEntry[]) => {
      // 1. By editor path
      if (cleanInstallPath && cleanInstallPath !== 'unknown') {
        const byPath = list.find((e) => normalizePath(e.editorPath) === cleanInstallPath);
        if (byPath) return byPath;
      }
      // 2. By ID / GUID
      if (cleanGuid) {
        const byId = list.find((e) => e.id && e.id.replace(/[{}]/g, '').toLowerCase() === cleanGuid);
        if (byId) return byId;
      }
      // 3. By exact version
      if (version && version !== 'Unknown') {
        const byVer = list.find((e) => e.version.toLowerCase() === version.toLowerCase());
        if (byVer) return byVer;
      }
      // 4. By short version (e.g. 5.4 matches 5.4.4)
      const short = getShortEngineVersion(version);
      if (short && short !== 'Unknown') {
        const byShort = list.find((e) => getShortEngineVersion(e.version) === short);
        if (byShort) return byShort;
      }
      // 5. By major version (e.g. 5 matches 5.4.4)
      if (/^\d+$/.test(version)) {
        const byMajor = list.find((e) => e.version.startsWith(`${version}.`));
        if (byMajor) return byMajor;
      }
      return undefined;
    };

    const matchedEngine = findEngine(engines) || findEngine(allEngines);

    if (matchedEngine) {
      if (!installPath || installPath === 'Unknown') {
        installPath = matchedEngine.editorPath;
      }
    }

    // Convert editorPath (e.g., C:/Epic/UE_5.4/Engine/Binaries/Win64/UnrealEditor.exe) to root (C:/Epic/UE_5.4)
    let root = installPath;
    const lowerPath = root.toLowerCase().replace(/\\/g, '/');
    const binIdx = lowerPath.indexOf('/engine/binaries/');
    if (binIdx !== -1) {
      root = root.substring(0, binIdx);
    }

    const resolvedVersion = matchedEngine
      ? getShortEngineVersion(matchedEngine.version)
      : getShortEngineVersion(version);

    return {
      engineVersion: resolvedVersion || (matchedEngine ? matchedEngine.version : version || 'Unknown'),
      engineRoot: root,
    };
  }, [selectedProject, engines, allEngines]);

  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [isScanningEngine, setIsScanningEngine] = useState(false);
  const [isScanningProject, setIsScanningProject] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterOptions, setFilterOptions] = useState<SearchFilterOptions>({
    includeEngine: true,
    includeEnginePlugins: true,
    includeProject: true,
    includeProjectPlugins: true,
  });

  const [results, setResults] = useState<IncludeEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const searchDebounceTimerRef = useRef<number | null>(null);

  // Load index status
  const loadStatus = useCallback(async () => {
    if (!engineVersion && !selectedProjectPath) {
      setIndexStatus(null);
      return;
    }

    try {
      setStatusLoading(true);
      setError(null);
      const status = await invoke<IndexStatus>('get_include_index_status', {
        engineVersion: engineVersion || '',
        projectPath: selectedProjectPath || null,
      });
      setIndexStatus(status);
    } catch (err) {
      console.error('Failed to get include index status:', err);
      setError(String(err));
    } finally {
      setStatusLoading(false);
    }
  }, [engineVersion, selectedProjectPath]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Listen to scan progress events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ScanProgressPayload>('include-finder:progress', (event) => {
      setScanProgress(event.payload);
    }).then((unsub) => {
      unlisten = unsub;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Scan engine includes
  const scanEngine = useCallback(async () => {
    if (!engineRoot || !engineVersion) {
      setError('Engine root path or version could not be resolved.');
      return;
    }

    try {
      setIsScanningEngine(true);
      setError(null);
      setScanProgress({ stage: 'discovering_modules', currentCount: 0 });
      const status = await invoke<IndexStatus>('scan_engine_includes', {
        engineRoot,
        engineVersion,
      });
      setIndexStatus((prev) => ({
        ...(prev || {
          engineVersion,
          engineIndexed: false,
          engineHeaderCount: 0,
          engineModuleCount: 0,
          projectIndexed: false,
          projectHeaderCount: 0,
          projectModuleCount: 0,
        }),
        ...status,
      }));
    } catch (err) {
      console.error('Failed to scan engine includes:', err);
      setError(String(err));
    } finally {
      setIsScanningEngine(false);
      setScanProgress(null);
      void loadStatus();
    }
  }, [engineRoot, engineVersion, loadStatus]);

  // Scan project includes
  const scanProject = useCallback(async () => {
    if (!selectedProjectPath) {
      setError('No project selected to scan.');
      return;
    }

    try {
      setIsScanningProject(true);
      setError(null);
      setScanProgress({ stage: 'discovering_modules', currentCount: 0 });
      const status = await invoke<IndexStatus>('scan_project_includes', {
        projectPath: selectedProjectPath,
      });
      setIndexStatus((prev) => ({
        ...(prev || {
          engineVersion,
          engineIndexed: false,
          engineHeaderCount: 0,
          engineModuleCount: 0,
          projectIndexed: false,
          projectHeaderCount: 0,
          projectModuleCount: 0,
        }),
        ...status,
      }));
    } catch (err) {
      console.error('Failed to scan project includes:', err);
      setError(String(err));
    } finally {
      setIsScanningProject(false);
      setScanProgress(null);
      void loadStatus();
    }
  }, [selectedProjectPath, engineVersion, loadStatus]);

  // Clear engine index
  const clearEngineIndex = useCallback(async () => {
    if (!engineVersion) return;
    try {
      setError(null);
      await invoke('clear_engine_include_index', { engineVersion });
      await loadStatus();
    } catch (err) {
      console.error('Failed to clear engine index:', err);
      setError(String(err));
    }
  }, [engineVersion, loadStatus]);

  const searchRequestIdRef = useRef<number>(0);

  // Execute search
  const performSearch = useCallback(
    async (query: string, filters: SearchFilterOptions) => {
      const trimmed = query.trim();
      if (!trimmed) {
        startTransition(() => {
          setResults([]);
          setSearching(false);
        });
        return;
      }

      const scopes: string[] = [];
      if (filters.includeEngine) scopes.push('engine');
      if (filters.includeEnginePlugins) scopes.push('engine_plugin');
      if (filters.includeProject) scopes.push('project');
      if (filters.includeProjectPlugins) scopes.push('project_plugin');

      if (scopes.length === 0) {
        startTransition(() => {
          setResults([]);
          setSearching(false);
        });
        return;
      }

      const currentReqId = ++searchRequestIdRef.current;
      setSearching(true);

      try {
        const searchResults = await invoke<IncludeEntry[]>('search_includes', {
          query: trimmed,
          engineVersion: indexStatus?.engineIndexed ? engineVersion : null,
          projectPath: indexStatus?.projectIndexed ? selectedProjectPath : null,
          scopes,
          limit: 150,
        });

        // Only commit results if this is still the latest search request
        if (searchRequestIdRef.current === currentReqId) {
          startTransition(() => {
            setResults(searchResults);
          });
        }
      } catch (err) {
        console.error('Failed to search includes:', err);
        if (searchRequestIdRef.current === currentReqId) {
          startTransition(() => {
            setResults([]);
          });
        }
      } finally {
        if (searchRequestIdRef.current === currentReqId) {
          setSearching(false);
        }
      }
    },
    [engineVersion, selectedProjectPath, indexStatus?.engineIndexed, indexStatus?.projectIndexed]
  );

  // Debounced search trigger (250ms debounce prevents typing freezes)
  useEffect(() => {
    if (searchDebounceTimerRef.current) {
      window.clearTimeout(searchDebounceTimerRef.current);
    }

    if (!searchQuery.trim()) {
      startTransition(() => {
        setResults([]);
        setSearching(false);
      });
      return;
    }

    searchDebounceTimerRef.current = window.setTimeout(() => {
      void performSearch(searchQuery, filterOptions);
    }, 250);

    return () => {
      if (searchDebounceTimerRef.current) {
        window.clearTimeout(searchDebounceTimerRef.current);
      }
    };
  }, [searchQuery, filterOptions, performSearch]);

  // Clipboard copy helpers
  const copyInclude = useCallback(async (entry: IncludeEntry): Promise<boolean> => {
    try {
      const text = `#include "${entry.includePath}"`;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }, []);

  const copyModule = useCallback(async (entry: IncludeEntry): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(entry.moduleName);
      return true;
    } catch {
      return false;
    }
  }, []);

  const copyBoth = useCallback(async (entry: IncludeEntry): Promise<boolean> => {
    try {
      const text = `#include "${entry.includePath}" // Module: ${entry.moduleName}`;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }, []);

  const openFileInIde = useCallback(async (entry: IncludeEntry) => {
    try {
      await invoke('open_file', { path: entry.filePath });
    } catch (err) {
      console.error('Failed to open file in IDE:', err);
    }
  }, []);

  const openFolderInExplorer = useCallback(async (entry: IncludeEntry) => {
    try {
      await invoke('open_folder_in_explorer', { path: entry.filePath });
    } catch (err) {
      console.error('Failed to reveal file in explorer:', err);
    }
  }, []);

  return {
    projects,
    selectedProjectPath,
    setSelectedProjectPath,
    selectedProject,
    engineVersion,
    engineRoot,
    indexStatus,
    statusLoading,
    isScanningEngine,
    isScanningProject,
    scanProgress,
    error,
    searchQuery,
    setSearchQuery,
    filterOptions,
    setFilterOptions,
    results,
    searching,
    scanEngine,
    scanProject,
    clearEngineIndex,
    refreshStatus: loadStatus,
    copyInclude,
    copyModule,
    copyBoth,
    openFileInIde,
    openFolderInExplorer,
  };
}
