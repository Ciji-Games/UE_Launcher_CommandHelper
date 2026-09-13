import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { remoteBuildCheckoutPath, remoteBuildOutputPath, remoteBuildOutputRoot, useRemoteBuildProfiles } from '../hooks/useRemoteBuildProfiles';
import { STORE_KEYS } from '../config';
import { getStore } from '../hooks/useStore';
import { useLog } from './LogContext';
import { useProgress } from './ProgressContext';
import { useProcessMonitor } from '../hooks/useProcessMonitor';
import { useGitHub } from '../hooks/useGitHub';
import { useEngines } from '../hooks/useEngines';
import { useAppActivity } from '../hooks/useAppActivity';
import type { CheckoutStatus, EngineEntry, ProfilePrerequisites, RemoteBuildProfile, RemoteBuildRun } from '../types';
import { evaluateProfilePrerequisites, recordOrMergeRun } from '../utils/remoteBuildPrerequisites';
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
  const { profiles, updateProfile } = useRemoteBuildProfiles();
  const { account } = useGitHub();
  const { engines } = useEngines();
  const uprojectMonitor = useProcessMonitor('uproject');
  const [checkoutStatuses, setCheckoutStatuses] = useState<Record<string, CheckoutStatus>>({});

  const inFlight = useRef(false);
  const batchRunning = useRef(false);
  const manualBuildRunning = useRef(false);
  const schedulePausedForUnreal = useRef(false);
  const scheduleNextRef = useRef<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [scheduleNextAt, setScheduleNextAt] = useState<string | undefined>();
  const [scheduleRunning, setScheduleRunning] = useState(false);
  const [scheduleIntervalMinutes, setScheduleIntervalMinutesState] = useState(1);
  const [keepBuildsEnabled, setKeepBuildsEnabled] = useState(false);
  const [keepBuildsCount, setKeepBuildsCount] = useState(3);
  const [archiveOnly, setArchiveOnly] = useState(false);
  const { appendLine } = useLog();
  const { startProgress, finishProgress, setNotifyOnComplete } = useProgress();

  useEffect(() => {
    void getStore().then(async (store) => {
      let githubConnected = false;
      try {
        githubConnected = await invoke<boolean>('github_is_connected');
      } catch (error) {
        console.warn('[automatic-build] failed to check GitHub connection during startup', error);
      }
      const storedNext = await store.get<string>(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT);
      const storedInterval = await store.get<number>(STORE_KEYS.REMOTE_BUILD_POLLING_INTERVAL);
      const storedKeepEnabled = await store.get<boolean>(STORE_KEYS.REMOTE_BUILD_KEEP_BUILDS_ENABLED);
      const storedKeepCount = await store.get<number>(STORE_KEYS.REMOTE_BUILD_KEEP_BUILDS_COUNT);
      const storedArchiveOnly = await store.get<boolean>(STORE_KEYS.REMOTE_BUILD_ARCHIVE_ONLY);
      setScheduleIntervalMinutesState(storedInterval === 5 || storedInterval === 10 ? storedInterval : 1);
      setKeepBuildsEnabled(storedKeepEnabled ?? false);
      setKeepBuildsCount(typeof storedKeepCount === 'number' && storedKeepCount > 0 ? Math.floor(storedKeepCount) : 3);
      setArchiveOnly(storedArchiveOnly ?? false);
      if (!githubConnected) {
        scheduleNextRef.current = undefined;
        setScheduleNextAt(undefined);
        if (typeof (store as { delete?: (key: string) => Promise<unknown> }).delete === 'function') {
          try {
            await (store as { delete: (key: string) => Promise<unknown> }).delete(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT);
          } catch (error) {
            console.warn('[automatic-build] failed to clear stored schedule during startup', error);
          }
        }
      } else if (storedNext && Date.parse(storedNext) > Date.now()) {
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
    if (!batchRunning.current && !manualBuildRunning.current) {
      const next = new Date(Date.now() + interval * 60_000).toISOString();
      scheduleNextRef.current = next;
      setScheduleNextAt(next);
      await store.set(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT, next);
    }
  }, []);

  const applyScheduleSettings = useCallback(async (settings: { intervalMinutes: number; keepBuildsEnabled: boolean; keepBuildsCount: number; archiveOnly: boolean }) => {
    const interval = settings.intervalMinutes === 5 || settings.intervalMinutes === 10 ? settings.intervalMinutes : 1;
    const count = Math.max(1, Math.floor(settings.keepBuildsCount) || 1);
    const store = await getStore();
    await Promise.all([
      store.set(STORE_KEYS.REMOTE_BUILD_POLLING_INTERVAL, interval),
      store.set(STORE_KEYS.REMOTE_BUILD_KEEP_BUILDS_ENABLED, settings.keepBuildsEnabled),
      store.set(STORE_KEYS.REMOTE_BUILD_KEEP_BUILDS_COUNT, count),
      store.set(STORE_KEYS.REMOTE_BUILD_ARCHIVE_ONLY, settings.archiveOnly),
    ]);
    setScheduleIntervalMinutesState(interval);
    setKeepBuildsEnabled(settings.keepBuildsEnabled);
    setKeepBuildsCount(count);
    setArchiveOnly(settings.archiveOnly);
    if (!batchRunning.current && !manualBuildRunning.current) {
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
      startProgress({ showOutputLog: true, notifyOnComplete: false });
    }
    const checkedAt = new Date().toISOString();
    const startTime = checkedAt;
    try {
      const log = (message: string) => {
        console.info(`[automatic-build] ${profile.name}: ${message}`);
        appendLine({ line: `[${profile.name}] ${message}`, color: message.includes('failed') || message.includes('blocked') ? 'red' : message.includes('successfully') ? 'green' : 'blue' });
        return Promise.resolve();
      };
      let stages = { ...profile.progressStages };
      const updateStages = async (changes: Partial<typeof stages>) => {
        stages = { ...stages, ...changes };
        await updateProfile(profile.id, { progressStages: stages });
      };

      await updateProfile(profile.id, {
        lastStatus: 'checking',
        lastCheckedAt: checkedAt,
        repoProgress: 0,
        progressStages: { ...stages, repo: 'running', package: runBuild ? 'pending' : 'disabled', zip: runBuild && archiveOnly ? 'pending' : 'disabled', cleanup: runBuild && (keepBuildsEnabled || archiveOnly) ? 'pending' : 'disabled' },
      });
      stages = { ...stages, repo: 'running', package: runBuild ? 'pending' : 'disabled', zip: runBuild && archiveOnly ? 'pending' : 'disabled', cleanup: runBuild && (keepBuildsEnabled || archiveOnly) ? 'pending' : 'disabled' };
      await log(`check started: branch='${profile.buildBranch}', checkout='${checkoutPathForLog(profile.repositoryPath)}'`);
      const checkoutPath = remoteBuildCheckoutPath(profile.repositoryPath);
      const remoteName = profile.remoteName || 'origin';

      // Step 1: Pre-check inspection
      await log('checking local checkout branch and worktree');
      const initialStatus = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', { repositoryPath: checkoutPath, remoteName, buildBranch: profile.buildBranch }), 'Checkout inspection');
      setCheckoutStatuses((prev) => ({ ...prev, [profile.id]: initialStatus }));
      await log(`local checkout check completed: branch='${initialStatus.currentBranch ?? '(unknown)'}', clean=${initialStatus.worktreeClean && initialStatus.indexClean}`);

      const isGitignoreValid = initialStatus.gitignoreValid ?? true;
      const safe = initialStatus.currentBranch === profile.buildBranch && initialStatus.worktreeClean && initialStatus.indexClean && isGitignoreValid;
      if (!safe) {
        let reason = 'The checkout has uncommitted local modifications or staged changes.';
        if (initialStatus.currentBranch !== profile.buildBranch) {
          reason = `Checkout is on branch '${initialStatus.currentBranch ?? '(unknown)'}' instead of configured '${profile.buildBranch}'.`;
        } else if (!isGitignoreValid) {
          const missing = (initialStatus.gitignoreMissingEntries || []).join(', ');
          reason = `The repository .gitignore is missing required Unreal Engine entries: ${missing || 'Binaries, DerivedDataCache, Intermediate'}.`;
        }
        await log(`check blocked: ${reason}`);
        const blockedRun: RemoteBuildRun = {
          id: crypto.randomUUID(),
          commit: initialStatus.headCommit ?? profile.lastRemoteCommit ?? 'unknown',
          startedAt: startTime,
          completedAt: new Date().toISOString(),
          durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(startTime)) / 1000)),
          status: 'blocked',
          failedStage: 'repo',
          trigger: force ? 'manual' : 'scheduled',
          error: reason,
          errorSummary: reason,
        };
        await updateProfile(profile.id, {
          safetyStatus: initialStatus.currentBranch !== profile.buildBranch
            ? 'wrong-branch'
            : !isGitignoreValid
            ? 'unknown'
            : 'local-changes',
          lastStatus: 'blocked',
          repoProgress: undefined,
          lastError: reason,
          progressStages: { ...stages, repo: 'failed', package: 'disabled', zip: 'disabled', cleanup: 'disabled' },
          buildHistory: recordOrMergeRun(profile.buildHistory, blockedRun),
        });
        return;
      }

      await updateProfile(profile.id, { repoProgress: 20 });

      // Step 2: Fetch remote branch
      await updateProfile(profile.id, { lastStatus: 'fetching', lastError: undefined });
      await updateProfile(profile.id, { repoProgress: 35 });
      await log(`fetching '${remoteName}/${profile.buildBranch}'`);
      const fetch = await withTimeout(invoke<{ ok: boolean; error?: string }>('fetch_remote_build_branch', {
        repositoryPath: checkoutPath,
        remoteName,
        buildBranch: profile.buildBranch
      }), 'Git fetch', 130_000);

      await log(fetch.ok ? 'fetch completed' : `fetch failed: ${fetch.error ?? 'unknown error'}`);
      if (!fetch.ok) {
        const fetchError = fetch.error ?? 'Git fetch failed.';
        const failedRun: RemoteBuildRun = {
          id: crypto.randomUUID(),
          commit: initialStatus.headCommit ?? profile.lastRemoteCommit ?? 'unknown',
          startedAt: startTime,
          completedAt: new Date().toISOString(),
          durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(startTime)) / 1000)),
          status: 'failed',
          failedStage: 'repo',
          trigger: force ? 'manual' : 'scheduled',
          error: fetchError,
          errorSummary: fetchError,
        };
        await updateProfile(profile.id, {
          safetyStatus: 'unknown',
          lastStatus: 'failed',
          repoProgress: undefined,
          lastError: fetchError,
          progressStages: { ...stages, repo: 'failed', package: 'disabled', zip: 'disabled', cleanup: 'disabled' },
          buildHistory: recordOrMergeRun(profile.buildHistory, failedRun),
        });
        return;
      }

      await updateProfile(profile.id, { repoProgress: 50 });

      // Step 3: Inspect checkout post-fetch
      const refreshed = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', {
        repositoryPath: checkoutPath,
        remoteName,
        buildBranch: profile.buildBranch
      }), 'Post-fetch checkout inspection');

      if (!refreshed.result.ok || !refreshed.remoteCommit) {
        const inspectError = refreshed.result.error ?? 'The remote branch could not be read after fetching.';
        await log(`post-fetch inspection failed: ${inspectError}`);
        const failedRun: RemoteBuildRun = {
          id: crypto.randomUUID(),
          commit: initialStatus.headCommit ?? profile.lastRemoteCommit ?? 'unknown',
          startedAt: startTime,
          completedAt: new Date().toISOString(),
          durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(startTime)) / 1000)),
          status: 'failed',
          failedStage: 'repo',
          trigger: force ? 'manual' : 'scheduled',
          error: inspectError,
          errorSummary: inspectError,
        };
        await updateProfile(profile.id, {
          safetyStatus: 'unknown',
          lastStatus: 'failed',
          repoProgress: undefined,
          lastError: inspectError,
          progressStages: { ...profile.progressStages, repo: 'failed', package: 'disabled', zip: 'disabled', cleanup: 'disabled' },
          buildHistory: recordOrMergeRun(profile.buildHistory, failedRun),
        });
        return;
      }

      const remoteCommit = refreshed.remoteCommit;
      await updateProfile(profile.id, { repoProgress: 65 });
      const headCommit = refreshed.headCommit;
      const isBehind = refreshed.isBehind || (Boolean(headCommit && remoteCommit) && headCommit !== remoteCommit);

      await log(`post-fetch checkout check: local='${headCommit?.slice(0, 12) ?? '(unknown)'}', remote='${remoteCommit.slice(0, 12)}', behind=${isBehind ? `${refreshed.behindCount || 1} commit(s)` : 'no'}`);
      await updateProfile(profile.id, { safetyStatus: 'clean-on-build-branch', lastRemoteCommit: remoteCommit, lastError: undefined });

      // Step 4: Check if local is behind OR if a successful build for this remote commit has not been generated yet
      const hasBuiltCurrentCommit = profile.lastBuiltCommit === remoteCommit && profile.buildHistory?.some(
        (run) => run.commit === remoteCommit && run.status === 'success' && run.outputPath
      );

      if (!isBehind && hasBuiltCurrentCommit && !force) {
        await log(`check completed: local branch '${profile.buildBranch}' is up to date (${headCommit?.slice(0, 12) ?? remoteCommit.slice(0, 12)}) and build exists`);
        await updateProfile(profile.id, {
          lastStatus: 'idle',
          lastError: undefined,
          repoProgress: undefined,
          progressStages: { ...stages, repo: 'success', package: 'disabled', zip: 'disabled', cleanup: 'disabled' }
        });
        return;
      }

      if (!isBehind) {
        if (!hasBuiltCurrentCommit) {
          await log(`local branch '${profile.buildBranch}' is up to date (${remoteCommit.slice(0, 12)}), but no build was generated yet for this commit: triggering build pipeline`);
        } else if (force) {
          await log(`local branch '${profile.buildBranch}' is up to date (${remoteCommit.slice(0, 12)}): forcing rebuild by manual request`);
        }
      }

      // Step 5: Pull changes
      await updateProfile(profile.id, { lastStatus: 'pulling' });
      await updateProfile(profile.id, { repoProgress: 75 });
      await log(`updating checkout to commit '${remoteCommit.slice(0, 12)}'`);
      const updated = await withTimeout(invoke<{ ok: boolean; error?: string }>('update_remote_build_checkout', {
        repositoryPath: checkoutPath,
        buildBranch: profile.buildBranch,
        targetCommit: remoteCommit
      }), 'Checkout update', 60_000);

      await log(updated.ok ? 'checkout update completed' : `checkout update failed: ${updated.error ?? 'unknown error'}`);
      if (!updated.ok) {
        const updateError = updated.error ?? 'Checkout update failed.';
        const failedRun: RemoteBuildRun = {
          id: crypto.randomUUID(),
          commit: remoteCommit,
          startedAt: startTime,
          completedAt: new Date().toISOString(),
          durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(startTime)) / 1000)),
          status: 'failed',
          failedStage: 'repo',
          trigger: force ? 'manual' : 'scheduled',
          error: updateError,
          errorSummary: updateError,
        };
        await updateProfile(profile.id, {
          lastStatus: 'failed',
          repoProgress: undefined,
          lastError: updateError,
          progressStages: { ...profile.progressStages, repo: 'failed', package: 'disabled', zip: 'disabled', cleanup: 'disabled' },
          buildHistory: recordOrMergeRun(profile.buildHistory, failedRun),
        });
        return;
      }

      // Step 6: Post-pull inspection and Project / Engine resolution
      const postPullStatus = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', {
        repositoryPath: checkoutPath,
        remoteName,
        buildBranch: profile.buildBranch
      }), 'Post-pull inspection');
      await updateProfile(profile.id, { repoProgress: 100 });

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
        const failedRun: RemoteBuildRun = {
          id: crypto.randomUUID(),
          commit: remoteCommit,
          startedAt: startTime,
          completedAt: new Date().toISOString(),
          durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(startTime)) / 1000)),
          status: 'failed',
          failedStage: 'package',
          trigger: force ? 'manual' : 'scheduled',
          error: message,
          errorSummary: message,
        };
        await updateProfile(profile.id, {
          setupStatus: 'failed',
          lastStatus: 'failed',
          repoProgress: undefined,
          buildProgress: undefined,
          lastError: message,
          progressStages: { ...profile.progressStages, repo: 'success', package: 'failed', zip: 'disabled', cleanup: 'disabled' },
          buildHistory: recordOrMergeRun(profile.buildHistory, failedRun),
        });
        return;
      }

      // Step 7: Packaging
      if (!runBuild) {
        await log('checkout updated without packaging (runBuild=false)');
        await updateProfile(profile.id, {
          lastStatus: 'idle',
          lastError: undefined,
          repoProgress: undefined,
          progressStages: { ...profile.progressStages, repo: 'success', package: 'disabled', zip: 'disabled', cleanup: 'disabled' }
        });
        return;
      }

      await updateProfile(profile.id, {
        lastStatus: 'running',
        repoProgress: undefined,
        buildProgress: 0,
        zipProgress: archiveOnly ? 0 : undefined,
        progressStages: { ...stages, repo: 'success', package: 'running', zip: archiveOnly ? 'pending' : 'disabled', cleanup: keepBuildsEnabled || archiveOnly ? 'pending' : 'disabled' },
        lastRunAt: startTime,
      });
      setNotifyOnComplete(true);
      stages = { ...stages, repo: 'success', package: 'running', zip: archiveOnly ? 'pending' : 'disabled', cleanup: keepBuildsEnabled || archiveOnly ? 'pending' : 'disabled' };
      await log(`packaging started: project='${projectPath}', platform='${profile.platform}', configuration='${profile.packageConfig}'`);

      let packageError: string | undefined;
      let packageSuccess = false;
      let failedStage: 'package' | 'zip' | 'cleanup' | undefined;
      let packagedOutputPath: string | undefined;
      try {
        const buildOutputPath = remoteBuildOutputPath(profile.repositoryPath, projectPath, profile.packageConfig);
        packagedOutputPath = buildOutputPath;
        await invoke('run_package', {
          projectPath,
          platform: profile.platform,
          clientConfig: profile.packageConfig,
          archiveDirectory: buildOutputPath,
          enginePath,
          bumpProjectVersion: false,
          projectVersion: null,
        });
        if (archiveOnly) {
          await updateStages({ package: 'running', zip: 'running', cleanup: 'pending' });
          await log('archiving packaged build…');
          try {
            const archivePath = await invoke<string>('archive_remote_build_output', {
              outputDirectory: buildOutputPath,
            });
            await log(`build archived to '${archivePath}'`);
            await updateStages({ zip: 'success', cleanup: keepBuildsEnabled ? 'running' : 'success' });
          } catch (zipErr) {
            failedStage = 'zip';
            throw zipErr;
          }
          if (keepBuildsEnabled) {
            try {
              await invoke('prepare_remote_build_output', {
                outputRoot: remoteBuildOutputRoot(profile.repositoryPath),
                keepCount: keepBuildsCount,
              });
              await log(`old builds cleaned; keeping ${keepBuildsCount} stored build(s)`);
              await updateStages({ cleanup: 'success' });
            } catch (cleanErr) {
              console.warn('[automatic-build] non-fatal cleanup warning', cleanErr);
              await log(`cleanup notice: ${cleanErr instanceof Error ? cleanErr.message : String(cleanErr)}`);
            }
          }
        } else if (keepBuildsEnabled) {
          await updateStages({ package: 'running', cleanup: 'running' });
          try {
            await invoke('prepare_remote_build_output', {
              outputRoot: remoteBuildOutputRoot(profile.repositoryPath),
              keepCount: keepBuildsCount,
            });
            await log(`old builds cleaned; keeping ${keepBuildsCount} stored build(s)`);
            await updateStages({ cleanup: 'success' });
          } catch (cleanErr) {
            console.warn('[automatic-build] non-fatal cleanup warning', cleanErr);
            await log(`cleanup notice: ${cleanErr instanceof Error ? cleanErr.message : String(cleanErr)}`);
          }
        }
        packageSuccess = true;
      } catch (err) {
        if (!failedStage) failedStage = 'package';
        packageError = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      }

      const completedAt = new Date().toISOString();
      const durationSeconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startTime)) / 1000));
      const finalRun: RemoteBuildRun = {
        id: crypto.randomUUID(),
        commit: remoteCommit,
        startedAt: startTime,
        completedAt,
        durationSeconds,
        status: packageSuccess ? ('success' as const) : ('failed' as const),
        failedStage: packageSuccess ? undefined : failedStage,
        trigger: force ? 'manual' : 'scheduled',
        error: packageError,
        errorSummary: packageError,
        outputPath: packageSuccess ? packagedOutputPath : undefined,
      };

      if (packageSuccess) {
        await log('packaging completed successfully');
        await updateProfile(profile.id, {
          lastStatus: 'success',
          repoProgress: undefined,
          buildProgress: 100,
          zipProgress: archiveOnly ? 100 : undefined,
          lastBuiltCommit: remoteCommit,
          lastError: undefined,
          progressStages: { ...stages, repo: 'success', package: 'success', zip: archiveOnly ? 'success' : 'disabled', cleanup: keepBuildsEnabled || archiveOnly ? 'success' : 'disabled' },
          buildHistory: [finalRun, ...(profile.buildHistory || [])].slice(0, 50),
        });
      } else {
        await log(`packaging failed: ${packageError ?? 'unknown error'}`);
        await updateProfile(profile.id, {
          lastStatus: 'failed',
          repoProgress: undefined,
          buildProgress: undefined,
          zipProgress: undefined,
          lastError: packageError ?? 'Packaging failed.',
          progressStages: { ...stages, [failedStage ?? 'package']: 'failed' },
          buildHistory: recordOrMergeRun(profile.buildHistory, finalRun),
        });
      }
    } catch (error) {
      console.error('[automatic-build] check failed', error);
      const message = error instanceof Error ? error.message : String(error);
      appendLine({ line: `[${profile.name}] check failed unexpectedly: ${message}`, color: 'red' });
      const unexpectedRun: RemoteBuildRun = {
        id: crypto.randomUUID(),
        commit: profile.lastRemoteCommit ?? 'unknown',
        startedAt: checkedAt,
        completedAt: new Date().toISOString(),
        durationSeconds: Math.max(0, Math.round((Date.now() - Date.parse(checkedAt)) / 1000)),
        status: 'failed',
        trigger: force ? 'manual' : 'scheduled',
        error: message,
        errorSummary: message,
      };
      await updateProfile(profile.id, {
        lastStatus: 'failed',
        repoProgress: undefined,
        buildProgress: undefined,
        zipProgress: undefined,
        lastError: message,
        progressStages: { ...profile.progressStages, repo: 'failed', package: 'failed' },
        buildHistory: recordOrMergeRun(profile.buildHistory, unexpectedRun),
      });
    } finally {
      inFlight.current = false;
      setChecking(false);
      if (!batchInvocation) {
        finishProgress();
      }
    }
  }, [appendLine, archiveOnly, finishProgress, keepBuildsCount, keepBuildsEnabled, setNotifyOnComplete, startProgress, updateProfile]);

  const persistScheduleNext = useCallback(async (value: string | undefined) => {
    try {
      const store = await getStore();
      if (value === undefined) {
        if (typeof (store as { delete?: (key: string) => Promise<unknown> }).delete === 'function') {
          await (store as { delete: (key: string) => Promise<unknown> }).delete(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT);
        }
      } else {
        await store.set(STORE_KEYS.REMOTE_BUILD_SCHEDULE_NEXT, value);
      }
    } catch (error) {
      console.warn('[automatic-build] failed to persist schedule state', error);
    }
  }, []);

  const pullNow = useCallback(async (profile: RemoteBuildProfile) => {
    if (manualBuildRunning.current || batchRunning.current || inFlight.current) return;

    manualBuildRunning.current = true;
    scheduleNextRef.current = undefined;
    setScheduleNextAt(undefined);
    await persistScheduleNext(undefined);
    appendLine({ line: `Automatic build schedule paused for manual build: ${profile.name}.`, color: 'orange' });

    try {
      await checkProfile(profile, true, true);
    } finally {
      manualBuildRunning.current = false;
      const enabledProfiles = profilesRef.current.filter((candidate) => candidate.enabled && candidate.cloneStatus === 'ready');
      if (enabledProfiles.length > 0) {
        const restarted = new Date(Date.now() + scheduleIntervalMinutes * 60_000).toISOString();
        scheduleNextRef.current = restarted;
        setScheduleNextAt(restarted);
        await persistScheduleNext(restarted);
        appendLine({ line: 'Automatic build schedule resumed after manual build.', color: 'green' });
      }
    }
  }, [appendLine, checkProfile, persistScheduleNext, scheduleIntervalMinutes]);

  const inspectProfileCheckout = useCallback(async (profile: RemoteBuildProfile) => {
    if (profile.cloneStatus !== 'ready' || !profile.repositoryPath || !profile.buildBranch) return;
    try {
      const checkoutPath = remoteBuildCheckoutPath(profile.repositoryPath);
      const remoteName = profile.remoteName || 'origin';
      const status = await withTimeout(
        invoke<CheckoutStatus>('inspect_remote_build_checkout', {
          repositoryPath: checkoutPath,
          remoteName,
          buildBranch: profile.buildBranch,
        }),
        'Checkout inspection',
        15_000
      );
      setCheckoutStatuses((prev) => ({ ...prev, [profile.id]: status }));
      if (!status.result.ok && profile.cloneStatus === 'ready') {
        void updateProfile(profile.id, {
          cloneStatus: 'not-started',
          setupStatus: 'untested',
          enabled: false,
        });
      }
    } catch (error) {
      console.warn(`[automatic-build] failed to inspect checkout for profile '${profile.name}'`, error);
    }
  }, [updateProfile]);

  const refreshPrerequisites = useCallback(async (profileId?: string) => {
    if (profileId) {
      const target = profiles.find((p) => p.id === profileId);
      if (target) await inspectProfileCheckout(target);
    } else {
      for (const p of profiles) {
        if (p.cloneStatus === 'ready') {
          await inspectProfileCheckout(p);
        }
      }
    }
  }, [inspectProfileCheckout, profiles]);

  const isAppActive = useAppActivity();
  const isGitHubConnected = Boolean(account);
  const profilesRef = useRef(profiles);
  useEffect(() => {
    profilesRef.current = profiles;
    const enabledProfiles = profiles.filter((profile) => profile.enabled && profile.cloneStatus === 'ready');
    if (enabledProfiles.length === 0 || !isGitHubConnected) {
      if (scheduleNextRef.current !== undefined) {
        scheduleNextRef.current = undefined;
        setScheduleNextAt(undefined);
        void persistScheduleNext(undefined);
      }
    } else if (!batchRunning.current && !inFlight.current && !manualBuildRunning.current) {
      const now = Date.now();
      const currentNext = scheduleNextRef.current;
      if (!currentNext || Date.parse(currentNext) <= now) {
        const initial = new Date(now + scheduleIntervalMinutes * 60_000).toISOString();
        scheduleNextRef.current = initial;
        setScheduleNextAt(initial);
        void persistScheduleNext(initial);
      }
    }
  }, [profiles, isGitHubConnected, persistScheduleNext, scheduleIntervalMinutes]);

  const profileCheckoutKey = useMemo(() => {
    return profiles.map((p) => `${p.id}:${p.repositoryPath}:${p.buildBranch}:${p.cloneStatus}`).join('|');
  }, [profiles]);

  // Periodic background inspection poller for dynamic prerequisite evaluation
  useEffect(() => {
    let isMounted = true;
    if (!isAppActive) return;

    const pollCheckouts = async () => {
      if (inFlight.current || batchRunning.current) return;
      for (const profile of profilesRef.current) {
        if (profile.cloneStatus === 'ready' && profile.repositoryPath && profile.buildBranch) {
          try {
            const checkoutPath = remoteBuildCheckoutPath(profile.repositoryPath);
            const remoteName = profile.remoteName || 'origin';
            const status = await invoke<CheckoutStatus>('inspect_remote_build_checkout', {
              repositoryPath: checkoutPath,
              remoteName,
              buildBranch: profile.buildBranch,
            });
            if (!status.result.ok && profile.cloneStatus === 'ready') {
              void updateProfile(profile.id, {
                cloneStatus: 'not-started',
                setupStatus: 'untested',
                enabled: false,
              });
            }
            if (isMounted) {
              setCheckoutStatuses((prev) => {
                const current = prev[profile.id];
                if (
                  current &&
                  current.currentBranch === status.currentBranch &&
                  current.headCommit === status.headCommit &&
                  current.remoteCommit === status.remoteCommit &&
                  current.isBehind === status.isBehind &&
                  current.behindCount === status.behindCount &&
                  current.worktreeClean === status.worktreeClean &&
                  current.indexClean === status.indexClean &&
                  current.gitLfsAvailable === status.gitLfsAvailable &&
                  current.requiresGitLfs === status.requiresGitLfs &&
                  current.projects.length === status.projects.length
                ) {
                  return prev;
                }
                return { ...prev, [profile.id]: status };
              });
            }
          } catch {
            // Background polling error is non-fatal
          }
        }
      }
    };

    void pollCheckouts();
    const interval = setInterval(pollCheckouts, 30_000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isAppActive, profileCheckoutKey]);

  const prerequisites = useMemo<Record<string, ProfilePrerequisites>>(() => {
    const isAnyPackageRunning = profiles.some(
      (p) =>
        p.progressStages?.package === 'running' ||
        (p.lastStatus === 'running' && p.progressStages?.package !== 'failed' && p.progressStages?.package !== 'disabled')
    );
    const result: Record<string, ProfilePrerequisites> = {};
    for (const profile of profiles) {
      result[profile.id] = evaluateProfilePrerequisites({
        profile,
        githubConnected: Boolean(account),
        checkoutStatus: checkoutStatuses[profile.id] ?? null,
        installedEngines: engines,
        uprojectRunningProcesses: uprojectMonitor.runningProcesses,
        isAnyPackageRunning,
        globalSettings: {
          keepBuildsEnabled,
          keepBuildsCount,
          archiveOnly,
        },
      });
    }
    return result;
  }, [profiles, account, checkoutStatuses, engines, uprojectMonitor.runningProcesses, keepBuildsEnabled, keepBuildsCount, archiveOnly]);

  const getProfilePrerequisites = useCallback((profileId: string) => {
    return prerequisites[profileId];
  }, [prerequisites]);

  useEffect(() => {
    const unlisten = listen<{ percent: number }>('progress-update', (event) => {
      const runningProfile = profiles.find((profile) =>
        profile.lastStatus === 'running' ||
        profile.cloneStatus === 'cloning' ||
        profile.progressStages?.clone === 'running'
      );
      if (!runningProfile) return;
      const percent = Math.max(0, Math.min(100, event.payload.percent));
      if (runningProfile.cloneStatus === 'cloning' || runningProfile.progressStages?.clone === 'running') {
        void updateProfile(runningProfile.id, {cloneProgress: percent});
      } else if (runningProfile.progressStages?.zip === 'running') {
        void updateProfile(runningProfile.id, {zipProgress: percent});
      } else if (runningProfile.progressStages?.package === 'running') {
        void updateProfile(runningProfile.id, {buildProgress: percent});
      }
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [profiles, updateProfile]);

  useEffect(() => {
    const unlisten = listen<{ line: string; color?: 'green' | 'red' | 'orange' | 'blue' | 'white' | 'gray' }>('log-output', (event) => {
      appendLine({ line: event.payload.line, color: event.payload.color });
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [appendLine]);


  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const latestProfiles = profilesRef.current;
    const enabledProfiles = latestProfiles.filter((profile) => profile.enabled && profile.cloneStatus === 'ready');
    if (enabledProfiles.length === 0 || !account) {
      if (scheduleNextRef.current !== undefined) {
        scheduleNextRef.current = undefined;
        setScheduleNextAt(undefined);
        void persistScheduleNext(undefined);
      }
      return;
    }
    if (batchRunning.current || inFlight.current || manualBuildRunning.current) return;

    const now = Date.now();
    const next = scheduleNextRef.current;
    if (!next) {
      const initial = new Date(now + scheduleIntervalMinutes * 60_000).toISOString();
      scheduleNextRef.current = initial;
      setScheduleNextAt(initial);
      void persistScheduleNext(initial);
      return;
    }

    if (Date.parse(next) > now) return;

    void (async () => {
      let githubConnected = false;
      try {
        githubConnected = await invoke<boolean>('github_is_connected');
      } catch (error) {
        console.warn('[automatic-build] failed to check GitHub connection', error);
      }
      if (!githubConnected) {
        if (scheduleNextRef.current !== undefined) {
          scheduleNextRef.current = undefined;
          setScheduleNextAt(undefined);
          await persistScheduleNext(undefined);
        }
        return;
      }

      let unrealRunning = false;
      try {
        unrealRunning = await invoke<boolean>('has_blocking_processes', { groupName: 'uproject' });
      } catch (error) {
        console.warn('[automatic-build] failed to check Unreal Engine process state', error);
      }
      if (unrealRunning) {
        if (!schedulePausedForUnreal.current) {
          schedulePausedForUnreal.current = true;
          appendLine({ line: 'Automatic build schedule paused while Unreal Engine is running.', color: 'orange' });
        }
        return;
      }
      if (schedulePausedForUnreal.current) {
        schedulePausedForUnreal.current = false;
        appendLine({ line: 'Automatic build schedule resumed after Unreal Engine closed.', color: 'green' });
      }

      batchRunning.current = true;
      setScheduleRunning(true);
      scheduleNextRef.current = undefined;
      setScheduleNextAt(undefined);

      // Everything from here on is inside try/finally, so no matter what
      // throws (a store error, an invoke error, anything) batchRunning is
      // guaranteed to be released and the scheduler can't get stuck again.
      try {
        await persistScheduleNext(undefined);
        startProgress({ showOutputLog: true, notifyOnComplete: false });
        appendLine({ line: `Automatic build schedule started: ${enabledProfiles.length} enabled job(s).`, color: 'blue' });
        for (const profile of enabledProfiles) {
          try {
            if (!await invoke<boolean>('github_is_connected')) break;
          } catch {
            break;
          }
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
    })();
  };

  useEffect(() => {
    const timer = window.setInterval(() => tickRef.current(), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <RemoteBuildContext.Provider
      value={{
        checkProfile,
        pullNow,
        checking,
        scheduleNextAt,
        scheduleRunning,
        scheduleIntervalMinutes,
        setScheduleIntervalMinutes,
        keepBuildsEnabled,
        keepBuildsCount,
        archiveOnly,
        applyScheduleSettings,
        prerequisites,
        getProfilePrerequisites,
        refreshPrerequisites,
      }}
    >
      {children}
    </RemoteBuildContext.Provider>
  );
}
