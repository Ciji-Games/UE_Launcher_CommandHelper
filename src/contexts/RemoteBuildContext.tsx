import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { remoteBuildCheckoutPath, remoteBuildOutputPath, useRemoteBuildProfiles } from '../hooks/useRemoteBuildProfiles';
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
    return version === normalizedAssociation || version.startsWith(`${normalizedAssociation}.`) || id === normalizedAssociation;
  });
  if (!engine) throw new Error(`No installed Unreal Engine matches EngineAssociation '${association}'.`);
  return engine.editorPath;
}

export function RemoteBuildProvider({ children }: { children: React.ReactNode }) {
  const { profiles, updateProfile, appendLog, refresh } = useRemoteBuildProfiles();
  const inFlight = useRef(false);
  const [checking, setChecking] = useState(false);

  const checkProfile = useCallback(async (profile: RemoteBuildProfile, runBuild = true, force = false) => {
    if (inFlight.current || !profile.repositoryPath || !profile.buildBranch || profile.cloneStatus !== 'ready' || (!profile.enabled && !force)) return;
    inFlight.current = true;
    setChecking(true);
    const checkedAt = new Date().toISOString();
    const nextCheckAt = profile.enabled
      ? new Date(Date.now() + Math.max(1, profile.pollingIntervalMinutes) * 60_000).toISOString()
      : undefined;
    try {
      const log = (message: string) => {
        console.info(`[automatic-build] ${profile.name}: ${message}`);
        return appendLog(profile.id, message);
      };
      await updateProfile(profile.id, { lastStatus: 'checking', lastCheckedAt: checkedAt, nextCheckAt });
      await log(`check started: branch='${profile.buildBranch}', checkout='${checkoutPathForLog(profile.repositoryPath)}'`);
      const checkoutPath = remoteBuildCheckoutPath(profile.repositoryPath);
      await log('checking local checkout branch and worktree');
      const status = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', { repositoryPath: checkoutPath, remoteName: profile.remoteName, buildBranch: profile.buildBranch }), 'Checkout inspection');
      await log(`local checkout check completed: branch='${status.currentBranch ?? '(unknown)'}', clean=${status.worktreeClean && status.indexClean}`);
      const safe = status.currentBranch === profile.buildBranch && status.worktreeClean && status.indexClean;
      if (!safe) {
        await log('check blocked: checkout is on the wrong branch or has local changes');
        await updateProfile(profile.id, { safetyStatus: status.currentBranch !== profile.buildBranch ? 'wrong-branch' : 'local-changes', lastStatus: 'blocked', lastError: 'The checkout must stay on the configured branch with a clean worktree and index.' });
        return;
      }
      let projectPath = profile.projectPath;
      let enginePath = profile.enginePath;
      try {
        projectPath = resolveDetectedProject(status, projectPath);
        const engines = await withTimeout(invoke<EngineEntry[]>('get_installed_engine_paths'), 'Engine discovery');
        enginePath = resolveDetectedEngine(projectPath, status, engines, enginePath);
        if (projectPath !== profile.projectPath || enginePath !== profile.enginePath) {
          await updateProfile(profile.id, { projectPath, enginePath, setupStatus: 'passed', lastError: undefined });
          await log(`project resolved: '${projectPath}'`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await log(`packaging setup failed: ${message}`);
        await updateProfile(profile.id, { setupStatus: 'failed', lastStatus: 'failed', lastError: message });
        return;
      }
      if (!profile.repository) {
        await log('check failed: no repository is configured');
        await updateProfile(profile.id, { lastStatus: 'failed', lastError: 'Select a GitHub repository before checking the remote branch.' });
        return;
      }
      await log(`checking GitHub branch tip: '${profile.repository.fullName}:${profile.buildBranch}'`);
      const remoteTip = await withTimeout(invoke<{ ok: boolean; data?: { commit: string }; message: string }>('github_get_branch_tip', {
        owner: profile.repository.owner,
        repository: profile.repository.name,
        branch: profile.buildBranch,
      }), 'GitHub branch lookup');
      await log(remoteTip.ok ? `GitHub branch tip received: ${remoteTip.data?.commit?.slice(0, 12) ?? '(missing)'}` : `GitHub branch tip failed: ${remoteTip.message}`);
      if (!remoteTip.ok || !remoteTip.data?.commit) {
        await updateProfile(profile.id, { safetyStatus: 'unknown', lastStatus: 'failed', lastError: remoteTip.message || 'GitHub could not read the selected branch.' });
        return;
      }
      await updateProfile(profile.id, { lastStatus: 'fetching', lastRemoteCommit: remoteTip.data.commit, lastError: undefined });
      await log(`fetching '${profile.remoteName}/${profile.buildBranch}'`);
      const fetch = await withTimeout(invoke<{ ok: boolean; error?: string }>('fetch_remote_build_branch', { repositoryPath: checkoutPath, remoteName: profile.remoteName, buildBranch: profile.buildBranch }), 'Git fetch', 130_000);
      await log(fetch.ok ? 'fetch completed' : `fetch failed: ${fetch.error ?? 'unknown error'}`);
      if (!fetch.ok) {
        await updateProfile(profile.id, { safetyStatus: 'unknown', lastStatus: 'failed', lastError: fetch.error ?? 'Git fetch failed.' });
        return;
      }
      const refreshed = await withTimeout(invoke<CheckoutStatus>('inspect_remote_build_checkout', { repositoryPath: checkoutPath, remoteName: profile.remoteName, buildBranch: profile.buildBranch }), 'Post-fetch checkout inspection');
      await log(`post-fetch checkout check completed: remote commit='${refreshed.remoteCommit?.slice(0, 12) ?? '(missing)'}'`);
      const target = remoteTip.data.commit;
      if (!refreshed.result.ok || !target) {
        await updateProfile(profile.id, { safetyStatus: 'unknown', lastStatus: 'failed', lastError: refreshed.result.error ?? 'The remote branch could not be read after fetching.' });
        return;
      }
      await updateProfile(profile.id, { safetyStatus: 'clean-on-build-branch', lastRemoteCommit: target, lastError: refreshed.result.error });
      if (!runBuild || target === profile.lastBuiltCommit) {
        await log(!runBuild ? 'check completed without build' : 'check completed: branch has no new commit');
        await updateProfile(profile.id, { lastStatus: 'idle', lastError: undefined });
        return;
      }
      await updateProfile(profile.id, { lastStatus: 'pulling' });
      await log(`updating checkout to commit '${target.slice(0, 12)}'`);
      const updated = await withTimeout(invoke<{ ok: boolean; error?: string }>('update_remote_build_checkout', { repositoryPath: checkoutPath, buildBranch: profile.buildBranch, targetCommit: target }), 'Checkout update', 60_000);
      await log(updated.ok ? 'checkout update completed' : `checkout update failed: ${updated.error ?? 'unknown error'}`);
      if (!updated.ok) { await updateProfile(profile.id, { lastStatus: 'failed', lastError: updated.error ?? 'Checkout update failed.' }); return; }
      const run: RemoteBuildRun = { id: crypto.randomUUID(), commit: target, startedAt: new Date().toISOString(), status: 'running' };
      await updateProfile(profile.id, { lastStatus: 'running', buildProgress: 0, lastRunAt: run.startedAt, buildHistory: [run, ...profile.buildHistory].slice(0, 50) });
      await log(`packaging started: project='${projectPath}', platform='${profile.platform}', configuration='${profile.packageConfig}'`);
      const success = await withTimeout(invoke<boolean>('run_package', {
        projectPath,
        platform: profile.platform,
        clientConfig: profile.packageConfig,
        archiveDirectory: remoteBuildOutputPath(profile.repositoryPath, target),
        enginePath,
        bumpProjectVersion: false,
        projectVersion: null,
      }).then(() => true).catch(() => false), 'Packaging');
      const completedAt = new Date().toISOString();
      const finalRun = { ...run, completedAt, status: success ? 'success' as const : 'failed' as const, error: success ? undefined : 'One or more Scheduler steps failed.' };
      await log(success ? 'packaging completed successfully' : 'packaging failed');
      await updateProfile(profile.id, { lastStatus: success ? 'success' : 'failed', buildProgress: success ? 100 : undefined, lastBuiltCommit: success ? target : profile.lastBuiltCommit, lastError: finalRun.error, buildHistory: [finalRun, ...profile.buildHistory].slice(0, 50) });
    } catch (error) {
      console.error('[automatic-build] scheduled check failed', error);
      await appendLog(profile.id, `check failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      await updateProfile(profile.id, { lastStatus: 'failed', buildProgress: undefined, lastError: error instanceof Error ? error.message : String(error) });
    } finally { inFlight.current = false; setChecking(false); }
  }, [appendLog, updateProfile]);

  const pullNow = useCallback((profile: RemoteBuildProfile) => checkProfile(profile, true, true), [checkProfile]);

  useEffect(() => {
    const unlisten = listen<{ percent: number }>('progress-update', (event) => {
      const runningProfile = profiles.find((profile) => profile.lastStatus === 'running');
      if (runningProfile) void updateProfile(runningProfile.id, { buildProgress: Math.max(0, Math.min(100, event.payload.percent)) });
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [profiles, updateProfile]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().then((latestProfiles) => {
        const now = Date.now();
        latestProfiles
          .filter((profile) => profile.enabled && profile.cloneStatus === 'ready' && (!profile.nextCheckAt || Date.parse(profile.nextCheckAt) <= now))
          .forEach((profile) => void checkProfile(profile));
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [checkProfile, refresh]);

  return <RemoteBuildContext.Provider value={{ checkProfile, pullNow, checking }}>{children}</RemoteBuildContext.Provider>;
}
