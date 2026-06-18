/**
 * Engines context - shared engine state loaded once at app startup.
 * Merges registry engines with custom engines from settings, filters disabled.
 * Prevents re-scanning when switching tabs.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettings } from '../hooks/useSettings';
import type { EngineEntry } from '../types';

interface EnginesContextValue {
  /** Engines visible in Launcher and dropdowns (excludes disabled) */
  engines: EngineEntry[];
  /** All engines including disabled (for Settings panel - user can re-enable) */
  allEngines: EngineEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
}

const EnginesContext = createContext<EnginesContextValue | null>(null);

export function EnginesProvider({ children }: { children: React.ReactNode }) {
  const { settings, loading: settingsLoading } = useSettings();
  const [engines, setEngines] = useState<EngineEntry[]>([]);
  const [allEngines, setAllEngines] = useState<EngineEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadEngines = useCallback(async () => {
    try {
      setLoading(true);
      const registryEngines = await invoke<EngineEntry[]>('get_installed_engine_paths');
      const disabledSet = new Set(settings.disabledEnginePaths.map(p => p.toLowerCase()));

      const registryMapped = registryEngines.map((e) => ({
        ...e,
        displayName: e.displayName ?? undefined,
        isCustom: false,
        id: e.id ?? e.editorPath,
      }));

      const customEngines: EngineEntry[] = (settings.customEngines ?? [])
        .filter((c) => c.enabled !== false)
        .map((c) => ({
          version: c.version,
          editorPath: c.editorPath,
          displayName: c.displayName,
          isCustom: true,
          id: c.id,
        }));

      // Deduplicate: If a custom engine has the same editorPath as a registry engine,
      // we prefer the custom one (it might have a custom name).
      const customPaths = new Set(customEngines.map((c) => c.editorPath.toLowerCase()));
      const filteredRegistry = registryMapped.filter((r) => {
        const isDuplicate = customPaths.has(r.editorPath.toLowerCase());
        return !isDuplicate;
      });

      const allMerged = [...filteredRegistry, ...customEngines];

      // Final deduplication by editorPath to ensure no duplicates at all (case-insensitive)
      const uniqueEnginesMap = new Map<string, EngineEntry>();
      allMerged.forEach(e => {
        const key = e.editorPath.toLowerCase();
        // If we already have it, prefer the one with a display name or the custom one
        if (uniqueEnginesMap.has(key)) {
          const existing = uniqueEnginesMap.get(key)!;
          if (e.isCustom && !existing.isCustom) {
            uniqueEnginesMap.set(key, e);
          } else if (e.displayName && !existing.displayName) {
            uniqueEnginesMap.set(key, e);
          }
        } else {
          uniqueEnginesMap.set(key, e);
        }
      });

      const deduplicatedAll = Array.from(uniqueEnginesMap.values());

      const filtered = deduplicatedAll.filter((e) => {
        // Use lowercase for case-insensitive comparison on Windows
        return !disabledSet.has(e.editorPath.toLowerCase());
      });
      setEngines(filtered);
      setAllEngines(deduplicatedAll);
    } catch {
      setEngines([]);
      setAllEngines([]);
    } finally {
      setLoading(false);
    }
  }, [settings.customEngines, settings.disabledEnginePaths]);

  useEffect(() => {
    if (settingsLoading) return;
    loadEngines();
  }, [loadEngines, settingsLoading]);

  return (
    <EnginesContext.Provider value={{ engines, allEngines, loading, refresh: loadEngines }}>
      {children}
    </EnginesContext.Provider>
  );
}

export function useEnginesContext() {
  const ctx = useContext(EnginesContext);
  if (!ctx) throw new Error('useEnginesContext must be used within EnginesProvider');
  return ctx;
}
