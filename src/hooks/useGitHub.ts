import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { STORE_KEYS } from '../config';
import { getStore } from './useStore';
import type { GitHubAccount, GitHubBranch, GitHubRepository } from '../types';

export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/ue-launcheur-login';

export async function openAppInstallUrl(): Promise<void> {
  try {
    await openUrl(GITHUB_APP_INSTALL_URL);
  } catch (error) {
    console.error('Failed to open GitHub App URL:', error);
  }
}

interface Result<T> { ok: boolean; data?: T; category?: string; message: string }
interface DeviceAuthorization { userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }
export type GitHubAuthorizationStatus = 'ready' | 'waiting' | 'expired' | 'cancelled' | 'failed';
export interface PendingGitHubAuthorization {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  status: GitHubAuthorizationStatus;
}

let sharedAccount: GitHubAccount | null = null;
let sharedRepositories: GitHubRepository[] = [];
let sharedAuth: PendingGitHubAuthorization | null = null;
const subscribers = new Set<() => void>();

function notifySubscribers() {
  subscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      // ignore
    }
  });
}

export function useGitHub() {
  const [account, setAccount] = useState<GitHubAccount | null>(() => sharedAccount);
  const [repositories, setRepositories] = useState<GitHubRepository[]>(() => sharedRepositories);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [authorization, setAuthorization] = useState<PendingGitHubAuthorization | null>(() => sharedAuth);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const authorizationRun = useRef(0);

  // Synchronize state changes across hook instances
  useEffect(() => {
    const handleUpdate = () => {
      setAccount(sharedAccount);
      setRepositories(sharedRepositories);
      setAuthorization(sharedAuth);
    };
    subscribers.add(handleUpdate);
    return () => {
      subscribers.delete(handleUpdate);
    };
  }, []);

  // Listen for backend post-installation redirect callback on 127.0.0.1
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('github://app-installed', () => {
      void loadRepositories();
      void refreshAccount();
      setMessage('GitHub App installation detected. Repositories refreshed!');
      setShowInstallGuide(false);
    }).then((fn) => {
      unlisten = fn;
    }).catch((err) => {
      console.error('Failed to listen for GitHub app-installed events:', err);
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const updateSharedAccount = (acc: GitHubAccount | null) => {
    if (sharedAccount === acc || (sharedAccount?.accountId === acc?.accountId && sharedAccount?.login === acc?.login)) {
      return;
    }
    sharedAccount = acc;
    setAccount(acc);
    notifySubscribers();
  };

  const updateSharedRepositories = (repos: GitHubRepository[]) => {
    if (sharedRepositories === repos || (sharedRepositories.length === repos.length && sharedRepositories.every((r, idx) => r.id === repos[idx]?.id))) {
      return;
    }
    sharedRepositories = repos;
    setRepositories(repos);
    notifySubscribers();
  };

  const updateSharedAuth = (auth: PendingGitHubAuthorization | null) => {
    sharedAuth = auth;
    setAuthorization(auth);
    notifySubscribers();
  };

  const loadRepositories = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<Result<GitHubRepository[]>>('github_list_repositories', { page: 1, perPage: 100 });
      if (result.ok && result.data) {
        updateSharedRepositories(result.data);
        const store = await getStore();
        await store.set(STORE_KEYS.GITHUB_REPOSITORY_CACHE, { repositories: result.data, cachedAt: new Date().toISOString() });
      } else {
        setMessage(result.message);
      }
    } catch (err) {
      console.error('Failed to load GitHub repositories:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAccount = useCallback(async () => {
    let result: Result<GitHubAccount>;
    try {
      result = await invoke<Result<GitHubAccount>>('github_current_account');
    } catch {
      updateSharedAccount(null);
      return null;
    }

    if (result.ok && result.data) {
      updateSharedAccount(result.data);
      const store = await getStore();
      await store.set(STORE_KEYS.GITHUB_ACCOUNT, result.data);

      // Load cached repositories from store if available
      try {
        const cached = await store.get<{ repositories: GitHubRepository[] }>(STORE_KEYS.GITHUB_REPOSITORY_CACHE);
        if (cached?.repositories && Array.isArray(cached.repositories) && cached.repositories.length > 0) {
          updateSharedRepositories(cached.repositories);
        } else {
          void loadRepositories();
        }
      } catch {
        void loadRepositories();
      }

      return result.data;
    }

    updateSharedAccount(null);
    return null;
  }, [loadRepositories]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  const pollAuthorization = useCallback(async (start: DeviceAuthorization, run: number) => {
    let interval = Math.max(5, start.interval);
    const deadline = Date.now() + start.expiresIn * 1000;
    updateSharedAuth({ userCode: start.userCode, verificationUri: start.verificationUri, expiresAt: deadline, status: 'waiting' });

    while (Date.now() < deadline && authorizationRun.current === run) {
      await new Promise((resolve) => window.setTimeout(resolve, interval * 1000));
      if (authorizationRun.current !== run) return;
      const completed = await invoke<Result<boolean>>('github_complete_authorization', { deviceCode: start.deviceCode });
      if (completed.ok) {
        await refreshAccount();
        await loadRepositories();
        updateSharedAuth(null);
        setMessage('GitHub connected! Opening GitHub App setup…');
        setShowInstallGuide(true);
        void openAppInstallUrl();
        return;
      }
      if (completed.category === 'slow_down') {
        interval += 5;
        continue;
      }
      if (completed.category !== 'authorization_pending') {
        updateSharedAuth(sharedAuth ? { ...sharedAuth, status: 'failed' } : null);
        setMessage(completed.message);
        return;
      }
    }
    if (authorizationRun.current === run) {
      updateSharedAuth(sharedAuth ? { ...sharedAuth, status: 'expired' } : null);
      setMessage('GitHub authorization expired. Start again to reauthorize.');
    }
  }, [refreshAccount, loadRepositories]);

  const connect = useCallback(async () => {
    setLoading(true); setMessage('');
    try {
      const start = await invoke<Result<DeviceAuthorization>>('github_start_authorization');
      if (!start.ok || !start.data) { setMessage(start.message); return; }
      const run = authorizationRun.current + 1;
      authorizationRun.current = run;
      updateSharedAuth({ userCode: start.data.userCode, verificationUri: start.data.verificationUri, expiresAt: Date.now() + start.data.expiresIn * 1000, status: 'ready' });
      void pollAuthorization(start.data, run);
    } finally { setLoading(false); }
  }, [pollAuthorization]);

  const openVerification = useCallback(async () => {
    if (!authorization) return;
    try {
      await openUrl(authorization.verificationUri);
      setMessage('Enter the code on GitHub. Waiting for authorization…');
    } catch (error) {
      console.error('Failed to open GitHub authorization page:', error);
      updateSharedAuth(sharedAuth ? { ...sharedAuth, status: 'failed' } : null);
      setMessage('Could not open GitHub. Open the verification URL manually and enter the code.');
    }
  }, [authorization]);

  const cancelAuthorization = useCallback(() => {
    authorizationRun.current += 1;
    updateSharedAuth(sharedAuth ? { ...sharedAuth, status: 'cancelled' } : null);
    setMessage('GitHub authorization cancelled.');
  }, []);

  useEffect(() => () => { authorizationRun.current += 1; }, []);

  const disconnect = useCallback(async () => {
    const result = await invoke<Result<boolean>>('github_disconnect');
    if (!result.ok) { setMessage(result.message); return; }
    const store = await getStore();
    await store.delete(STORE_KEYS.GITHUB_ACCOUNT);
    await store.delete(STORE_KEYS.GITHUB_REPOSITORY_CACHE);
    updateSharedAccount(null);
    updateSharedRepositories([]);
    updateSharedAuth(null);
    setMessage('GitHub authorization disconnected.');
  }, []);

  const loadBranches = useCallback(async (repository: GitHubRepository) => {
    const result = await invoke<Result<GitHubBranch[]>>('github_list_branches', { owner: repository.owner, repository: repository.name, page: 1, perPage: 100 });
    if (!result.ok) { setMessage(result.message); return []; }
    return result.data ?? [];
  }, []);

  return {
    account,
    repositories,
    loading,
    message,
    authorization,
    showInstallGuide,
    setShowInstallGuide,
    openAppInstall: openAppInstallUrl,
    connect,
    openVerification,
    cancelAuthorization,
    disconnect,
    loadRepositories,
    loadBranches,
    refreshAccount,
  };
}
