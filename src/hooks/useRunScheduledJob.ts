/**
 * Hook to run scheduled jobs - shared logic for SchedulerTab and LauncherTab.
 */

import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProjects } from './useProjects';
import { useSettings } from './useSettings';
import useIde from './useIde';
import { useLog } from '../contexts/LogContext';
import { useProgress } from '../contexts/ProgressContext';
import type { ScheduledJob } from '../types';
import type { IdeCandidate } from '../types';
import { SCHEDULABLE_STEPS } from '../types';

function getStepLabel(stepId: string): string {
  return SCHEDULABLE_STEPS.find((s) => s.id === stepId)?.label ?? stepId;
}

export interface RunJobOptions {
  stopOnFailure?: boolean;
}

export function useRunScheduledJob() {
  const { projects } = useProjects();
  const { settings } = useSettings();
  const { getCandidates } = useIde();
  const { clearLog } = useLog();
  const {
    startProgressForScheduler,
    setCurrentStep,
    finishProgress,
    stopRequestedRef,
  } = useProgress();

  const [running, setRunning] = useState(false);

  const runJob = useCallback(
    async (job: ScheduledJob, options: RunJobOptions = {}) => {
      const { stopOnFailure = true } = options;
      if (job.steps.length === 0 || running) return;

      setRunning(true);
      clearLog();
      startProgressForScheduler(
        job.steps.length,
        job.steps.map((s) => getStepLabel(s.id))
      );

      let failed = false;
      const ideCandidates = await getCandidates().catch(() => []);
      const selectedIde = ideCandidates.find((c: IdeCandidate) => c.id === settings.preferredIdeId);
      for (let i = 0; i < job.steps.length && !failed; i++) {
        if (stopRequestedRef.current) break;
        setCurrentStep(i);
        const step = job.steps[i];
        const params = step.params;
        const projectPath = params.project as string;
        const project = projects.find((p) => p.projectPath === projectPath);
        const enginePath =
          (params.enginePath as string) ||
          settings.projectEngineOverrides?.[projectPath] ||
          project?.engineInstallPath ||
          '';
        try {
          if (step.id === 'delete_hlod') {
            await invoke('run_map_command', {
              projectPath,
              mapPath: params.map,
              builder: 'WorldPartitionHLODsBuilder',
              extraArgs: '-DeleteHLODs',
              enginePath,
              launchMapAfter: params.launchMapAfter ?? false,
            });
          } else if (step.id === 'build_hlod') {
            await invoke('run_map_command', {
              projectPath,
              mapPath: params.map,
              builder: 'WorldPartitionHLODsBuilder',
              extraArgs: null,
              enginePath,
              launchMapAfter: params.launchMapAfter ?? false,
            });
          } else if (step.id === 'build_minimap') {
            await invoke('run_map_command', {
              projectPath,
              mapPath: params.map,
              builder: 'WorldPartitionMiniMapBuilder',
              extraArgs: null,
              enginePath,
              launchMapAfter: params.launchMapAfter ?? false,
            });
          } else if (step.id === 'build_lighting') {
            await invoke('run_build_lighting', {
              projectPath,
              mapPath: params.map,
              enginePath,
              quality: params.quality ?? undefined,
            });
          } else if (step.id === 'resave_packages') {
            await invoke('run_resave_packages', {
              projectPath,
              enginePath,
              fixupRedirects: params.fixupRedirects ?? true,
              autocheckout: params.autocheckout ?? false,
              projectOnly: params.projectOnly ?? true,
              autocheckin: params.autocheckin ?? false,
            });
          } else if (step.id === 'resave_actors') {
            let extra = '-SCCProvider=None';
            const ac = params.actorClass as string | undefined;
            if (ac?.trim()) extra += ` -ActorClass=${ac.trim()}`;
            await invoke('run_map_command', {
              projectPath,
              mapPath: params.map,
              builder: 'WorldPartitionResaveActorsBuilder',
              extraArgs: extra,
              enginePath,
              launchMapAfter: params.launchMapAfter ?? false,
            });
          } else if (step.id === 'foliage_builder') {
            const gridSize = (params.newGridSize as number) ?? 512;
            await invoke('run_map_command', {
              projectPath,
              mapPath: params.map,
              builder: 'WorldPartitionFoliageBuilder',
              extraArgs: `-SCCProvider=None -NewGridSize=${gridSize}`,
              enginePath,
              launchMapAfter: params.launchMapAfter ?? false,
            });
          } else if (step.id === 'navigation_data') {
            await invoke('run_map_command', {
              projectPath,
              mapPath: params.map,
              builder: 'WorldPartitionNavigationDataBuilder',
              extraArgs: '-SCCProvider=None',
              enginePath,
              launchMapAfter: params.launchMapAfter ?? false,
            });
          } else if (step.id === 'rename_duplicate') {
            const pkg = (params.newPackage as string)?.trim();
            if (!pkg) throw new Error('NewPackage path is required for Rename/Duplicate Map.');
            let extra = `-SCCProvider=None -NewPackage=${pkg}`;
            if (params.rename) extra += ' -Rename';
            await invoke('run_map_command', {
              projectPath,
              mapPath: params.map,
              builder: 'WorldPartitionRenameDuplicateBuilder',
              extraArgs: extra,
              enginePath,
              launchMapAfter: params.launchMapAfter ?? false,
            });
          } else if (step.id === 'cook') {
            await invoke('run_cook', {
              projectPath,
              platform: params.platform ?? 'Win64',
              enginePath,
            });
          } else if (step.id === 'package') {
            const pkgPath =
              (params.outputPath as string) ?? (params.archiveDirectory as string) ?? '';
            const pkgDir = pkgPath.toLowerCase().endsWith('.zip')
              ? pkgPath.slice(0, Math.max(pkgPath.lastIndexOf('/'), pkgPath.lastIndexOf('\\')))
              : pkgPath;
            await invoke('run_package', {
              projectPath,
              platform: params.platform ?? 'Win64',
              clientConfig: params.config ?? 'Development',
              archiveDirectory: pkgDir,
              enginePath,
              bumpProjectVersion: params.bumpProjectVersion ?? false,
              projectVersion: null,
            });
          } else if (step.id === 'archive') {
            const outPath =
              (params.outputPath as string) ?? (params.outputZipPath as string) ?? '';
            const projectName =
              projectPath.split(/[/\\]/).pop()?.replace(/\.uproject$/, '') ?? 'Project';
            const zipPath = outPath.toLowerCase().endsWith('.zip')
              ? outPath
              : `${outPath.replace(/[/\\]+$/, '')}/${projectName}.zip`;
            await invoke('run_archive', {
              projectPath,
              outputZipPath: zipPath,
              enginePath,
            });
          } else if (step.id === 'build') {
            await invoke('run_build', {
              projectPath,
              enginePath,
              isCpp: project?.isCpp ?? false,
            });
          } else if (step.id === 'regenerate') {
            const versionPath =
              settings.unrealVersionSelectorPath ||
              (await invoke<string | null>('get_unreal_version_selector_path'));
            if (!versionPath) throw new Error('UnrealVersionSelector.exe not found. Set path in settings.');
            await invoke('regenerate_project', {
              uprojectPath: projectPath,
              openProjectAfter: params.openProjectAfter ?? false,
              openIdeAfter: params.openIdeAfter ?? params.openSlnAfter ?? false,
              buildAfter: params.buildAfter ?? false,
              versionSelectorPath: versionPath,
              engineInstallPath: enginePath,
              preferredIdeKind: selectedIde?.kind ?? 'unknown',
              preferredIdeExePath: selectedIde?.exe_path ?? null,
            });
          } else if (step.id === 'build_plugin') {
            await invoke('build_plugin', {
              upluginPath: params.upluginPath ?? '',
              enginePath: params.enginePath ?? '',
              createZip: params.createZip ?? true,
            });
          } else if (step.id === 'launch') {
            const mapPath = params.map as string | undefined;
            if (mapPath && enginePath && enginePath !== 'Unknown') {
              await invoke('launch_project_with_map', {
                projectPath,
                mapPath,
                enginePath,
              });
            } else {
              await invoke('launch_ide_for_project', {
                uprojectPath: projectPath,
                ideKind: selectedIde?.kind ?? 'unknown',
                ideExePath: selectedIde?.exe_path ?? null,
              });
            }
          } else if (step.id === 'movie_render_queue') {
            const mapPath = params.map as string;
            const moviePipelineConfig = params.moviePipelineConfig as string;
            const levelSequence =
              params.mode === 'mix_match' && params.levelSequence
                ? (params.levelSequence as string)
                : null;
            await invoke('run_movie_render_queue', {
              projectPath,
              mapPath,
              moviePipelineConfig,
              levelSequence,
              enginePath,
            });
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error(`Step ${i + 1} (${getStepLabel(step.id)}) failed:`, errMsg);
          if (stopRequestedRef.current || stopOnFailure) {
            failed = true;
          }
        }
      }

      setRunning(false);
      finishProgress();
    },
    [
      projects,
      settings.unrealVersionSelectorPath,
      settings.projectEngineOverrides,
      settings.preferredIdeId,
      getCandidates,
      clearLog,
      startProgressForScheduler,
      setCurrentStep,
      finishProgress,
      stopRequestedRef,
      running,
    ]
  );

  return { runJob, running };
}
