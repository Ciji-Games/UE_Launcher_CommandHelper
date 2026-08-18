/**
 * Step param panel for Cook, Package, Build.
 * Cook: project, platform
 * Package: project, platform, config, archiveDirectory
 * Build: project
 */

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useProjects } from '../../hooks/useProjects';
import type { ProjectInfo } from '../../types';
import { getProjectDisplayLabel } from '../../utils/project';
import { Select } from '../Select';
import { previewProjectVersion } from '../../utils/projectVersion';

const PLATFORMS = ['Win64', 'Linux', 'Mac'];
const PACKAGE_CONFIGS = ['Development', 'Shipping'];

interface StepParamPanelUProjectProps {
  stepId: 'cook' | 'package' | 'build';
  value: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}

export function StepParamPanelUProject({ stepId, value, onChange }: StepParamPanelUProjectProps) {
  const { projects, addProject } = useProjects();
  const projectPath = (value.project as string) ?? '';
  const platform = (value.platform as string) ?? 'Win64';
  const packageConfig = (value.config as string) ?? 'Development';
  const outputPath = (value.outputPath as string) ?? (value.archiveDirectory as string) ?? '';
  const bumpProjectVersion = (value.bumpProjectVersion as boolean) ?? false;
  const [projectVersion, setProjectVersion] = useState('');

  const prevProjectRef = useRef<string | null>(null);

  useEffect(() => {
    if (!projectPath || stepId !== 'package') return;
    if (prevProjectRef.current === projectPath) return;
    if (prevProjectRef.current === null && outputPath) {
      prevProjectRef.current = projectPath;
      return;
    }
    prevProjectRef.current = projectPath;
    const sep = Math.max(projectPath.lastIndexOf('/'), projectPath.lastIndexOf('\\'));
    const projectDir = sep >= 0 ? projectPath.slice(0, sep) : projectPath;
    onChange({ ...value, outputPath: `${projectDir}/Saved/StagedBuilds` });
  }, [projectPath, stepId]);

  useEffect(() => {
    if (!projectPath || stepId !== 'package') {
      setProjectVersion('');
      return;
    }
    setProjectVersion('');
    void invoke<string>('get_project_version', { projectPath })
      .then(setProjectVersion)
      .catch(() => setProjectVersion(''));
  }, [projectPath, stepId]);

  const handleProjectChange = async (v: string) => {
    if (v === '__browse__') {
      const path = await open({
        directory: false,
        filters: [{ name: 'Unreal Project', extensions: ['uproject'] }],
      });
      if (path && typeof path === 'string') {
        try {
          const project = await invoke<ProjectInfo>('analyse_uproject', { path });
          await addProject(project);
          const sep = Math.max(project.projectPath.lastIndexOf('/'), project.projectPath.lastIndexOf('\\'));
          const projectDir = sep >= 0 ? project.projectPath.slice(0, sep) : project.projectPath;
          const updates: Record<string, unknown> = { project: project.projectPath };
          if (stepId === 'package') updates.outputPath = `${projectDir}/Saved/StagedBuilds`;
          onChange({ ...value, ...updates });
        } catch (e) {
          console.error('Failed to analyse project:', e);
        }
      }
    } else {
      onChange({ ...value, project: v });
    }
  };

  const handleBrowseOutputPath = async () => {
    const path = await open({ directory: true });
    if (path && typeof path === 'string') onChange({ ...value, outputPath: path });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="block text-sm text-slate-300 mb-1">Project</label>
        <Select
          value={projectPath}
          onChange={(v) => handleProjectChange(v)}
          placeholder={projects.length === 0 ? 'No projects' : 'Select project'}
          disabled={projects.length === 0}
          options={[
            ...projects.map((p) => ({ value: p.projectPath, label: getProjectDisplayLabel(p) })),
            { value: '__browse__', label: 'Browse...' },
          ]}
        />
      </div>
      {(stepId === 'cook' || stepId === 'package') && (
        <div>
          <label className="block text-sm text-slate-300 mb-1">Platform</label>
          <Select
            value={platform}
            onChange={(v) => onChange({ ...value, platform: v })}
            disabled={!projectPath}
            options={PLATFORMS.map((p) => ({ value: p, label: p }))}
          />
        </div>
      )}
      {stepId === 'package' && (
        <>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Package Config</label>
            <Select
              value={packageConfig}
              onChange={(v) => onChange({ ...value, config: v })}
              disabled={!projectPath}
              options={PACKAGE_CONFIGS.map((c) => ({ value: c, label: c }))}
            />
          </div>
          <div className="rounded-lg border border-slate-600/60 bg-slate-700/30 p-3 space-y-2">
            <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={bumpProjectVersion}
                onChange={(e) => onChange({ ...value, bumpProjectVersion: e.target.checked })}
                disabled={!projectPath}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              Bump project version before packaging
            </label>
            <div className="text-sm text-slate-400">Current version: <span className="text-slate-200">{projectVersion || 'Unavailable'}</span></div>
            {bumpProjectVersion && (
              <div>Next run version: <span className="text-slate-200">{projectVersion ? previewProjectVersion(projectVersion) : 'Unavailable'}</span></div>
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">Output path</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => onChange({ ...value, outputPath: e.target.value })}
                placeholder="{project}/Saved/StagedBuilds"
                disabled={!projectPath}
                className="flex-1 rounded-md bg-slate-700/50 border border-slate-600 text-slate-100 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleBrowseOutputPath}
                disabled={!projectPath}
                className="rounded px-3 py-2 bg-slate-600/80 hover:bg-slate-500/80 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors"
              >
                Browse
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
