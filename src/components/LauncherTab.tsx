/**
 * Launcher tab - Engine Versions section + Projects section + Add Project button.
 * Mirrors TabLauncher layout from Form1 (projectList1, projectList2).
 */

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProjects } from '../hooks/useProjects';
import { useEngines } from '../hooks/useEngines';
import { useSettings } from '../hooks/useSettings';
import { useIde } from '../hooks/useIde';
import { useScheduledJobs } from '../hooks/useScheduledJobs';
import { useRunScheduledJob } from '../hooks/useRunScheduledJob';
import { useProcessMonitor } from '../hooks/useProcessMonitor';
import { hasBlockingProcessesForJob, getBlockingMessageForJob } from '../utils/jobBlocking';
import { LauncherCard } from './LauncherCard';
import { AddProjectButton } from './AddProjectButton';
import { AddEngineCard } from './AddEngineCard';
import { PinnedJobCard } from './PinnedJobCard';
import type { ProjectInfo, EngineEntry } from '../types';

interface LauncherTabProps {
  onOpenSettings?: () => void;
  onOpenSchedulerWithOutput?: () => void;
  onQuickRegenerate?: (projectPath: string) => void;
}

export function LauncherTab({ onOpenSettings, onOpenSchedulerWithOutput, onQuickRegenerate }: LauncherTabProps) {
  const {
    projects,
    addProject,
    removeProject,
    updateProject,
    refresh,
    loading: projectsLoading,
    refreshing: projectsRefreshing,
    refreshProgress,
  } = useProjects();
  const { engines, loading: enginesLoading } = useEngines();
  const { settings } = useSettings();
  const { candidates: ideCandidates, ensureLoaded: ensureIdeLoaded } = useIde();
  const hasCppProjects = projects.some((p) => p.isCpp);

  useEffect(() => {
    if (!hasCppProjects) return;
    const timer = window.setTimeout(() => {
      void ensureIdeLoaded();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [hasCppProjects, ensureIdeLoaded]);

  const selectedIde = ideCandidates.find((ide) => ide.id === settings.preferredIdeId);
  const { jobs } = useScheduledJobs();
  const { runJob, running: runJobRunning } = useRunScheduledJob();
  const umapMonitor = useProcessMonitor('umap');
  const uprojectMonitor = useProcessMonitor('uproject');
  const regenerateMonitor = useProcessMonitor('regenerate');
  const monitors = {
    umap: umapMonitor,
    uproject: uprojectMonitor,
    regenerate: regenerateMonitor,
  };

  const pinnedJobs = jobs.filter((j) => j.pinned);

  const handleAddProject = async (uprojectPath: string) => {
    try {
      const project = await invoke<ProjectInfo>('analyse_uproject', { path: uprojectPath });
      await addProject(project);
      if (project.engineInstallPath === 'Unknown' && onOpenSettings) {
        onOpenSettings();
      }
    } catch (e) {
      console.error('Failed to add project:', e);
    }
  };

  const handleRemoveProject = async (projectPath: string) => {
    await removeProject(projectPath);
  };

  const engineAsProjectInfo = (e: EngineEntry): ProjectInfo => ({
    projectPath: e.editorPath,
    projectName: `UE ${e.version}`,
    engineVersion: e.version,
    engineInstallPath: e.editorPath,
    isCpp: false,
    maps: [],
  });

  return (
    <div className="space-y-8">
      {/* Engine Versions */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-slate-300 uppercase tracking-wider">Engine Versions</h2>
        {enginesLoading ? (
          <p className="text-slate-500 text-sm">Loading engines...</p>
        ) : (
          <div className="flex flex-wrap gap-3 items-start">
            {engines.length === 0 && (
              <p className="text-slate-500 text-sm">No engines found.</p>
            )}
            {engines.map((e) => (
              <LauncherCard
                key={e.id ?? e.editorPath}
                project={engineAsProjectInfo(e)}
                isEngine
                isCustomEngine={e.isCustom}
              />
            ))}
            {onOpenSettings && <AddEngineCard onOpenSettings={onOpenSettings} />}
          </div>
        )}
      </section>

      {/* Projects */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-slate-300 uppercase tracking-wider">Projects</h2>
          <button
            type="button"
            onClick={refresh}
            disabled={projectsLoading || projectsRefreshing}
            className="rounded-md px-2.5 py-1 text-xs font-medium bg-slate-700/60 text-slate-300 hover:bg-slate-600/60 hover:text-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border border-slate-600/50"
            title="Re-scan projects in background (remove deleted, refresh maps)"
          >
            {projectsLoading
              ? 'Loading...'
              : projectsRefreshing
                ? `Scanning ${refreshProgress.completed}/${refreshProgress.total || projects.length}`
                : 'Re-scan'}
          </button>
        </div>
        {projectsRefreshing && (
          <p className="text-xs text-slate-400">
            Background scan running
            {refreshProgress.currentProjectPath
              ? ` (${refreshProgress.currentProjectPath.split(/[/\\]/).pop() ?? 'project'})`
              : ''}
            .
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {projects.map((p) => {
            const effectiveEnginePath = settings.projectEngineOverrides?.[p.projectPath] ?? p.engineInstallPath;
            const effectiveProject = { ...p, engineInstallPath: effectiveEnginePath };
            const engineEntry = engines.find((e) => e.editorPath === effectiveEnginePath);
            const isCustomEngine = engineEntry?.isCustom ?? false;
            return (
              <LauncherCard
                key={p.projectPath}
                project={effectiveProject}
                onRemove={handleRemoveProject}
                onUpdateAlias={(alias) => updateProject(p.projectPath, { projectAlias: alias || undefined })}
                onQuickRegenerate={onQuickRegenerate}
                isCustomEngine={isCustomEngine}
                ideKind={selectedIde?.kind}
                ideExePath={selectedIde?.exe_path ?? null}
              />
            );
          })}
          <AddProjectButton onAdd={handleAddProject} />
        </div>
      </section>

      {/* Pinned Jobs - only shown when there are pinned jobs */}
      {pinnedJobs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-slate-300 uppercase tracking-wider">Pinned Jobs</h2>
          <div className="flex flex-wrap gap-3">
            {pinnedJobs.map((job) => (
              <PinnedJobCard
                key={job.id}
                job={job}
                onRun={async (j) => {
                  onOpenSchedulerWithOutput?.();
                  await runJob(j, { stopOnFailure: true });
                }}
                disabled={
                  runJobRunning ||
                  job.steps.length === 0 ||
                  hasBlockingProcessesForJob(job, monitors)
                }
                blockingMessage={getBlockingMessageForJob(job, monitors)}
                running={runJobRunning}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
