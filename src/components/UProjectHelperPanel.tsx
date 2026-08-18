/**
 * UProject Helper panel - Cook Content, Package (BuildCookRun), Build (Compile only).
 * Step 13: Mirrors UProjectHelper.cs
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useProjects } from '../hooks/useProjects';
import { useSettings } from '../hooks/useSettings';
import { useLog } from '../contexts/LogContext';
import { useProgress } from '../contexts/ProgressContext';
import { useProcessMonitor } from '../hooks/useProcessMonitor';
import { ToolGroup } from './ToolGroup';
import { Select } from './Select';
import type { ProjectInfo } from '../types';
import { getProjectDisplayLabel } from '../utils/project';
import { previewProjectVersion } from '../utils/projectVersion';

const UPROJECT_PROCESS_GROUP = 'uproject';
const PLATFORMS = ['Win64', 'Linux', 'Mac'];
const PACKAGE_CONFIGS = ['Development', 'Shipping'];

export function UProjectHelperPanel() {
  const { projects, addProject } = useProjects();
  const { settings } = useSettings();
  const { clearLog } = useLog();
  const { startProgress, finishProgress } = useProgress();
  const { runningProcesses: blockingProcesses, hasBlockingProcesses } =
    useProcessMonitor(UPROJECT_PROCESS_GROUP);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('');
  const [platform, setPlatform] = useState('Win64');
  const [packageConfig, setPackageConfig] = useState('Development');
  const [outputPath, setOutputPath] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [fixupRedirects, setFixupRedirects] = useState(true);
  const [autocheckout, setAutocheckout] = useState(false);
  const [projectOnly, setProjectOnly] = useState(true);
  const [autocheckin, setAutocheckin] = useState(false);
  const [bumpProjectVersion, setBumpProjectVersion] = useState(false);
  const [projectVersion, setProjectVersion] = useState('');
  const [newProjectVersion, setNewProjectVersion] = useState('');

  const selectedProject = projects.find((p) => p.projectPath === selectedProjectPath);
  const effectiveEnginePath =
    selectedProject && settings.projectEngineOverrides
      ? settings.projectEngineOverrides[selectedProject.projectPath] ?? selectedProject.engineInstallPath
      : selectedProject?.engineInstallPath ?? '';

  const projectName =
    selectedProjectPath.split(/[/\\]/).pop()?.replace(/\.uproject$/, '') ?? 'Project';

  useEffect(() => {
    if (!selectedProjectPath) {
      setOutputPath('');
      return;
    }
    const lastSlash = selectedProjectPath.lastIndexOf('/');
    const backslash = selectedProjectPath.lastIndexOf('\\');
    const sep = lastSlash > backslash ? lastSlash : backslash;
    const projectDir = sep >= 0 ? selectedProjectPath.slice(0, sep) : selectedProjectPath;
    setOutputPath(`${projectDir}/Saved/StagedBuilds`);
  }, [selectedProjectPath]);

  useEffect(() => {
    if (!selectedProjectPath) {
      setProjectVersion('');
      setNewProjectVersion('');
      return;
    }
    void invoke<string>('get_project_version', { projectPath: selectedProjectPath })
      .then((version) => {
        setProjectVersion(version);
        setNewProjectVersion(previewProjectVersion(version));
      })
      .catch(() => {
        setProjectVersion('Unavailable');
        setNewProjectVersion('');
      });
  }, [selectedProjectPath]);

  const handleProjectChange = async (value: string) => {
    if (value === '__browse__') {
      setSelectedProjectPath('__browse__');
      const path = await open({
        directory: false,
        filters: [{ name: 'Unreal Project', extensions: ['uproject'] }],
      });
      if (path && typeof path === 'string') {
        try {
          const project = await invoke<ProjectInfo>('analyse_uproject', { path });
          await addProject(project);
          setSelectedProjectPath(project.projectPath);
        } catch (e) {
          console.error('Failed to analyse project:', e);
          setSelectedProjectPath('');
        }
      } else {
        setSelectedProjectPath('');
      }
    } else {
      setSelectedProjectPath(value);
    }
  };

  const handleBrowseOutputPath = async () => {
    const path = await open({
      directory: true,
    });
    if (path && typeof path === 'string') {
      setOutputPath(path);
    }
  };

  const getArchiveZipPath = () => {
    const p = outputPath.trim();
    if (!p) return '';
    if (p.toLowerCase().endsWith('.zip')) return p;
    const dir = p.replace(/[/\\]+$/, '');
    return `${dir}/${projectName}.zip`;
  };

  const getPackageArchiveDir = () => {
    const p = outputPath.trim();
    if (!p) return '';
    if (p.toLowerCase().endsWith('.zip')) {
      const sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      return sep >= 0 ? p.slice(0, sep) : p;
    }
    return p;
  };

  const runCook = async () => {
    if (!selectedProject) return;
    const enginePath = effectiveEnginePath;
    if (!enginePath || enginePath === 'Unknown') {
      alert('Engine path not found for this project. Ensure the project uses an installed engine.');
      return;
    }
    clearLog();
    setRunning(true);
    startProgress({ showOutputLog: true });
    try {
      await invoke('run_cook', {
        projectPath: selectedProject.projectPath,
        platform,
        enginePath,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Cook failed:', e);
      alert(`Cook failed: ${msg}`);
    } finally {
      setRunning(false);
      finishProgress();
    }
  };

  const runPackage = async () => {
    if (!selectedProject) return;
    const enginePath = effectiveEnginePath;
    if (!enginePath || enginePath === 'Unknown') {
      alert('Engine path not found for this project. Ensure the project uses an installed engine.');
      return;
    }
    const pkgDir = getPackageArchiveDir();
    if (!pkgDir) {
      alert('Please set the output path.');
      return;
    }
    clearLog();
    setRunning(true);
    startProgress({ showOutputLog: true });
    try {
      await invoke('run_package', {
        projectPath: selectedProject.projectPath,
        platform,
        clientConfig: packageConfig,
        archiveDirectory: pkgDir,
        enginePath,
        bumpProjectVersion,
        projectVersion: bumpProjectVersion ? newProjectVersion : null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Package failed:', e);
      alert(`Package failed: ${msg}`);
    } finally {
      setRunning(false);
      finishProgress();
    }
  };

  const runArchive = async () => {
    if (!selectedProject) return;
    const enginePath = effectiveEnginePath;
    if (!enginePath || enginePath === 'Unknown') {
      alert('Engine path not found for this project. Ensure the project uses an installed engine.');
      return;
    }
    const zipPath = getArchiveZipPath();
    if (!zipPath) {
      alert('Please set the output path.');
      return;
    }
    clearLog();
    setRunning(true);
    startProgress({ showOutputLog: true });
    try {
      await invoke('run_archive', {
        projectPath: selectedProject.projectPath,
        outputZipPath: zipPath,
        enginePath,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Archive failed:', e);
      alert(`Archive failed: ${msg}`);
    } finally {
      setRunning(false);
      finishProgress();
    }
  };

  const runBuild = async () => {
    if (!selectedProject) return;
    if (!selectedProject.isCpp) {
      alert('Build is only for C++ projects. This project has no Source folder.');
      return;
    }
    const enginePath = selectedProject.engineInstallPath;
    if (!enginePath || enginePath === 'Unknown') {
      alert('Engine path not found for this project. Ensure the project uses an installed engine.');
      return;
    }
    clearLog();
    setRunning(true);
    startProgress({ showOutputLog: true });
    try {
      await invoke('run_build', {
        projectPath: selectedProject.projectPath,
        enginePath,
        isCpp: selectedProject.isCpp,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Build failed:', e);
      alert(`Build failed: ${msg}`);
    } finally {
      setRunning(false);
      finishProgress();
    }
  };

  const runResavePackages = async () => {
    if (!selectedProject) return;
    const enginePath = effectiveEnginePath;
    if (!enginePath || enginePath === 'Unknown') {
      alert('Engine path not found for this project. Ensure the project uses an installed engine.');
      return;
    }
    clearLog();
    setRunning(true);
    startProgress({ showOutputLog: true });
    try {
      await invoke('run_resave_packages', {
        projectPath: selectedProject.projectPath,
        enginePath,
        fixupRedirects: fixupRedirects,
        autocheckout,
        projectOnly,
        autocheckin,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('ResavePackages failed:', e);
      alert(`ResavePackages failed: ${msg}`);
    } finally {
      setRunning(false);
      finishProgress();
    }
  };

  const canRun = !!selectedProject && !running && !hasBlockingProcesses;
  const canBuild = canRun && selectedProject?.isCpp;

  return (
    <ToolGroup
      title="UProject Helper"
      description="Cook, Package (Build+Cook+Stage+Pak), Archive (ZipProjectUp), or Build (compile only)."
    >
      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-sm text-slate-300 mb-1">Project</label>
          <Select
            value={selectedProjectPath}
            onChange={(v) => handleProjectChange(v)}
            placeholder={projects.length === 0 ? 'No projects available' : 'Select a project'}
            options={[
              ...projects.map((p) => ({ value: p.projectPath, label: getProjectDisplayLabel(p) })),
              { value: '__browse__', label: 'Browse new project...' },
            ]}
          />
        </div>

        <div className="rounded-lg border border-slate-600/60 bg-slate-700/30 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-slate-200">Packaging</h4>
          <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={bumpProjectVersion}
              onChange={(e) => setBumpProjectVersion(e.target.checked)}
              disabled={!selectedProjectPath}
              className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
            />
            Bump project version before packaging
          </label>
          {selectedProjectPath && (
            <div className="text-sm text-slate-400">
              <div>Current version: <span className="text-slate-200">{projectVersion || 'Reading...'}</span></div>
              {bumpProjectVersion && (
                <label className="flex items-center gap-2 mt-2">
                  New version:
                  <input
                    type="text"
                    value={newProjectVersion}
                    onChange={(e) => setNewProjectVersion(e.target.value)}
                    className="flex-1 rounded-md bg-slate-700/50 border border-slate-600 text-slate-100 px-2 py-1 focus:border-sky-500 focus:outline-none"
                  />
                </label>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-300 mb-1">Platform</label>
              <Select
                value={platform}
                onChange={(v) => setPlatform(v)}
                disabled={!selectedProjectPath}
                options={PLATFORMS.map((p) => ({ value: p, label: p }))}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-1">Package Config</label>
              <Select
                value={packageConfig}
                onChange={(v) => setPackageConfig(v)}
                disabled={!selectedProjectPath}
                options={PACKAGE_CONFIGS.map((c) => ({ value: c, label: c }))}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">
              Output path (Package: directory, Archive: directory or .zip file)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="{project}/Saved/StagedBuilds or path/ProjectName.zip"
                disabled={!selectedProjectPath}
                className="flex-1 rounded-md bg-slate-700/50 border border-slate-600 text-slate-100 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleBrowseOutputPath}
                disabled={!selectedProjectPath}
                className="rounded-md px-3 py-2 bg-slate-600/80 hover:bg-slate-500/80 disabled:bg-slate-700 disabled:text-slate-500 text-slate-200 text-sm font-medium transition-colors"
              >
                Browse
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={runPackage}
            disabled={!canRun}
            title="Runs RunUAT BuildCookRun. Builds, cooks, stages, and packages the project into a distributable archive."
            className="rounded px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 disabled:bg-slate-600 disabled:text-slate-500 text-white font-medium transition-colors"
          >
            Package
          </button>
        </div>

        {hasBlockingProcesses && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100/90">
            <p className="font-medium">Cannot run: Unreal Engine is running</p>
            <p className="mt-1 text-amber-100/80">
              {blockingProcesses.map((p) => p.displayName).join(', ')} — close it before running
              Cook, Package, Archive, Build, or ResavePackages.
            </p>
          </div>
        )}

        {/* Resave Packages section */}
        <div className="rounded-lg border border-slate-600/60 bg-slate-700/30 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-slate-200">Resave Packages</h4>
          <p className="text-slate-400 text-sm">
            Resaves packages/assets to update or fix references. Fix redirectors, refresh assets after renaming or moving.
          </p>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={fixupRedirects}
                onChange={(e) => setFixupRedirects(e.target.checked)}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              Fixup redirectors
            </label>
            <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={autocheckout}
                onChange={(e) => setAutocheckout(e.target.checked)}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              Auto checkout
            </label>
            <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={projectOnly}
                onChange={(e) => setProjectOnly(e.target.checked)}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              Project only
            </label>
            <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={autocheckin}
                onChange={(e) => setAutocheckin(e.target.checked)}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50"
              />
              Auto checkin
            </label>
          </div>
          <button
            type="button"
            onClick={runResavePackages}
            disabled={!canRun}
            title="Runs UnrealEditor.exe -run=ResavePackages. Resaves packages to update references and fix redirectors; optionally with source control checkout/checkin."
            className="rounded-md px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 disabled:bg-slate-600 disabled:text-slate-500 text-white font-medium transition-colors"
          >
            Resave Packages
          </button>
        </div>

        {selectedProject && !selectedProject.isCpp && (
          <p className="text-sm text-sky-400/90">
            Build is disabled: this project has no C++ code (no Source folder). Cook and Package
            are available.
          </p>
        )}

        <div className="rounded-lg border border-slate-600/60 bg-slate-700/30 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-slate-200">Other</h4>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runCook}
              disabled={!canRun}
              title="Runs UnrealEditor-Cmd.exe -run=cook. Cooks content for the target platform (content conversion and packaging)."
              className="rounded px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 disabled:bg-slate-600 disabled:text-slate-500 text-white font-medium transition-colors"
            >
              Cook
            </button>
            <button
              type="button"
              onClick={runArchive}
              disabled={!canRun}
              title="Runs RunUAT ZipProjectUp. Creates a zip of the project source (excludes Binaries, Intermediate, Saved)."
              className="rounded px-4 py-2 bg-sky-600/80 hover:bg-sky-500/80 disabled:bg-slate-600 disabled:text-slate-500 text-white font-medium transition-colors"
            >
              Archive
            </button>
            <button
              type="button"
              onClick={runBuild}
              disabled={!canBuild}
              title="Runs Build.bat to compile the C++ project. Targets {Project}Editor Win64 Development."
              className="rounded-md px-4 py-2 bg-slate-600/80 hover:bg-slate-500/80 disabled:bg-slate-700 disabled:text-slate-500 text-slate-200 font-medium transition-colors"
            >
              Build
            </button>
          </div>
        </div>
      </div>
    </ToolGroup>
  );
}
