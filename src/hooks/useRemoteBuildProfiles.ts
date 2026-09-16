import { useCallback, useEffect, useState } from 'react';
import type { RemoteBuildProfile } from '../types';
import { STORE_KEYS } from '../config';
import { getStore } from './useStore';

const DEFAULT_INTERVAL_MINUTES = 1;
export const REMOTE_BUILD_INTERVALS = [1, 5, 10] as const;

export function createRemoteBuildProfile(overrides: Partial<RemoteBuildProfile> = {}): RemoteBuildProfile {
  return {
    id: crypto.randomUUID(),
    name: 'Automatic build',
    repository: null,
    repositoryPath: '',
    remoteName: 'origin',
    buildBranch: '',
    safetyStatus: 'unknown',
    projectPath: '',
    enginePath: '',
    platform: 'Win64',
    packageConfig: 'Development',
    outputPath: '',
    additionalArgs: '',
    pollingIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
    enabled: false,
    cloneStatus: 'not-started',
    setupStatus: 'untested',
    dirtyWorktreePolicy: 'block',
    buildHistory: [],
    lastStatus: 'idle',
    cloneProgress: undefined,
    buildProgress: undefined,
    zipProgress: undefined,
    repoProgress: undefined,
    progressStages: {
      clone: 'pending',
      repo: 'pending',
      package: 'disabled',
      zip: 'disabled',
      cleanup: 'pending',
    },
    ...overrides,
  };
}

export function remoteBuildCheckoutPath(targetPath: string) {
  return targetPath ? `${targetPath.replace(/[\\/]+$/, '')}\\BuildRepo` : '';
}

export function remoteBuildOutputRoot(targetPath: string) {
  return targetPath ? `${targetPath.replace(/[\\/]+$/, '')}\\PackagedBuild` : '';
}

export function remoteBuildOutputPath(targetPath: string, projectPath: string, packageConfig: string, now = new Date()) {
  const outputRoot = remoteBuildOutputRoot(targetPath);
  if (!outputRoot || !projectPath) return outputRoot;
  const projectName = projectPath.split(/[\\/]/).pop()?.replace(/\.uproject$/i, '') || 'App';
  const appConfig = packageConfig === 'Shipping' ? 'Shipping' : 'Dev';
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}_${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${String(now.getFullYear()).slice(-2)}`;
  return `${outputRoot}\\${projectName}_${appConfig}_${timestamp}`;
}

let sharedProfiles: RemoteBuildProfile[] = [];
let sharedActiveProfileId: string | null = null;
let sharedLoading = true;
let isStoreLoaded = false;
const listeners = new Set<() => void>();

function notifySubscribers() {
  for (const listener of listeners) {
    listener();
  }
}

function updateSharedState(profiles: RemoteBuildProfile[], activeId: string | null, loading: boolean) {
  sharedProfiles = profiles;
  sharedActiveProfileId = activeId;
  sharedLoading = loading;
  notifySubscribers();
}

export function useRemoteBuildProfiles() {
  const [profiles, setProfiles] = useState<RemoteBuildProfile[]>(sharedProfiles);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(sharedActiveProfileId);
  const [loading, setLoading] = useState(sharedLoading);

  useEffect(() => {
    const listener = () => {
      setProfiles(sharedProfiles);
      setActiveProfileId(sharedActiveProfileId);
      setLoading(sharedLoading);
    };
    listeners.add(listener);
    setProfiles(sharedProfiles);
    setActiveProfileId(sharedActiveProfileId);
    setLoading(sharedLoading);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const refresh = useCallback(async () => {
    const store = await getStore();
    const storedProfiles = (await store.get<RemoteBuildProfile[]>(STORE_KEYS.REMOTE_BUILD_PROFILES)) ?? [];
    const nextProfiles = storedProfiles.map((profile) => ({
      ...createRemoteBuildProfile(profile),
      ...profile,
      platform: profile.platform ?? 'Win64',
      packageConfig: profile.packageConfig ?? 'Development',
      outputPath: profile.outputPath ?? '',
      additionalArgs: profile.additionalArgs ?? '',
      ...(profile.repositoryPath ? { outputPath: remoteBuildOutputRoot(profile.repositoryPath) } : {}),
      repository: profile.repository ?? null,
      cloneStatus: profile.cloneStatus ?? 'not-started',
      setupStatus: profile.setupStatus ?? 'untested',
      progressStages: {
        ...createRemoteBuildProfile().progressStages,
        ...profile.progressStages,
      },
      pollingIntervalMinutes: REMOTE_BUILD_INTERVALS.includes(profile.pollingIntervalMinutes as typeof REMOTE_BUILD_INTERVALS[number]) ? profile.pollingIntervalMinutes : DEFAULT_INTERVAL_MINUTES,
      nextCheckAt: undefined,
    }));
    const nextActive = (await store.get<string>(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE)) ?? null;
    isStoreLoaded = true;
    updateSharedState(nextProfiles, nextActive, false);
    return nextProfiles;
  }, []);

  useEffect(() => {
    if (!isStoreLoaded) {
      void refresh();
    }
  }, [refresh]);

  const saveProfiles = useCallback(async (next: RemoteBuildProfile[]) => {
    updateSharedState(next, sharedActiveProfileId, false);
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_PROFILES, next);
  }, []);

  const addProfile = useCallback(async (profile: RemoteBuildProfile = createRemoteBuildProfile()) => {
    const next = [...sharedProfiles, profile];
    updateSharedState(next, profile.id, false);
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_PROFILES, next);
    await store.set(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE, profile.id);
    return profile;
  }, []);

  const updateProfile = useCallback(async (id: string, updates: Partial<RemoteBuildProfile>) => {
    const next = sharedProfiles.map((profile) => (profile.id === id ? { ...profile, ...updates } : profile));
    updateSharedState(next, sharedActiveProfileId, false);
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_PROFILES, next);
  }, []);

  const removeProfile = useCallback(async (id: string) => {
    const next = sharedProfiles.filter((profile) => profile.id !== id);
    const nextActive = sharedActiveProfileId === id ? next[0]?.id ?? null : sharedActiveProfileId;
    updateSharedState(next, nextActive, false);
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_PROFILES, next);
    if (sharedActiveProfileId === id) {
      await store.set(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE, nextActive);
    }
  }, []);

  const setActive = useCallback(async (id: string | null) => {
    updateSharedState(sharedProfiles, id, false);
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE, id);
  }, []);

  return { profiles, activeProfileId, activeProfile: profiles.find((p) => p.id === activeProfileId) ?? null, loading, addProfile, updateProfile, removeProfile, saveProfiles, setActive, refresh };
}