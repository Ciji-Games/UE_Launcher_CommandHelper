import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { STORE_KEYS } from '../config';
import { getStore } from './useStore';
import type { GitHubAccount, GitHubBranch, GitHubRepository } from '../types';

interface Result<T> { ok: boolean; data?: T; category?: string; message: string }
interface DeviceAuthorization { userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }
export type GitHubAuthorizationStatus = 'ready' | 'waiting' | 'expired' | 'cancelled' | 'failed';
export interface PendingGitHubAuthorization {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  status: GitHubAuthorizationStatus;
}

export function useGitHub() {
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [authorization, setAuthorization] = useState<PendingGitHubAuthorization | null>(null);
  const authorizationRun = useRef(0);

  const refreshAccount = useCallback(async () => {
    let result: Result<GitHubAccount>;
    try { result = await invoke<Result<GitHubAccount>>('github_current_account'); } catch { setAccount(null); return null; }
    if (result.ok && result.data) {
      setAccount(result.data);
      const store = await getStore();
      await store.set(STORE_KEYS.GITHUB_ACCOUNT, result.data);
      return result.data;
    }
    setAccount(null);
    return null;
  }, []);

  useEffect(() => { void refreshAccount(); }, [refreshAccount]);

  const pollAuthorization = useCallback(async (start: DeviceAuthorization, run: number) => {
    let interval = Math.max(5, start.interval);
    const deadline = Date.now() + start.expiresIn * 1000;
    setAuthorization({ userCode: start.userCode, verificationUri: start.verificationUri, expiresAt: deadline, status: 'waiting' });
    while (Date.now() < deadline && authorizationRun.current === run) {
      await new Promise((resolve) => window.setTimeout(resolve, interval * 1000));
      if (authorizationRun.current !== run) return;
      const completed = await invoke<Result<boolean>>('github_complete_authorization', { deviceCode: start.deviceCode });
      if (completed.ok) {
        await refreshAccount();
        setAuthorization(null);
        setMessage('GitHub account connected.');
        return;
      }
      if (completed.category === 'slow_down') {
        interval += 5;
        continue;
      }
      if (completed.category !== 'authorization_pending') {
        setAuthorization((previous) => previous ? {...previous, status: 'failed'} : previous);
        setMessage(completed.message);
        return;
      }
    }
    if (authorizationRun.current === run) {
      setAuthorization((previous) => previous ? {...previous, status: 'expired'} : previous);
      setMessage('GitHub authorization expired. Start again to reauthorize.');
    }
  }, [refreshAccount]);

  const connect = useCallback(async () => {
    setLoading(true); setMessage('');
    try {
      const start = await invoke<Result<DeviceAuthorization>>('github_start_authorization');
      if (!start.ok || !start.data) { setMessage(start.message); return; }
      const run = authorizationRun.current + 1;
      authorizationRun.current = run;
      setAuthorization({ userCode: start.data.userCode, verificationUri: start.data.verificationUri, expiresAt: Date.now() + start.data.expiresIn * 1000, status: 'ready' });
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
      setAuthorization((previous) => previous ? {...previous, status: 'failed'} : previous);
      setMessage('Could not open GitHub. Open the verification URL manually and enter the code.');
    }
  }, [authorization]);

  const cancelAuthorization = useCallback(() => {
    authorizationRun.current += 1;
    setAuthorization((previous) => previous ? {...previous, status: 'cancelled'} : previous);
    setMessage('GitHub authorization cancelled.');
  }, []);

  useEffect(() => () => { authorizationRun.current += 1; }, []);

  const disconnect = useCallback(async () => {
    const result = await invoke<Result<boolean>>('github_disconnect');
    if (!result.ok) { setMessage(result.message); return; }
    const store = await getStore();
    await store.delete(STORE_KEYS.GITHUB_ACCOUNT);
    await store.delete(STORE_KEYS.GITHUB_REPOSITORY_CACHE);
    setAccount(null); setRepositories([]); setMessage('GitHub authorization disconnected.');
  }, []);

  const loadRepositories = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<Result<GitHubRepository[]>>('github_list_repositories', { page: 1, perPage: 100 });
      if (result.ok && result.data) {
        setRepositories(result.data);
        const store = await getStore();
        await store.set(STORE_KEYS.GITHUB_REPOSITORY_CACHE, { repositories: result.data, cachedAt: new Date().toISOString() });
      } else setMessage(result.message);
    } finally { setLoading(false); }
  }, []);

  const loadBranches = useCallback(async (repository: GitHubRepository) => {
    const result = await invoke<Result<GitHubBranch[]>>('github_list_branches', { owner: repository.owner, repository: repository.name, page: 1, perPage: 100 });
    if (!result.ok) { setMessage(result.message); return []; }
    return result.data ?? [];
  }, []);

  return { account, repositories, loading, message, authorization, connect, openVerification, cancelAuthorization, disconnect, loadRepositories, loadBranches, refreshAccount };
}