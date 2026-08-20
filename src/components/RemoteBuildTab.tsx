import {useEffect, useMemo, useState} from 'react';
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
import {useProgress} from '../contexts/ProgressContext';
import {OutputLogPanel} from './OutputLogPanel';
import type {CheckoutStatus, GitHubBranch, RemoteBuildProfile, RemoteBuildProgressStages} from '../types';

const panel = 'rounded-xl border border-slate-700 bg-slate-900/60 p-4';
const field = 'mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200';
function statusLabel(profile: RemoteBuildProfile) {
    if (profile.lastStatus === 'running') return 'Building';
    if (profile.lastStatus === 'pulling') return 'Pulling changes';
    if (profile.lastStatus === 'fetching') return 'Fetching remote';
    if (profile.lastStatus === 'checking') return 'Checking remote';
    if (profile.cloneStatus !== 'ready') return profile.cloneStatus === 'failed' ? 'Clone failed' : 'Not cloned';
    if (profile.lastStatus === 'failed') return 'Failed';
    if (profile.lastStatus === 'blocked') return 'Blocked';
    if (profile.lastStatus === 'success') return 'Succeeded';
    return profile.enabled ? 'Idle (Scheduled)' : 'Stopped';
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
    const {pullNow, scheduleNextAt, scheduleRunning, scheduleIntervalMinutes, keepBuildsEnabled, keepBuildsCount, archiveOnly, applyScheduleSettings} = useRemoteBuild();
    const {account, repositories, loading, message, authorization, connect, openVerification, cancelAuthorization, disconnect, loadRepositories, loadBranches} = useGitHub();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [branches, setBranches] = useState<GitHubBranch[]>([]);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [destinationErrors, setDestinationErrors] = useState<Record<string, string | undefined>>({});
    const [now, setNow] = useState(() => Date.now());
    const [showOutputLog, setShowOutputLog] = useState(false);
    const [codeCopied, setCodeCopied] = useState(false);
    const [repositorySearch, setRepositorySearch] = useState('');
    const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
    const [scheduleSettingsOpen, setScheduleSettingsOpen] = useState(false);
    const [draftInterval, setDraftInterval] = useState(scheduleIntervalMinutes);
    const [draftKeepEnabled, setDraftKeepEnabled] = useState(keepBuildsEnabled);
    const [draftKeepCount, setDraftKeepCount] = useState(String(keepBuildsCount));
    const [draftArchiveOnly, setDraftArchiveOnly] = useState(archiveOnly);
    const {running} = useProgress();
    const editing = profiles.find((profile) => profile.id === editingId) ?? null;
    const patch = (profile: RemoteBuildProfile, updates: Partial<RemoteBuildProfile>) => updateProfile(profile.id, updates);
    const openScheduleSettings = () => {
        setDraftInterval(scheduleIntervalMinutes);
        setDraftKeepEnabled(keepBuildsEnabled);
        setDraftKeepCount(String(keepBuildsCount));
        setDraftArchiveOnly(archiveOnly);
        setScheduleSettingsOpen(true);
    };
    const applySettings = async () => {
        await applyScheduleSettings({
            intervalMinutes: draftInterval,
            keepBuildsEnabled: draftKeepEnabled,
            keepBuildsCount: Number(draftKeepCount),
            archiveOnly: draftArchiveOnly,
        });
        setScheduleSettingsOpen(false);
    };
    const repositoryGroups = useMemo(() => {
        const search = repositorySearch.trim().toLowerCase();
        const groups = new Map<string, typeof repositories>();
        repositories.forEach((repository) => {
            if (search && !`${repository.owner} ${repository.name} ${repository.fullName}`.toLowerCase().includes(search)) return;
            const group = groups.get(repository.owner) ?? [];
            group.push(repository);
            groups.set(repository.owner, group);
        });
        return [...groups.entries()];
    }, [repositories, repositorySearch]);
    const copyAuthorizationCode = async () => {
        if (!authorization) return;
        try {
            await navigator.clipboard.writeText(authorization.userCode);
            setCodeCopied(true);
            window.setTimeout(() => setCodeCopied(false), 1500);
        } catch {
            setCodeCopied(false);
        }
    };

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
        if (running) setShowOutputLog(true);
    }, [running]);
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
        setRepositoryPickerOpen(false);
        setRepositorySearch('');
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
        await patch(profile, {
            cloneStatus: 'cloning',
            setupStatus: 'untested',
            enabled: false,
            lastError: undefined,
            progressStages: {...profile.progressStages, clone: 'running', repo: 'pending', package: 'disabled', zip: 'disabled', cleanup: 'pending'},
        });
        try {
            const checkoutPath = remoteBuildCheckoutPath(profile.repositoryPath);
            const result = await invoke<{
                ok: boolean;
                error?: string
            }>('clone_github_repository', {
                cloneUrl: profile.repository.cloneUrl,
                destination: checkoutPath,
                buildBranch: profile.buildBranch
            });
            if (!result.ok) throw new Error(result.error ?? 'Clone failed.');

            let projectPath = profile.projectPath;
            try {
                const status = await invoke<CheckoutStatus>('inspect_remote_build_checkout', {
                    repositoryPath: checkoutPath,
                    remoteName: profile.remoteName || 'origin',
                    buildBranch: profile.buildBranch,
                });
                if (status.projects.length > 0 && !projectPath) {
                    projectPath = status.projects[0].projectPath;
                }
            } catch {
                // inspection will also occur on check
            }

            await patch(profile, {
                cloneStatus: 'ready',
                setupStatus: 'passed',
                projectPath,
                lastError: undefined,
                progressStages: {...profile.progressStages, clone: 'success', repo: 'pending', package: 'disabled', zip: 'disabled', cleanup: 'pending'},
            });
        } catch (error) {
            await patch(profile, {
                cloneStatus: 'failed',
                setupStatus: 'failed',
                lastError: error instanceof Error ? error.message : String(error),
                progressStages: {...profile.progressStages, clone: 'failed'},
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
            nextCheckAt: undefined,
        });
    };

    return <section className='flex min-h-0 flex-1 flex-col gap-4 pr-1'>
        <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto'>
        <header><h1 className='text-xl font-semibold text-slate-100'>Automatic build</h1><p
            className='mt-1 text-sm text-slate-400'>Connect GitHub, then manage enabled jobs in one global schedule.</p>
            <div className='mt-3 flex flex-wrap items-center gap-3 text-xs'>
                <span className='font-medium text-sky-300'>{scheduleRunning ? 'Running scheduled check…' : formatCountdown(scheduleNextAt, now) ?? 'Schedule waits for an enabled job'}</span>
                <button type='button' onClick={openScheduleSettings}
                        className='rounded border border-slate-700 px-3 py-1.5 text-slate-300 hover:border-sky-500 hover:text-sky-300'>Build settings</button>
            </div>
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
                </div> : <button type='button' disabled={loading || authorization?.status === 'ready' || authorization?.status === 'waiting'} onClick={() => void connect()}
                                 className='rounded bg-sky-500 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-50'>{loading ? 'Connecting…' : 'Connect GitHub'}</button>}
            </div>
            {authorization && <div className='mt-4 rounded-lg border border-sky-800/70 bg-sky-950/30 p-3'>
                <p className='text-sm text-slate-200'>Your GitHub code is:</p>
                <div className='mt-2 flex flex-wrap items-center gap-2'>
                    <input aria-label='GitHub authorization code' readOnly value={authorization.userCode}
                           className='w-40 rounded border border-slate-600 bg-slate-950 px-3 py-2 text-center font-mono text-lg tracking-widest text-slate-100'/>
                    <button type='button' onClick={() => void copyAuthorizationCode()} className='rounded border border-slate-600 px-3 py-2 text-xs text-slate-300'>{codeCopied ? 'Copied' : 'Copy code'}</button>
                </div>
                <div className='mt-3 flex flex-wrap gap-2'>
                    <button type='button' onClick={() => void openVerification()} disabled={authorization.status === 'expired' || authorization.status === 'cancelled'} className='rounded bg-sky-500 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-50'>Open GitHub</button>
                    <button type='button' onClick={cancelAuthorization} className='rounded border border-slate-600 px-3 py-2 text-xs text-slate-300'>Cancel</button>
                </div>
                <p className='mt-3 text-xs text-slate-400'>Enter the code on GitHub to authorize this application. {authorization.status === 'waiting' ? 'Waiting for authorization…' : authorization.status === 'ready' ? 'Ready to authorize.' : authorization.status === 'expired' ? 'This code has expired.' : 'Authorization failed.'}</p>
                <p className='mt-1 text-xs text-slate-500'>Expires in {(() => { const seconds = Math.max(0, Math.ceil((authorization.expiresAt - now) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; })()}</p>
            </div>}
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
                    const stages = profile.progressStages;
                    const renderStage = (label: string, status: keyof RemoteBuildProgressStages, percent?: number, hidden = false) => {
                        if (hidden) return null;
                        const state = stages[status];
                        const value = state === 'success' ? 100 : state === 'running' ? Math.round(percent ?? 0) : 0;
                        const color = state === 'success' ? 'bg-emerald-400' : state === 'failed' ? 'bg-red-400' : state === 'disabled' ? 'bg-slate-700' : 'bg-sky-400';
                        return <div key={status} className='min-w-40 flex-1'>
                            <div className='mb-1 flex justify-between text-xs text-slate-400'><span>{label}{state === 'disabled' ? ' (disabled)' : ''}</span><span>{state === 'success' ? 'Done' : state === 'failed' ? 'Failed' : state === 'running' ? `${value}%` : ''}</span></div>
                            <div className='h-2 overflow-hidden rounded bg-slate-800'><div className={`h-full transition-all ${color}`} style={{width: state === 'disabled' ? '100%' : `${value}%`}}/></div>
                        </div>;
                    };
                    return <div key={profile.id} className='rounded-lg border border-slate-700 bg-slate-950/40 p-4'>
                        <div className='flex flex-wrap items-start justify-between gap-3'>
                            <div><h3 className='font-medium text-slate-100'>{profile.name || 'Unnamed profile'}</h3><p
                                className='mt-1 text-xs text-slate-400'>{profile.repository?.fullName ?? 'No repository'}{profile.buildBranch ? ' · ' + profile.buildBranch : ''}</p>
                                <p className='mt-1 text-xs text-slate-500'>{statusLabel(profile)}{profile.lastError ? ' · ' + profile.lastError : ''}</p></div>
                            <span
                                className={`rounded px-2 py-1 text-xs font-medium ${profile.enabled ? 'border border-sky-800/60 bg-sky-950/80 text-sky-300' : 'bg-slate-800 text-slate-400'}`}>{profile.enabled ? 'Scheduled' : 'Stopped'}</span>
                        </div>
                        {(profile.cloneStatus === 'cloning' || profile.cloneStatus === 'failed' || profile.cloneStatus === 'ready') && <div className='mt-3 flex gap-3 overflow-x-auto pb-1'>
                            {profile.cloneStatus !== 'ready' && renderStage('Clone', 'clone')}
                            {profile.cloneStatus === 'ready' && <>
                                {renderStage('Repo', 'repo')}
                                {renderStage('Package', 'package', profile.buildProgress)}
                                {renderStage('Zipping', 'zip', profile.zipProgress, stages.zip === 'disabled')}
                                {renderStage('Cleanup', 'cleanup')}
                            </>}
                        </div>}
                        <div className='mt-3 flex flex-wrap gap-2'>
                            <button type='button' disabled={!account} onClick={() => edit(profile)}
                                    className='rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-40'>Edit
                            </button>
                            <button type='button'
                                    disabled={!account || busy || Boolean(destinationErrors[profile.id]) || !profile.repository || !profile.repositoryPath || !profile.buildBranch}
                                    onClick={() => void clone(profile)}
                                    className='rounded border border-indigo-400/60 px-3 py-1.5 text-xs text-indigo-300 disabled:opacity-40'>{busy ? 'Cloning…' : 'Clone'}</button>
                            {profile.cloneStatus === 'ready' && <button type='button'
                                    disabled={!account || busy || profile.cloneStatus !== 'ready'}
                                    onClick={() => void pullNow(profile)}
                                    className='rounded border border-sky-400/60 px-3 py-1.5 text-xs text-sky-300 disabled:opacity-40'>Pull
                                now
                            </button>}
                            {profile.cloneStatus === 'ready' && <button type='button'
                                    disabled={!account || busy || (!profile.enabled && profile.cloneStatus !== 'ready')}
                                    onClick={() => void toggleSchedule(profile)}
                                    className='rounded border border-emerald-400/60 px-3 py-1.5 text-xs text-emerald-300 disabled:opacity-40'>{profile.enabled ? 'Disable job' : 'Enable job'}</button>
                            }
                            <button type='button' disabled={!account} onClick={() => void removeProfile(profile.id)}
                                    className='rounded border border-red-400/40 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40'>Delete
                            </button>
                        </div>
                        <div className='mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-3'>
                            <span>Setup: {profile.setupStatus}</span><span>Last built: {profile.lastBuiltCommit?.slice(0, 12) ?? '-'}</span><span>Output: {remoteBuildOutputRoot(profile.repositoryPath) || '-'}</span>
                        </div>
                    </div>;
                })}</div>}</div>
        </div>
        {scheduleSettingsOpen && <div className='fixed inset-0 z-30 flex items-center justify-center bg-slate-950/80 p-4' role='dialog' aria-modal='true' aria-labelledby='automatic-build-settings-title'>
            <div className='w-full max-w-md rounded-xl border border-slate-600 bg-slate-900 p-5 shadow-2xl'>
                <div className='flex items-center justify-between gap-4'>
                    <div><h2 id='automatic-build-settings-title' className='text-lg font-semibold text-slate-100'>Automatic build settings</h2><p className='mt-1 text-xs text-slate-500'>These settings apply to every automatic-build profile.</p></div>
                    <button type='button' onClick={() => setScheduleSettingsOpen(false)} className='text-slate-400' aria-label='Close'>×</button>
                </div>
                <div className='mt-5 space-y-4'>
                    <label className='block text-xs text-slate-400'>Schedule interval<select value={String(draftInterval)} onChange={(event) => setDraftInterval(Number(event.target.value))} className={field}>
                        {REMOTE_BUILD_INTERVALS.map((minutes) => <option key={minutes} value={minutes}>{minutes} minute{minutes === 1 ? '' : 's'}</option>)}
                    </select></label>
                    <div>
                        <label className='flex items-center gap-2 text-sm text-slate-300'><input type='checkbox' checked={draftKeepEnabled} onChange={(event) => setDraftKeepEnabled(event.target.checked)} className='accent-sky-500'/>
                            Keep only a limited number of builds
                        </label>
                        <p className='mt-1 text-xs text-slate-500'>Older packaged builds are removed before a new build starts.</p>
                        {draftKeepEnabled && <label className='mt-2 block pl-6 text-xs text-slate-400'>Keep newest builds<input type='number' min='1' step='1' value={draftKeepCount} onChange={(event) => setDraftKeepCount(event.target.value)} className={field}/></label>}
                    </div>
                    <div>
                        <label className='flex items-center gap-2 text-sm text-slate-300'><input type='checkbox' checked={draftArchiveOnly} onChange={(event) => setDraftArchiveOnly(event.target.checked)} className='accent-sky-500'/>
                            Store builds as archives only
                        </label>
                        <p className='mt-1 text-xs text-slate-500'>After packaging, the build folder is zipped and the unpacked files are deleted.</p>
                    </div>
                </div>
                <div className='mt-6 flex justify-end gap-2'>
                    <button type='button' onClick={() => setScheduleSettingsOpen(false)} className='rounded border border-slate-700 px-4 py-2 text-xs text-slate-300'>Cancel</button>
                    <button type='button' onClick={() => void applySettings()} className='rounded bg-sky-500 px-4 py-2 text-xs font-medium text-slate-950'>Apply</button>
                </div>
            </div>
        </div>}
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
                        repository<div className='relative mt-1'>
                            <button type='button' onClick={() => setRepositoryPickerOpen((open) => !open)}
                                    className={`${field} flex items-center justify-between text-left`} aria-haspopup='listbox'
                                    aria-expanded={repositoryPickerOpen}>
                                <span className={editing.repository ? 'text-slate-200' : 'text-slate-500'}>{editing.repository?.fullName ?? 'Select repository'}</span>
                                <span className='ml-2 text-slate-500'>▾</span>
                            </button>
                            {repositoryPickerOpen && <div className='absolute z-30 mt-1 max-h-72 w-full overflow-hidden rounded border border-slate-600 bg-slate-900 shadow-xl'>
                                <div className='border-b border-slate-700 p-2'>
                                    <input autoFocus value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)}
                                           placeholder='Search repositories…' aria-label='Search repositories'
                                           className='w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500'/>
                                </div>
                                <div className='max-h-56 overflow-y-auto py-1' role='listbox' aria-label='Repositories'>
                                    {repositoryGroups.length === 0 ? <p className='px-3 py-2 text-xs text-slate-500'>No repositories found.</p> : repositoryGroups.map(([owner, ownerRepositories]) => <div key={owner}>
                                        <p className='sticky top-0 bg-slate-900 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500'>{owner}</p>
                                        {ownerRepositories.map((repository) => <button type='button' role='option' aria-selected={editing.repository?.id === repository.id} key={repository.id}
                                                                                         onClick={() => void chooseRepository(editing, repository.id)}
                                                                                         className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-800 ${editing.repository?.id === repository.id ? 'bg-slate-800 text-sky-300' : 'text-slate-300'}`}>
                                            <span>{repository.name}</span><span className='ml-2 text-xs text-slate-500'>{repository.private ? 'Private' : 'Public'}</span>
                                        </button>)}
                                    </div>)}
                                </div>
                            </div>}
                        </div></label><label className='block text-xs text-slate-400'>Choose a branch<select
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
                    </select></label></div>
                    <div className='mt-5 flex justify-end'>
                        <button type='button' onClick={() => setEditingId(null)}
                                className='rounded border border-slate-700 px-4 py-2 text-xs text-slate-300'>Done
                        </button>
                    </div>
                </div>
            </div>}
        <div className={`flex min-w-0 flex-col overflow-hidden rounded-lg border border-slate-600/60 bg-slate-800/40 transition-all ${showOutputLog ? 'flex-[0_0_30%] min-h-0' : 'shrink-0'}`}>
            <button type='button' onClick={() => setShowOutputLog((previous) => !previous)} className='flex w-full items-center justify-between px-4 py-2 text-left transition-colors hover:bg-slate-700/50'>
                <span className='text-sm font-medium text-slate-300'>Output Log{running ? ' · Running' : ''}</span><span className={`inline-block text-xs text-slate-400 transition-transform ${showOutputLog ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {showOutputLog && <div className='flex min-h-0 flex-1 flex-col overflow-hidden border-t border-slate-600/60 p-4'><OutputLogPanel /></div>}
        </div>
    </section>;
}
