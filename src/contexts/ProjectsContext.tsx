/**
 * Projects context - shared project state loaded once at app startup.
 * Prevents re-scanning when switching tabs (LauncherTab unmounts/remounts).
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ProjectInfo } from '../types';
import { getStore } from '../hooks/useStore';
import { STORE_KEYS } from '../config';

interface ProjectsContextValue {
  projects: ProjectInfo[];
  loading: boolean;
  refreshing: boolean;
  refreshProgress: {
    completed: number;
    total: number;
    currentProjectPath: string | null;
  };
  error: string | null;
  addProject: (project: ProjectInfo) => Promise<void>;
  removeProject: (projectPath: string) => Promise<void>;
  updateProject: (projectPath: string, updates: Partial<ProjectInfo>) => Promise<void>;
  refresh: () => Promise<void>;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState({
    completed: 0,
    total: 0,
    currentProjectPath: null as string | null,
  });
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async (deepRefresh = false) => {
    try {
      if (deepRefresh) {
        setRefreshing(true);
        setRefreshProgress({ completed: 0, total: 0, currentProjectPath: null });
      } else {
        setLoading(true);
      }
      setError(null);
      const store = await getStore();
      const stored = (await store.get<ProjectInfo[]>(STORE_KEYS.PROJECTS)) ?? [];
      if (stored.length === 0) {
        setProjects([]);
        return;
      }

      const paths = stored.map((p) => p.projectPath);
      const existingPaths = await invoke<string[]>('filter_existing_paths', { paths });
      const existingSet = new Set(existingPaths);
      const valid = stored.filter((p) => existingSet.has(p.projectPath));

      if (valid.length < stored.length) {
        await store.set(STORE_KEYS.PROJECTS, valid);
      }

      if (!deepRefresh) {
        setProjects(valid);
        return;
      }

      // Re-check project engine/version data on deep refresh so UI reflects .uproject changes.
      // If an existing engine path disappeared, force re-analysis as well.
      const enginePathsToCheck = [...new Set(
        valid
          .filter((p) => p.engineInstallPath && p.engineInstallPath !== 'Unknown')
          .map((p) => p.engineInstallPath)
      )];

      const existingEnginePaths =
        enginePathsToCheck.length > 0
          ? await invoke<string[]>('filter_existing_paths', { paths: enginePathsToCheck })
          : [];

      const existingEngineSet = new Set(existingEnginePaths);

      const withValidEngines = await Promise.all(
        valid.map(async (p) => {
          const enginePathMissing =
            p.engineInstallPath &&
            p.engineInstallPath !== 'Unknown' &&
            !existingEngineSet.has(p.engineInstallPath);

          try {
            return await invoke<ProjectInfo>('analyse_uproject', {
              path: p.projectPath,
            });
          } catch {
            if (enginePathMissing) {
              return { ...p, engineInstallPath: 'Unknown' };
            }
            return p;
          }
        })
      );

      // Publish engine-corrected projects immediately; map scan updates arrive incrementally.
      setProjects(withValidEngines);
      setRefreshProgress({
        completed: 0,
        total: withValidEngines.length,
        currentProjectPath: withValidEngines[0]?.projectPath ?? null,
      });

      const updated = [...withValidEngines];
      for (let i = 0; i < withValidEngines.length; i++) {
        const p = withValidEngines[i];
        setRefreshProgress({
          completed: i,
          total: withValidEngines.length,
          currentProjectPath: p.projectPath,
        });
        try {
          const freshMaps = await invoke<string[]>('scan_project_maps', {
            projectPath: p.projectPath,
          });
          const currentMaps = p.maps ?? [];
          const mapsChanged =
            freshMaps.length !== currentMaps.length ||
            freshMaps.some((m, idx) => m !== currentMaps[idx]);
          if (mapsChanged) {
            updated[i] = { ...p, maps: freshMaps };
            setProjects([...updated]);
          }
        } catch {
          // keep existing maps on scan failure
        }
        setRefreshProgress({
          completed: i + 1,
          total: withValidEngines.length,
          currentProjectPath:
            i + 1 < withValidEngines.length ? withValidEngines[i + 1].projectPath : null,
        });
      }

      const anyMapsChanged = updated.some((p, i) => p.maps !== withValidEngines[i].maps);
      const anyEngineChanged = withValidEngines.some(
        (p, i) =>
          p.engineInstallPath !== valid[i].engineInstallPath ||
          p.engineVersion !== valid[i].engineVersion
      );

      if (anyMapsChanged || anyEngineChanged) {
        await store.set(STORE_KEYS.PROJECTS, updated);
      }

      setProjects(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
      if (!deepRefresh) {
        setProjects([]);
      }
    } finally {
      if (deepRefresh) {
        setRefreshing(false);
        setRefreshProgress((prev) => ({ ...prev, currentProjectPath: null }));
      } else {
        setLoading(false);
      }
    }
  }, []);

  // Load projects once when app starts (fast path: keep startup cheap)
  useEffect(() => {
    loadProjects(false);
  }, [loadProjects]);

  const refreshProjects = useCallback(async () => {
    await loadProjects(true);
  }, [loadProjects]);

  const addProject = useCallback(async (project: ProjectInfo) => {
    const store = await getStore();
    const current = (await store.get<ProjectInfo[]>(STORE_KEYS.PROJECTS)) ?? [];
    if (current.some((p) => p.projectPath === project.projectPath)) {
      return;
    }
    const updated = [...current, project];
    await store.set(STORE_KEYS.PROJECTS, updated);
    setProjects(updated);
  }, []);

  const removeProject = useCallback(async (projectPath: string) => {
    const store = await getStore();
    const current = (await store.get<ProjectInfo[]>(STORE_KEYS.PROJECTS)) ?? [];
    const updated = current.filter((p) => p.projectPath !== projectPath);
    await store.set(STORE_KEYS.PROJECTS, updated);
    setProjects(updated);
  }, []);

  const updateProject = useCallback(
    async (projectPath: string, updates: Partial<ProjectInfo>) => {
      const store = await getStore();
      const current = (await store.get<ProjectInfo[]>(STORE_KEYS.PROJECTS)) ?? [];
      const updated = current.map((p) =>
        p.projectPath === projectPath ? { ...p, ...updates } : p
      );
      await store.set(STORE_KEYS.PROJECTS, updated);
      setProjects(updated);
    },
    []
  );

  return (
    <ProjectsContext.Provider
      value={{
        projects,
        loading,
        refreshing,
        refreshProgress,
        error,
        addProject,
        removeProject,
        updateProject,
        refresh: refreshProjects,
      }}
    >
      {children}
    </ProjectsContext.Provider>
  );
}

export function useProjectsContext() {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error('useProjectsContext must be used within ProjectsProvider');
  return ctx;
}
