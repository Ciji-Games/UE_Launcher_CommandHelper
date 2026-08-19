import {useEffect, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-dialog';
import {
    createRemoteBuildProfile,
    remoteBuildCheckoutPath,
    remoteBuildOutputRoot,
    REMOTE_BUILD_INTERVALS,
    useRemoteBuildProfiles
} from '../hooks/useRemoteBuildProfiles';
import {useRemoteBuild} from '../hooks/useRemoteBuild';
import {useGitHub} from '../hooks/useGitHub';
import type {GitHubBranch, RemoteBuildProfile} from '../types';

const panel = 'rounded-xl border border-slate-700 bg-slate-900/60 p-4';
const field = 'mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200';
function statusLabel(profile: RemoteBuildProfile) {
    if (profile.lastStatus === 'running') return 'Building';
    if (profile.lastStatus === 'pulling') return 'Pulling changes';
    if (profile.lastStatus === 'fetching') return 'Fetching remote status';
    if (profile.lastStatus === 'checking') return 'Checking remote status';
    if (profile.cloneStatus !== 'ready') return profile.cloneStatus === 'failed' ? 'Clone failed' : 'Not cloned';
    return profile.enabled ? 'Schedule running' : 'Ready to schedule';
}

function formatCountdown(nextCheckAt: string | undefined, now: number) {
    if (!nextCheckAt) return null;
    const remainingSeconds = Math.max(0, Math.ceil((Date.parse(nextCheckAt) - now) / 1000));
    if (remainingSeconds === 0) return 'Checking now';
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `Next check in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function RemoteBuildTab() {
    const {profiles, addProfile, updateProfile, removeProfile, setActive, refresh} = useRemoteBuildProfiles();
    const {pullNow} = useRemoteBuild();
    const {account, repositories, loading, message, connect, disconnect, loadRepositories, loadBranches} = useGitHub();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [branches, setBranches] = useState<GitHubBranch[]>([]);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [destinationErrors, setDestinationErrors] = useState<Record<string, string | undefined>>({});
    const [now, setNow] = useState(() => Date.now());
    const editing = profiles.find((profile) => profile.id === editingId) ?? null;
    const patch = (profile: RemoteBuildProfile, updates: Partial<RemoteBuildProfile>) => updateProfile(profile.id, updates);

    useEffect(() => {
        if (account && repositories.length === 0) void loadRepositories();
    }, [account, repositories.length, loadRepositories]);
    useEffect(() => {
        if (editing?.repository) void loadBranches(editing.repository).then(setBranches); else setBranches([]);
    }, [editing?.id, editing?.repository, loadBranches]);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    useEffect(() => {
        const timer = window.setInterval(() => void refresh(), 2000);
        return () => window.clearInterval(timer);
    }, [refresh]);
    useEffect(() => {
        let cancelled = false;
        const validateDestinations = async () => {
            const results = await Promise.all(profiles.map(async (profile) => {
                if (!profile.repositoryPath) return [profile.id, undefined] as const;
                const result = await invoke<{
                    ok: boolean;
                    error?: string
                }>('validate_clone_destination', {destination: remoteBuildCheckoutPath(profile.repositoryPath)});
                return [profile.id, result.ok ? undefined : result.error ?? 'The clone destination is not empty.'] as const;
            }));
            if (!cancelled) setDestinationErrors(Object.fromEntries(results));
        };
        void validateDestinations();
        return () => {
            cancelled = true;
        };
    }, [profiles]);

    const edit = (profile: RemoteBuildProfile) => {
        void setActive(profile.id);
        setEditingId(profile.id);
    };
    const create = async () => {
        const profile = await addProfile(createRemoteBuildProfile());
        setEditingId(profile.id);
    };
    const chooseRepository = async (profile: RemoteBuildProfile, id: string) => {
        const repository = repositories.find((item) => item.id === id);
        if (!repository) return;
        setBranches(await loadBranches(repository));
        await patch(profile, {
            repository,
            buildBranch: '',
            repositoryPath: '',
            outputPath: '',
            projectPath: '',
            enginePath: '',
            cloneStatus: 'not-started',
            setupStatus: 'untested',
            enabled: false,
            lastError: undefined
        });
    };
    const choosePath = (profile: RemoteBuildProfile, path: string) => patch(profile, {
        repositoryPath: path,
        outputPath: remoteBuildOutputRoot(path),
        cloneStatus: 'not-started',
        setupStatus: 'untested',
        enabled: false
    });
    const browsePath = async () => {
        if (!editing) return;
        const selected = await open({directory: true, multiple: false});
        if (typeof selected === 'string') await choosePath(editing, selected);
    };
    const clone = async (profile: RemoteBuildProfile) => {
        if (!profile.repository || !profile.repositoryPath || !profile.buildBranch || destinationErrors[profile.id]) return;
        setBusyId(profile.id);
        await patch(profile, {cloneStatus: 'cloning', setupStatus: 'untested', enabled: false, lastError: undefined});
        try {
            const result = await invoke<{
                ok: boolean;
                error?: string
            }>('clone_github_repository', {
                cloneUrl: profile.repository.cloneUrl,
                destination: remoteBuildCheckoutPath(profile.repositoryPath),
                buildBranch: profile.buildBranch
            });
            if (!result.ok) throw new Error(result.error ?? 'Clone failed.');
            await patch(profile, {
                cloneStatus: 'ready',
                setupStatus: 'passed',
                lastError: undefined
            });
        } catch (error) {
            await patch(profile, {
                cloneStatus: 'failed',
                setupStatus: 'failed',
                lastError: error instanceof Error ? error.message : String(error)
            });
        } finally {
            setBusyId(null);
        }
    };
    const toggleSchedule = async (profile: RemoteBuildProfile) => {
        if (!profile.enabled && profile.cloneStatus !== 'ready') return;
        await patch(profile, {
            enabled: !profile.enabled,
            lastStatus: 'idle',
            nextCheckAt: profile.enabled
                ? undefined
                : new Date(Date.now() + Math.max(1, profile.pollingIntervalMinutes) * 60_000).toISOString(),
        });
    };

    return <section className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1'>
        <header><h1 className='text-xl font-semibold text-slate-100'>Automatic build</h1><p
            className='mt-1 text-sm text-slate-400'>Connect GitHub, then manage build profiles and their schedules.</p>
        </header>
        <div className={panel}>
            <div className='flex items-center justify-between gap-4'>
                <div><h2 className='font-medium text-slate-200'>Step 1 · GitHub account</h2><p
                    className='mt-1 text-xs text-slate-500'>Private repositories may require the
                    GitHub <code>repo</code> permission and organization SSO approval.</p></div>
                {account ? <div className='flex items-center gap-3'><span className='text-sm text-emerald-300'>Connected as @{account.login}</span>
                    <button type='button' onClick={() => void disconnect()}
                            className='rounded border border-slate-700 px-3 py-2 text-xs text-slate-300'>Disconnect
                    </button>
                </div> : <button type='button' disabled={loading} onClick={() => void connect()}
                                 className='rounded bg-sky-500 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-50'>{loading ? 'Connecting…' : 'Connect GitHub'}</button>}
            </div>
            {message && <p className='mt-3 text-xs text-amber-300'>{message}</p>}</div>
        <div className={panel + (account ? '' : ' opacity-60')}>
            <div className='flex items-center justify-between gap-3'><h2 className='font-medium text-slate-200'>Step 2 ·
                Build profiles</h2>
                <button type='button' disabled={!account || loading} onClick={() => void create()}
                        className='rounded bg-sky-500 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-40'>Create
                    profile
                </button>
            </div>
            {profiles.length === 0 ? <p className='mt-6 text-center text-sm text-slate-500'>No build profiles yet.</p> :
                <div className='mt-4 space-y-3'>{profiles.map((profile) => {
                    const busy = busyId === profile.id;
                    const running = profile.lastStatus === 'running';
                    const countdown = profile.enabled ? formatCountdown(profile.nextCheckAt, now) : null;
                    return <div key={profile.id} className='rounded-lg border border-slate-700 bg-slate-950/40 p-4'>
                        <div className='flex flex-wrap items-start justify-between gap-3'>
                            <div><h3 className='font-medium text-slate-100'>{profile.name || 'Unnamed profile'}</h3><p
                                className='mt-1 text-xs text-slate-400'>{profile.repository?.fullName ?? 'No repository'}{profile.buildBranch ? ' · ' + profile.buildBranch : ''}</p>
                                <p className='mt-1 text-xs text-slate-500'>{statusLabel(profile)}{profile.lastError ? ' · ' + profile.lastError : ''}</p>{countdown &&
                                    <p className='mt-1 text-xs font-medium text-sky-300'>{countdown}</p>}</div>
                            <span
                                className='rounded bg-slate-800 px-2 py-1 text-xs text-slate-400'>{profile.enabled ? 'Scheduled' : 'Stopped'}</span>
                        </div>
                        {running && <div className='mt-3'>
                            <div className='mb-1 flex justify-between text-xs text-slate-400'>
                                <span>Build progress</span><span>{Math.round(profile.buildProgress ?? 0)}%</span></div>
                            <div className='h-2 overflow-hidden rounded bg-slate-800'>
                                <div className='h-full bg-sky-400 transition-all'
                                     style={{width: String(profile.buildProgress ?? 0) + '%'}}/>
                            </div>
                        </div>}
                        <div className='mt-3 flex flex-wrap gap-2'>
                            <button type='button' disabled={!account} onClick={() => edit(profile)}
                                    className='rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-40'>Edit
                            </button>
                            <button type='button'
                                    disabled={!account || busy || Boolean(destinationErrors[profile.id]) || !profile.repository || !profile.repositoryPath || !profile.buildBranch}
                                    onClick={() => void clone(profile)}
                                    className='rounded border border-indigo-400/60 px-3 py-1.5 text-xs text-indigo-300 disabled:opacity-40'>{busy ? 'Cloning…' : 'Clone'}</button>
                            <button type='button'
                                    disabled={!account || busy || profile.cloneStatus !== 'ready'}
                                    onClick={() => void pullNow(profile)}
                                    className='rounded border border-sky-400/60 px-3 py-1.5 text-xs text-sky-300 disabled:opacity-40'>Pull
                                now
                            </button>
                            <button type='button'
                                    disabled={!account || busy || (!profile.enabled && profile.cloneStatus !== 'ready')}
                                    onClick={() => void toggleSchedule(profile)}
                                    className='rounded border border-emerald-400/60 px-3 py-1.5 text-xs text-emerald-300 disabled:opacity-40'>{profile.enabled ? 'Stop schedule' : 'Start schedule'}</button>
                            <button type='button' disabled={!account} onClick={() => void removeProfile(profile.id)}
                                    className='rounded border border-red-400/40 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40'>Delete
                            </button>
                        </div>
                        <div className='mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-3'>
                            <span>Setup: {profile.setupStatus}</span><span>Last built: {profile.lastBuiltCommit?.slice(0, 12) ?? '-'}</span><span>Output: {remoteBuildOutputRoot(profile.repositoryPath) || '-'}</span>
                        </div>
                        {profile.logs && profile.logs.length > 0 && <details className='mt-3'>
                            <summary className='cursor-pointer text-xs text-slate-400'>Diagnostic log ({profile.logs.length})</summary>
                            <pre className='mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-2 text-[11px] leading-5 text-slate-400'>{profile.logs.map((entry) => `${new Date(entry.timestamp).toLocaleTimeString()}  ${entry.message}`).join('\n')}</pre>
                        </details>}
                    </div>;
                })}</div>}</div>
        {editing &&
            <div className='fixed inset-0 z-20 flex items-center justify-center bg-slate-950/80 p-4' role='dialog'
                 aria-modal='true'>
                <div className='w-full max-w-lg rounded-xl border border-slate-600 bg-slate-900 p-5 shadow-2xl'>
                    <div className='flex items-center justify-between'><h2
                        className='text-lg font-semibold text-slate-100'>Profile configuration</h2>
                        <button type='button' onClick={() => setEditingId(null)} className='text-slate-400'
                                aria-label='Close'>×
                        </button>
                    </div>
                    <div className='mt-4 space-y-3'><label className='block text-xs text-slate-400'>Profile name<input
                        value={editing.name} onChange={(event) => void patch(editing, {name: event.target.value})}
                        className={field}/></label><label className='block text-xs text-slate-400'>Choose a
                        repository<select value={editing.repository?.id ?? ''}
                                          onChange={(event) => void chooseRepository(editing, event.target.value)}
                                          className={field}>
                            <option value=''>Select repository</option>
                            {repositories.map((repository) => <option key={repository.id}
                                                                      value={repository.id}>{repository.fullName}</option>)}
                        </select></label><label className='block text-xs text-slate-400'>Choose a branch<select
                        value={editing.buildBranch} disabled={!editing.repository}
                        onChange={(event) => void patch(editing, {
                            buildBranch: event.target.value,
                            cloneStatus: 'not-started',
                            setupStatus: 'untested',
                            enabled: false
                        })} className={field}>
                        <option value=''>Select branch</option>
                        {branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
                    </select></label><label className='block text-xs text-slate-400'>Choose target folder
                        <div className='flex gap-2'><input value={editing.repositoryPath}
                                                           onChange={(event) => void choosePath(editing, event.target.value)}
                                                           placeholder='Folder for BuildRepo and PackagedBuild' className={field}/>
                            <button type='button' onClick={() => void browsePath()}
                                    className='mt-1 shrink-0 text-xs text-sky-400'>Browse
                            </button>
                        </div>
                    </label><p className='text-xs text-slate-500'>Package output: <code>{remoteBuildOutputRoot(editing.repositoryPath) || 'target folder/PackagedBuild/&lt;commit&gt;'}</code></p><label
                        className='block text-xs text-slate-400'>Platform<select value={editing.platform}
                                                                                 onChange={(event) => void patch(editing, {
                                                                                     platform: event.target.value,
                                                                                     setupStatus: 'untested'
                                                                                 })} className={field}>
                        <option>Win64</option>
                        <option>Linux</option>
                        <option>Mac</option>
                    </select></label><label className='block text-xs text-slate-400'>Package configuration<select
                        value={editing.packageConfig} onChange={(event) => void patch(editing, {
                        packageConfig: event.target.value,
                        setupStatus: 'untested'
                    })} className={field}>
                        <option>Development</option>
                                        <option>Shipping</option>
                    </select></label><label className='block text-xs text-slate-400'>Check frequency<select
                        value={String(editing.pollingIntervalMinutes)} onChange={(event) => void patch(editing, {
                        pollingIntervalMinutes: Number(event.target.value),
                        nextCheckAt: editing.enabled ? new Date(Date.now() + Number(event.target.value) * 60_000).toISOString() : undefined
                    })} className={field}>
                        {REMOTE_BUILD_INTERVALS.map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
                    </select></label></div>
                    <div className='mt-5 flex justify-end'>
                        <button type='button' onClick={() => setEditingId(null)}
                                className='rounded border border-slate-700 px-4 py-2 text-xs text-slate-300'>Done
                        </button>
                    </div>
                </div>
            </div>}
    </section>;
}
