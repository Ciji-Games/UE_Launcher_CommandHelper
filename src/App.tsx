import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { relaunch } from '@tauri-apps/plugin-process';
import { BaseLayout } from './components/BaseLayout';
import { LauncherTab } from './components/LauncherTab';
import { ToolBoxTab } from './components/ToolBoxTab';
import { SchedulerTab } from './components/SchedulerTab';
import { LinksTab } from './components/LinksTab';
import { ShaderBoosterBackground } from './components/ShaderBoosterBackground';
import { LogProvider } from './contexts/LogContext';
import { ProgressProvider } from './contexts/ProgressContext';
import { ProjectsProvider } from './contexts/ProjectsContext';
import { EnginesProvider } from './contexts/EnginesContext';
import { SettingsProvider } from './contexts/SettingsContext';
import IdeProvider from './contexts/IdeContext';
import { SettingsPanel } from './components/SettingsPanel';
import { checkForUpdate, type UpdateInfo } from './utils/updateCheck';

const TAB_ICONS = {
  launcher: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
    </svg>
  ),
  toolbox: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.25L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
    </svg>
  ),
  scheduler: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
    </svg>
  ),
  links: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
    </svg>
  ),
} as const;

const TABS = [
  { id: 'launcher' as const, label: 'Launcher' },
  { id: 'toolbox' as const, label: 'ToolBox' },
  { id: 'scheduler' as const, label: 'Scheduler' },
  { id: 'links' as const, label: 'Links' },
] as const;

function App() {
  const [activeTab, setActiveTab] = useState<'launcher' | 'toolbox' | 'scheduler' | 'links'>('launcher');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [schedulerOutputOpenSignal, setSchedulerOutputOpenSignal] = useState(0);
  const [quickRegenerateProjectPath, setQuickRegenerateProjectPath] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'installing' | 'failed'>('idle');
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    void checkForUpdate(__APP_VERSION__).then((info) => {
      setUpdateInfo(info);
      setUpdatePromptOpen(Boolean(info));
    });
  }, []);

  const openSchedulerWithOutput = () => {
    setActiveTab('scheduler');
    setSchedulerOutputOpenSignal((prev) => prev + 1);
  };

  const openQuickRegenerate = (projectPath: string) => {
    setQuickRegenerateProjectPath(projectPath);
    setActiveTab('toolbox');
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo?.update || updateStatus === 'installing') {
      return;
    }

    setUpdateStatus('installing');
    setUpdateError(null);
    setUpdateProgress(null);

    try {
      let downloaded = 0;
      let contentLength = 0;
      await updateInfo.update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setUpdateProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
        }
      });
      await relaunch();
    } catch (error) {
      console.error('Failed to install update:', error);
      setUpdateStatus('failed');
      setUpdateError(error instanceof Error ? error.message : 'The update could not be installed.');
    }
  };

  return (
    <SettingsProvider>
    <IdeProvider>
    <ProjectsProvider>
      <EnginesProvider>
      <LogProvider>
        <ProgressProvider>
          <ShaderBoosterBackground />
          <BaseLayout>
            <div className="flex flex-col gap-6 min-h-0 flex-1">
              {/* Tab navigation - horizontal, full width, with icons */}
              <nav className="flex gap-1 border-b border-slate-700/80 pb-0 shrink-0 items-center">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`group flex items-center gap-2.5 px-5 py-4 text-sm font-medium rounded-t ${
                      activeTab === tab.id
                        ? 'bg-slate-800/80 text-sky-400 border-b-2 border-sky-400 -mb-px'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                    }`}
                  >
                    <span className={activeTab === tab.id ? 'text-sky-400' : 'text-slate-500 group-hover:text-slate-400'}>{TAB_ICONS[tab.id]}</span>
                    {tab.label}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-2">
                  {updateInfo && (
                    <button
                      type="button"
                      onClick={() => setUpdatePromptOpen(true)}
                      className="flex items-center gap-1.5 rounded-full bg-sky-500 px-2.5 py-1 text-xs font-medium text-slate-950 shadow-sm transition-colors hover:bg-sky-400"
                      title={`Update v${updateInfo.version} available`}
                      aria-label={`Open update prompt for version ${updateInfo.version}`}
                    >
                      <span>v{updateInfo.version} available</span>
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l4-4m-4 4l-4-4M5 21h14" />
                      </svg>
                    </button>
                  )}
                  <span className="text-xs text-slate-500" title="App version">
                    v{__APP_VERSION__}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await openUrl('https://donate.stripe.com/aFadR2gGB5dd8FYc3K5wI00');
                      } catch (e) {
                        console.error('Failed to open donation page:', e);
                      }
                    }}
                    className="p-2 rounded text-slate-500 hover:text-sky-400 hover:bg-slate-800/40 transition-colors"
                    title="Find this tool helpful? Click here to buy me a coffee!"
                    aria-label="Find this tool helpful? Click here to buy me a coffee!"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 8.25h13.5v5.25a4.5 4.5 0 01-4.5 4.5h-4.5a4.5 4.5 0 01-4.5-4.5V8.25zM17.25 10.5h1.125a2.625 2.625 0 010 5.25H17.25M6.75 4.5v1.125M10.5 4.5v1.125M14.25 4.5v1.125M3.75 21h13.5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    className="p-2 rounded text-slate-500 hover:text-sky-400 hover:bg-slate-800/40 transition-colors"
                    title="Settings"
                    aria-label="Open settings"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await openUrl('https://github.com/Ciji-Games/Unreal_CommandHelper');
                      } catch (e) {
                        console.error('Failed to open documentation:', e);
                      }
                    }}
                    className="p-2 rounded text-slate-500 hover:text-sky-400 hover:bg-slate-800/40 transition-colors"
                    title="Open documentation"
                    aria-label="Open documentation"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                  </button>
                </div>
              </nav>

              {/* Tab content - overflow-visible so dropdowns can overflow in all tabs */}
              <div className="flex min-h-0 flex-1 flex-col overflow-visible">
                {activeTab === 'launcher' && (
                  <LauncherTab
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOpenSchedulerWithOutput={openSchedulerWithOutput}
                    onQuickRegenerate={openQuickRegenerate}
                  />
                )}
                {activeTab === 'toolbox' && (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <ToolBoxTab initialRegenerateProjectPath={quickRegenerateProjectPath} />
                  </div>
                )}
                {activeTab === 'scheduler' && (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <SchedulerTab outputOpenSignal={schedulerOutputOpenSignal} />
                  </div>
                )}
                {activeTab === 'links' && <LinksTab />}
              </div>
            </div>
          </BaseLayout>
          <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          {updateInfo && updatePromptOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
              <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-100">Update available</h2>
                    <p className="mt-1 text-sm text-slate-400">Version {updateInfo.version} is ready to install.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setUpdatePromptOpen(false)}
                    className="text-slate-500 hover:text-slate-200"
                    aria-label="Close update prompt"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
                {updateError && <p className="mt-3 text-xs text-red-400">{updateError}</p>}
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setUpdatePromptOpen(false)}
                    disabled={updateStatus === 'installing'}
                    className="rounded px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-60"
                  >
                    Later
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (updateInfo.update) {
                        void handleInstallUpdate();
                      } else {
                        void openUrl(updateInfo.url).catch((error) => console.error('Failed to open update page:', error));
                        setUpdatePromptOpen(false);
                      }
                    }}
                    disabled={updateStatus === 'installing'}
                    className="rounded bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-wait disabled:opacity-60"
                  >
                    {updateInfo.update
                      ? updateStatus === 'installing'
                        ? updateProgress === null
                          ? 'Installing…'
                          : `Installing ${updateProgress}%`
                        : 'Install update'
                      : 'Open release page'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </ProgressProvider>
      </LogProvider>
      </EnginesProvider>
    </ProjectsProvider>
    </IdeProvider>
    </SettingsProvider>
  );
}

export default App;
