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
    pollingIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
    enabled: false,
    cloneStatus: 'not-started',
    setupStatus: 'untested',
    dirtyWorktreePolicy: 'block',
    buildHistory: [],
    lastStatus: 'idle',
    buildProgress: undefined,
    zipProgress: undefined,
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

export function remoteBuildOutputPath(targetPath: string, commit: string) {
  const outputRoot = remoteBuildOutputRoot(targetPath);
  return outputRoot && commit ? `${outputRoot}\\${commit}` : outputRoot;
}

export function useRemoteBuildProfiles() {
  const [profiles, setProfiles] = useState<RemoteBuildProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const store = await getStore();
    const storedProfiles = (await store.get<RemoteBuildProfile[]>(STORE_KEYS.REMOTE_BUILD_PROFILES)) ?? [];
    const nextProfiles = storedProfiles.map((profile) => ({
      ...createRemoteBuildProfile(profile),
      ...profile,
      platform: profile.platform ?? 'Win64',
      packageConfig: profile.packageConfig ?? 'Development',
      outputPath: profile.outputPath ?? '',
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
    setProfiles(nextProfiles);
    setActiveProfileId((await store.get<string>(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE)) ?? null);
    setLoading(false);
    return nextProfiles;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const saveProfiles = useCallback(async (next: RemoteBuildProfile[]) => {
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_PROFILES, next);
    setProfiles(next);
  }, []);

  const addProfile = useCallback(async (profile: RemoteBuildProfile = createRemoteBuildProfile()) => {
    await saveProfiles([...profiles, profile]);
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE, profile.id);
    setActiveProfileId(profile.id);
    return profile;
  }, [profiles, saveProfiles]);

  const updateProfile = useCallback(async (id: string, updates: Partial<RemoteBuildProfile>) => {
    const store = await getStore();
    const current = (await store.get<RemoteBuildProfile[]>(STORE_KEYS.REMOTE_BUILD_PROFILES)) ?? [];
    const next = current.map((profile) => profile.id === id ? { ...profile, ...updates } : profile);
    await store.set(STORE_KEYS.REMOTE_BUILD_PROFILES, next);
    setProfiles(next);
  }, []);


  const removeProfile = useCallback(async (id: string) => {
    const next = profiles.filter((profile) => profile.id !== id);
    await saveProfiles(next);
    if (activeProfileId === id) {
      const store = await getStore();
      const nextActive = next[0]?.id ?? null;
      await store.set(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE, nextActive);
      setActiveProfileId(nextActive);
    }
  }, [activeProfileId, profiles, saveProfiles]);

  const setActive = useCallback(async (id: string | null) => {
    const store = await getStore();
    await store.set(STORE_KEYS.REMOTE_BUILD_ACTIVE_PROFILE, id);
    setActiveProfileId(id);
  }, []);

  return { profiles, activeProfileId, activeProfile: profiles.find((p) => p.id === activeProfileId) ?? null, loading, addProfile, updateProfile, removeProfile, setActive, refresh };
}