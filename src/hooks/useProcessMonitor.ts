/**
 * Reusable hook for process monitoring.
 * Use with predefined groups (e.g. "regenerate") to check if blocking processes are running.
 */

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ProcessStatus } from '../types';
import { useAppActivity } from './useAppActivity';

export function useProcessMonitor(groupName: string, pollIntervalMs = 1500, enabled = true) {
  const [statuses, setStatuses] = useState<ProcessStatus[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isAppActive = useAppActivity();

  useEffect(() => {
    if (!enabled || !isAppActive) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const checkProcesses = async () => {
      try {
        const result = await invoke<ProcessStatus[]>('get_process_status', {
          groupName,
        });
        if (!cancelled) {
          setStatuses((prev) => {
            if (prev.length === result.length) {
              const unchanged = prev.every((p, idx) => {
                const n = result[idx];
                return (
                  n &&
                  p.id === n.id &&
                  p.displayName === n.displayName &&
                  p.isRunning === n.isRunning &&
                  p.pids.length === n.pids.length &&
                  p.pids.every((pid, i) => pid === n.pids[i])
                );
              });
              if (unchanged) return prev;
            }
            return result;
          });
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setStatuses([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    checkProcesses();
    const interval = setInterval(checkProcesses, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [groupName, pollIntervalMs, isAppActive, enabled]);

  const runningProcesses = useMemo(() => statuses.filter((s) => s.isRunning), [statuses]);
  const hasBlockingProcesses = runningProcesses.length > 0;

  return {
    statuses,
    runningProcesses,
    hasBlockingProcesses,
    loading,
    error,
  };
}
