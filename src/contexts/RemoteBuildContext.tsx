import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { remoteBuildCheckoutPath, remoteBuildOutputPath, useRemoteBuildProfiles } from '../hooks/useRemoteBuildProfiles';
import { STORE_KEYS } from '../config';
import { getStore } from '../hooks/useStore';
import { useLog } from './LogContext';
import { useProgress } from './ProgressContext';
import type { CheckoutStatus, EngineEntry, RemoteBuildProfile, RemoteBuildRun } from '../types';
import { RemoteBuildContext } from './RemoteBuildContextState';

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 35_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)),
  ]);
}

function checkoutPathForLog(repositoryPath: string) {
  return remoteBuildCheckoutPath(repositoryPath);
}

function resolveDetectedProject(status: CheckoutStatus, configuredPath: string) {
  if (configuredPath && status.projects.some((project) => project.projectPath === configuredPath)) return configuredPath;
  if (status.projects.length === 1) return status.projects[0].projectPath;
  if (status.projects.length === 0) throw new Error('No .uproject file was found in the checked-out repository.');
  throw new Error('Multiple .uproject files were found; select one project before packaging.');
}

function resolveDetectedEngine(projectPath: string, status: CheckoutStatus, engines: EngineEntry[], configuredPath: string) {
  if (configuredPath) return configuredPath;
  const project = status.projects.find((candidate) => candidate.projectPath === projectPath);
  const association = project?.engineVersion?.trim();
  if (!association || association === 'Unknown') throw new Error('The selected .uproject does not specify an EngineAssociation.');
  const normalizedAssociation = association.toLowerCase();
  const engine = engines.find((candidate) => {
    const version = candidate.version.toLowerCase();
    const id = candidate.id?.toLowerCase();
    return version === normalizedAssociation || version.startsWith(`${normalizedAssociation}.`) || id === normalizedAssociation || id === `{${normalizedAssociation}}` || (normalizedAssociation.startsWith('{') && normalizedAssociation.endsWith('}') && id === normalizedAssociation.slice(1, -1));
  });
  if (!engine) throw new Error(`No installed Unreal Engine matches EngineAssociation '${association}'.`);
  return engine.editorPath;
}

export function RemoteBuildProvider({ children }: { children: React.ReactNode }) {
  const { profiles, updateProfile, appendLog, refresh } = useRemoteBuildProfiles();
  const inFlight = useRef(false);
  const batchRunning = useRef(false);
  const scheduleNextRef = useRef<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [scheduleNextAt, setScheduleNextAt] = useState<string | undefined>();
  const [scheduleRunning, setScheduleRunning] = useState(false);
  const [scheduleIntervalMinutes, setScheduleIntervalMinutesState] = useState(1);
  const { appendLine } = useLog();
  const { startProgress, finishProgress } = useProgress();

  useEffect(() => {
    void getStore().then(async (store) => {
      const storedNext = await store.get<string>(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT);
      const storedInterval = await store.get<number>(STORE_KEYS.REMOTE_BUILD_POLLING_INTERVAL);
      setScheduleIntervalMinutesState(storedInterval === 5 || storedInterval === 10 ? storedInterval : 1);
      if (storedNext && Date.parse(storedNext) > Date.now()) {
        scheduleNextRef.current = storedNext;
        setScheduleNextAt(storedNext);
      }
    });
  }, []);

  const setScheduleIntervalMinutes = useCallback(async (minutes: number) => {
    const interval = minutes === 5 || minutes === 10 ? minutes : 1;
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_POLLING_INTERVAL, interval);
    setScheduleIntervalMinutesState(interval);
    if (!batchRunning.current) {
      const next = new Date(Date.now() + interval * 60_000).toISOString();
      scheduleNextRef.current = next;
      setScheduleNextAt(next);
      await store.set(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT, next);
    }
  }, []);

  const checkProfile = useCallback(async (profile: RemoteBuildProfile, runBuild = true, force = false, batchInvocation = false) => {
    if (inFlight.current || (!batchInvocation && batchRunning.current) || !profile.repositoryPath || !profile.buildBranch || profile.cloneStatus !== 'ready' || (!profile.enabled && !force)) return;
    inFlight.current = true;
    setChecking(true);
    if (!batchInvocation) {
      startProgress({ showOutputLog: true });
    }
    const checkedAt = new Date().toISOString();
    try {
      const log = (message: string) => {
        console.info(`[automatic-build] ${profile.name}: ${message}`);
        appendLine({ line: `[${profile.name}] ${message}`, color: message.includes('failed') || message.includes('blocked') ? 'red' : message.includes('successfully') ? 'green' : 'blue' });
        return appendLog(profile.id, message);
      };

      await updateProfile(profile.id, { lastStatus: 'checking', lastCheckedAt: checkedAt });
      await log(`check started: branch='${profile.buildBranch}', checkout='${checkoutPathForLog(profile.repositoryPath)}'`);
      const checkoutPath = remoteBuildCheckoutPath(profile.repositoryPath);
      const remoteName = profile.remoteName || 'origin';

      // Step 1: Pre-check inspection
      await log('checking local checkout branch and worktree');
      const initialStatus = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', { repositoryPath: checkoutPath, remoteName, buildBranch: profile.buildBranch }), 'Checkout inspection');
      await log(`local checkout check completed: branch='${initialStatus.currentBranch ?? '(unknown)'}', clean=${initialStatus.worktreeClean && initialStatus.indexClean}`);

      const safe = initialStatus.currentBranch === profile.buildBranch && initialStatus.worktreeClean && initialStatus.indexClean;
      if (!safe) {
        await log('check blocked: checkout is on the wrong branch or has local changes');
        await updateProfile(profile.id, {
          safetyStatus: initialStatus.currentBranch !== profile.buildBranch ? 'wrong-branch' : 'local-changes',
          lastStatus: 'blocked',
          lastError: 'The checkout must stay on the configured branch with a clean worktree and index.'
        });
        return;
      }

      // Step 2: Fetch remote branch
      await updateProfile(profile.id, { lastStatus: 'fetching', lastError: undefined });
      await log(`fetching '${remoteName}/${profile.buildBranch}'`);
      const fetch = await withTimeout(invoke<{ ok: boolean; error?: string }>('fetch_remote_build_branch', {
        repositoryPath: checkoutPath,
        remoteName,
        buildBranch: profile.buildBranch
      }), 'Git fetch', 130_000);

      await log(fetch.ok ? 'fetch completed' : `fetch failed: ${fetch.error ?? 'unknown error'}`);
      if (!fetch.ok) {
        await updateProfile(profile.id, { safetyStatus: 'unknown', lastStatus: 'failed', lastError: fetch.error ?? 'Git fetch failed.' });
        return;
      }

      // Step 3: Inspect checkout post-fetch
      const refreshed = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', {
        repositoryPath: checkoutPath,
        remoteName,
        buildBranch: profile.buildBranch
      }), 'Post-fetch checkout inspection');

      if (!refreshed.result.ok || !refreshed.remoteCommit) {
        await log(`post-fetch inspection failed: ${refreshed.result.error ?? 'remote commit missing'}`);
        await updateProfile(profile.id, { safetyStatus: 'unknown', lastStatus: 'failed', lastError: refreshed.result.error ?? 'The remote branch could not be read after fetching.' });
        return;
      }

      const remoteCommit = refreshed.remoteCommit;
      const headCommit = refreshed.headCommit;
      const isBehind = refreshed.isBehind || (Boolean(headCommit && remoteCommit) && headCommit !== remoteCommit);

      await log(`post-fetch checkout check: local='${headCommit?.slice(0, 12) ?? '(unknown)'}', remote='${remoteCommit.slice(0, 12)}', behind=${isBehind ? `${refreshed.behindCount || 1} commit(s)` : 'no'}`);
      await updateProfile(profile.id, { safetyStatus: 'clean-on-build-branch', lastRemoteCommit: remoteCommit, lastError: undefined });

      // Step 4: If local is NOT behind and this is not a force-build
      if (!isBehind && (!force || remoteCommit === profile.lastBuiltCommit)) {
        await log(`check completed: local branch '${profile.buildBranch}' is up to date (${headCommit?.slice(0, 12) ?? remoteCommit.slice(0, 12)})`);
        await updateProfile(profile.id, { lastStatus: 'idle', lastError: undefined });
        return;
      }

      // Step 5: Pull changes
      await updateProfile(profile.id, { lastStatus: 'pulling' });
      await log(`updating checkout to commit '${remoteCommit.slice(0, 12)}'`);
      const updated = await withTimeout(invoke<{ ok: boolean; error?: string }>('update_remote_build_checkout', {
        repositoryPath: checkoutPath,
        buildBranch: profile.buildBranch,
        targetCommit: remoteCommit
      }), 'Checkout update', 60_000);

      await log(updated.ok ? 'checkout update completed' : `checkout update failed: ${updated.error ?? 'unknown error'}`);
      if (!updated.ok) {
        await updateProfile(profile.id, { lastStatus: 'failed', lastError: updated.error ?? 'Checkout update failed.' });
        return;
      }

      // Step 6: Post-pull inspection and Project / Engine resolution
      const postPullStatus = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', {
        repositoryPath: checkoutPath,
        remoteName,
        buildBranch: profile.buildBranch
      }), 'Post-pull inspection');

      let projectPath = profile.projectPath;
      let enginePath = profile.enginePath;
      try {
        projectPath = resolveDetectedProject(postPullStatus, projectPath);
        const engines = await withTimeout(invoke<EngineEntry[]>('get_installed_engine_paths'), 'Engine discovery');
        enginePath = resolveDetectedEngine(projectPath, postPullStatus, engines, enginePath);
        if (projectPath !== profile.projectPath || enginePath !== profile.enginePath) {
          await updateProfile(profile.id, { projectPath, enginePath, setupStatus: 'passed', lastError: undefined });
          await log(`project resolved: '${projectPath}'`);
          await log(`engine resolved: '${enginePath}'`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await log(`packaging setup failed: ${message}`);
        await updateProfile(profile.id, { setupStatus: 'failed', lastStatus: 'failed', lastError: message });
        return;
      }

      // Step 7: Packaging
      if (!runBuild) {
        await log('checkout updated without packaging (runBuild=false)');
        await updateProfile(profile.id, { lastStatus: 'idle', lastError: undefined });
        return;
      }

      const run: RemoteBuildRun = { id: crypto.randomUUID(), commit: remoteCommit, startedAt: new Date().toISOString(), status: 'running' };
      await updateProfile(profile.id, {
        lastStatus: 'running',
        buildProgress: 0,
        lastRunAt: run.startedAt,
        buildHistory: [run, ...profile.buildHistory].slice(0, 50)
      });
      await log(`packaging started: project='${projectPath}', platform='${profile.platform}', configuration='${profile.packageConfig}'`);

      let packageError: string | undefined;
      let packageSuccess = false;
      try {
        await invoke('run_package', {
          projectPath,
          platform: profile.platform,
          clientConfig: profile.packageConfig,
          archiveDirectory: remoteBuildOutputPath(profile.repositoryPath, remoteCommit),
          enginePath,
          bumpProjectVersion: false,
          projectVersion: null,
        });
        packageSuccess = true;
      } catch (err) {
        packageError = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      }

      const completedAt = new Date().toISOString();
      const finalRun = {
        ...run,
        completedAt,
        status: packageSuccess ? ('success' as const) : ('failed' as const),
        error: packageError,
      };

      if (packageSuccess) {
        await log('packaging completed successfully');
        await updateProfile(profile.id, {
          lastStatus: 'success',
          buildProgress: 100,
          lastBuiltCommit: remoteCommit,
          lastError: undefined,
          buildHistory: [finalRun, ...profile.buildHistory].slice(0, 50)
        });
      } else {
        await log(`packaging failed: ${packageError ?? 'unknown error'}`);
        await updateProfile(profile.id, {
          lastStatus: 'failed',
          buildProgress: undefined,
          lastError: packageError ?? 'Packaging failed.',
          buildHistory: [finalRun, ...profile.buildHistory].slice(0, 50)
        });
      }
    } catch (error) {
      console.error('[automatic-build] check failed', error);
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(profile.id, `check failed unexpectedly: ${message}`);
      await updateProfile(profile.id, { lastStatus: 'failed', buildProgress: undefined, lastError: message });
    } finally {
      inFlight.current = false;
      setChecking(false);
      if (!batchInvocation) {
        finishProgress();
      }
    }
  }, [appendLine, appendLog, finishProgress, startProgress, updateProfile]);

  const pullNow = useCallback((profile: RemoteBuildProfile) => checkProfile(profile, true, true), [checkProfile]);

  useEffect(() => {
    const unlisten = listen<{ percent: number }>('progress-update', (event) => {
      const runningProfile = profiles.find((profile) => profile.lastStatus === 'running');
      if (runningProfile) void updateProfile(runningProfile.id, { buildProgress: Math.max(0, Math.min(100, event.payload.percent)) });
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [profiles, updateProfile]);

  useEffect(() => {
    const unlisten = listen<{ line: string; color?: 'green' | 'red' | 'orange' | 'blue' | 'white' | 'gray' }>('log-output', (event) => {
      appendLine({ line: event.payload.line, color: event.payload.color });
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [appendLine]);

  // The interval below must be created exactly once. Previously it was
  // recreated (clearInterval + setInterval) whenever any of its dependencies
  // (appendLine, checkProfile, refresh, ...) changed identity, which happens
  // on effectively every render if those callbacks aren't memoized upstream.
  // If re-renders happen more often than once a second, the interval could
  // be torn down before its 1000ms ever elapsed, so the scheduled build
  // would silently never fire even though the UI showed "Idle (Scheduled)".
  // Routing the tick logic through a ref sidesteps that: the ref is updated
  // with the latest closures every render, but the interval itself never
  // gets rebuilt.
  // Tauri's store plugin `set` command requires an actual `value` argument.
  // Calling `.set(key, undefined)` gets its `value` key stripped by
  // JSON.stringify and the Rust side rejects it ("missing required key
  // value"). That rejection previously happened *outside* any try/catch,
  // right after `batchRunning.current = true` was set, which permanently
  // stuck `batchRunning` at `true` and silently killed the scheduler for
  // the rest of the session. This helper avoids ever passing `undefined`,
  // and swallows/logs any persistence failure so it can never break
  // scheduling again.
  const persistScheduleNext = useCallback(async (value: string | undefined) => {
    try {
      const store = await getStore();
      if (value === undefined) {
        if (typeof (store as { delete?: (key: string) => Promise<unknown> }).delete === 'function') {
          await (store as { delete: (key: string) => Promise<unknown> }).delete(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT);
        }
        // If `delete` isn't available on this store implementation, skip
        // persisting the "cleared" state rather than crashing the tick —
        // a stale timestamp left behind is harmless since it's always
        // validated against the current time before use.
      } else {
        await store.set(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT, value);
      }
    } catch (error) {
      console.warn('[automatic-build] failed to persist schedule state', error);
    }
  }, []);

  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    void refresh().then(async (latestProfiles) => {
      const enabledProfiles = latestProfiles.filter((profile) => profile.enabled && profile.cloneStatus === 'ready');
      console.info(`[automatic-build] schedule tick: enabled=${enabledProfiles.length}, batchRunning=${batchRunning.current}, inFlight=${inFlight.current}, next=${scheduleNextRef.current ?? '(none)'}`);
      if (enabledProfiles.length === 0) {
        if (scheduleNextRef.current !== undefined) {
          scheduleNextRef.current = undefined;
          setScheduleNextAt(undefined);
          await persistScheduleNext(undefined);
        }
        return;
      }
      if (batchRunning.current || inFlight.current) return;

      const now = Date.now();
      const next = scheduleNextRef.current;
      if (!next) {
        const initial = new Date(now + scheduleIntervalMinutes * 60_000).toISOString();
        scheduleNextRef.current = initial;
        setScheduleNextAt(initial);
        await persistScheduleNext(initial);
        return;
      }

      if (Date.parse(next) > now) return;

      batchRunning.current = true;
      setScheduleRunning(true);
      scheduleNextRef.current = undefined;
      setScheduleNextAt(undefined);

      // Everything from here on is inside try/finally, so no matter what
      // throws (a store error, an invoke error, anything) batchRunning is
      // guaranteed to be released and the scheduler can't get stuck again.
      try {
        await persistScheduleNext(undefined);
        startProgress({ showOutputLog: true });
        appendLine({ line: `Automatic build schedule started: ${enabledProfiles.length} enabled job(s).`, color: 'blue' });
        for (const profile of enabledProfiles) {
          console.info(`[automatic-build] schedule: invoking checkProfile for '${profile.name}'`);
          await checkProfile(profile, true, false, true);
        }
        appendLine({ line: 'Automatic build schedule check cycle completed.', color: 'green' });
      } catch (error) {
        console.error('[automatic-build] schedule cycle failed', error);
        appendLine({ line: `Automatic build schedule failed: ${error instanceof Error ? error.message : String(error)}`, color: 'red' });
      } finally {
        finishProgress();
        batchRunning.current = false;
        setScheduleRunning(false);
        const restarted = new Date(Date.now() + scheduleIntervalMinutes * 60_000).toISOString();
        scheduleNextRef.current = restarted;
        setScheduleNextAt(restarted);
        await persistScheduleNext(restarted);
      }
    });
  };

  useEffect(() => {
    console.info('[automatic-build] schedule interval mounted');
    const timer = window.setInterval(() => tickRef.current(), 1000);
    return () => {
      console.info('[automatic-build] schedule interval unmounted');
      window.clearInterval(timer);
    };
  }, []);

  return <RemoteBuildContext.Provider value={{ checkProfile, pullNow, checking, scheduleNextAt, scheduleRunning, scheduleIntervalMinutes, setScheduleIntervalMinutes }}>{children}</RemoteBuildContext.Provider>;
}
