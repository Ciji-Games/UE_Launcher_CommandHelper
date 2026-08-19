import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { STORE_KEYS } from '../config';
import { getStore } from './useStore';
import type { GitHubAccount, GitHubBranch, GitHubRepository } from '../types';

interface Result<T> { ok: boolean; data?: T; category?: string; message: string }
interface DeviceAuthorization { userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }

export function useGitHub() {
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

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

  const connect = useCallback(async () => {
    setLoading(true); setMessage('');
    try {
      const start = await invoke<Result<DeviceAuthorization>>('github_start_authorization');
      if (!start.ok || !start.data) { setMessage(start.message); return; }
      await openUrl(start.data.verificationUri);
      setMessage(`Enter code ${start.data.userCode} in the GitHub browser window.`);
      const deadline = Date.now() + start.data.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, Math.max(5, start.data!.interval) * 1000));
        const completed = await invoke<Result<boolean>>('github_complete_authorization', { deviceCode: start.data.deviceCode });
        if (completed.ok) { await refreshAccount(); setMessage('GitHub account connected.'); return; }
        if (completed.category !== 'authorization_pending' && completed.category !== 'slow_down') { setMessage(completed.message); return; }
      }
      setMessage('GitHub authorization timed out. Start again to reauthorize.');
    } finally { setLoading(false); }
  }, [refreshAccount]);

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

  return { account, repositories, loading, message, connect, disconnect, loadRepositories, loadBranches, refreshAccount };
}