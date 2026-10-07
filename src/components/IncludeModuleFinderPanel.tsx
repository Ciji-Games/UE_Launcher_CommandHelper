/**
 * Include & module finder panel - quickly find #include paths and Build.cs module names
 * for Unreal Engine headers, engine plugins, project source, and project plugins.
 */

import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useIncludeFinder } from '../hooks/useIncludeFinder';
import { useProjects } from '../hooks/useProjects';
import { Select } from './Select';
import { getProjectDisplayLabel } from '../utils/project';
import type { IncludeScope } from '../types/includeFinder';
import type { ProjectInfo } from '../types';

export function IncludeModuleFinderPanel() {
  const { addProject } = useProjects();
  const {
    projects,
    selectedProjectPath,
    setSelectedProjectPath,
    selectedProject,
    engineVersion,
    engineRoot,
    indexStatus,
    statusLoading,
    isScanningEngine,
    isScanningProject,
    scanProgress,
    error,
    searchQuery,
    setSearchQuery,
    filterOptions,
    setFilterOptions,
    results,
    searching,
    scanEngine,
    scanProject,
    clearEngineIndex,
    refreshStatus,
    copyInclude,
    copyModule,
    openFileInIde,
    openFolderInExplorer,
  } = useIncludeFinder();

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (id: string, copyFn: () => Promise<boolean>) => {
    const success = await copyFn();
    if (success) {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1800);
    }
  };

  const handleProjectSelect = async (path: string) => {
    if (path === '__browse__') {
      const selected = await open({
        directory: false,
        filters: [{ name: 'Unreal Project', extensions: ['uproject'] }],
      });
      if (selected && typeof selected === 'string') {
        try {
          const project = await invoke<ProjectInfo>('analyse_uproject', { path: selected });
          await addProject(project);
          setSelectedProjectPath(project.projectPath);
        } catch (err) {
          console.error('Failed to analyze selected uproject:', err);
        }
      }
      return;
    }
    setSelectedProjectPath(path);
  };

  const projectOptions = [
    ...projects.map((p) => ({
      value: p.projectPath,
      label: getProjectDisplayLabel(p),
    })),
    { value: '__browse__', label: 'Browse for .uproject...' },
  ];

  const allScopesSelected =
    filterOptions.includeEngine &&
    filterOptions.includeEnginePlugins &&
    filterOptions.includeProject &&
    filterOptions.includeProjectPlugins;

  const toggleAllScopes = () => {
    const nextVal = !allScopesSelected;
    setFilterOptions({
      includeEngine: nextVal,
      includeEnginePlugins: nextVal,
      includeProject: nextVal,
      includeProjectPlugins: nextVal,
    });
  };

  const getScopeBadge = (scope: IncludeScope, pluginName?: string | null) => {
    switch (scope) {
      case 'engine':
        return (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-sky-900/40 text-sky-300 border border-sky-700/50 whitespace-nowrap">
            Engine
          </span>
        );
      case 'engine_plugin':
        return (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-indigo-900/40 text-indigo-300 border border-indigo-700/50 truncate max-w-[62px] whitespace-nowrap"
            title={pluginName ? `Plugin: ${pluginName}` : 'Engine Plugin'}
          >
            {pluginName || 'Eng Plugin'}
          </span>
        );
      case 'project':
        return (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 whitespace-nowrap">
            Project
          </span>
        );
      case 'project_plugin':
        return (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-amber-900/40 text-amber-300 border border-amber-700/50 truncate max-w-[62px] whitespace-nowrap"
            title={pluginName ? `Project Plugin: ${pluginName}` : 'Project Plugin'}
          >
            {pluginName || 'Proj Plugin'}
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Header */}
      <div className="shrink-0 space-y-1">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-slate-100">Include & Module Finder</h3>
          <div className="flex-1 h-px bg-slate-600/60" />
        </div>
        <p className="text-slate-400 text-xs leading-relaxed">
          Search Unreal Engine headers, engine plugins, and project modules to find the exact #include directive and Build.cs module dependency.
        </p>
      </div>

      {/* Top Controls: Project & Engine Deduction, Index Cards, Search & Filters */}
      <div className="shrink-0 flex flex-col gap-3">
        {/* Project Selector & Deduced Engine Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Active Project Selector */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-slate-300">Active Project</label>
            <Select
              value={selectedProjectPath}
              onChange={handleProjectSelect}
              options={projectOptions}
              placeholder="Select a project..."
            />
          </div>

          {/* Deduced Engine Info */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-slate-300">Attached Engine</label>
            <div className="flex items-center justify-between h-[38px] px-3 rounded-md bg-slate-900/60 border border-slate-700 text-xs">
              <div className="flex items-center gap-2 truncate">
                <span className="font-semibold text-slate-200">
                  {engineVersion ? `Unreal Engine ${engineVersion}` : 'Not Detected'}
                </span>
                {engineRoot && (
                  <span className="text-slate-500 truncate" title={engineRoot}>
                    ({engineRoot})
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={refreshStatus}
                disabled={statusLoading}
                className="text-slate-400 hover:text-slate-200 disabled:opacity-50 transition-colors shrink-0 ml-2"
                title="Refresh Index Status"
              >
                <svg
                  className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin text-sky-400' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Engine & Project Index Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Engine Index Status Card */}
          <div
            className={`rounded-lg border p-3 flex flex-col justify-between transition-colors ${
              indexStatus?.engineIndexed
                ? 'bg-slate-800/40 border-slate-700/60'
                : 'bg-amber-950/20 border-amber-800/40'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Engine Index
                  </span>
                  {indexStatus?.engineIndexed ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-700/40">
                      Ready
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-900/40 text-amber-300 border border-amber-700/40">
                      Not Indexed
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-300">
                  {indexStatus?.engineIndexed ? (
                    <span>
                      <strong className="text-sky-300 font-semibold">
                        {indexStatus.engineHeaderCount.toLocaleString()}
                      </strong>{' '}
                      headers in{' '}
                      <strong className="text-sky-300 font-semibold">
                        {indexStatus.engineModuleCount.toLocaleString()}
                      </strong>{' '}
                      modules.
                    </span>
                  ) : (
                    <span>
                      Engine headers for <strong>{engineVersion || 'version'}</strong> not indexed yet.
                    </span>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={scanEngine}
                  disabled={isScanningEngine || !engineVersion}
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  {isScanningEngine ? (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="none"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8v8H4z"
                        />
                      </svg>
                      <span>Scanning...</span>
                    </>
                  ) : indexStatus?.engineIndexed ? (
                    'Re-scan'
                  ) : (
                    'Scan Engine'
                  )}
                </button>

                {indexStatus?.engineIndexed && (
                  <button
                    type="button"
                    onClick={clearEngineIndex}
                    disabled={isScanningEngine}
                    className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
                    title="Clear Engine Index Cache"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Engine Scan Progress */}
            {isScanningEngine && scanProgress && (
              <div className="mt-2 pt-2 border-t border-slate-700/60 space-y-1">
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span className="capitalize">{scanProgress.stage.replace('_', ' ')}...</span>
                  <span>{scanProgress.currentCount.toLocaleString()} headers</span>
                </div>
                <div className="h-1 w-full bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-full bg-sky-500 rounded-full animate-pulse w-full" />
                </div>
              </div>
            )}
          </div>

          {/* Project Index Status Card */}
          <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3 flex flex-col justify-between">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Project Index
                  </span>
                  {indexStatus?.projectIndexed ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-700/40">
                      Ready
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-700 text-slate-400">
                      {selectedProject ? 'Not Scanned' : 'No Project'}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-300">
                  {indexStatus?.projectIndexed ? (
                    <span>
                      <strong className="text-emerald-300 font-semibold">
                        {indexStatus.projectHeaderCount.toLocaleString()}
                      </strong>{' '}
                      headers in{' '}
                      <strong className="text-emerald-300 font-semibold">
                        {indexStatus.projectModuleCount.toLocaleString()}
                      </strong>{' '}
                      modules & plugins.
                    </span>
                  ) : (
                    <span>Project source and plugins have not been scanned.</span>
                  )}
                </p>
              </div>

              <div className="shrink-0">
                <button
                  type="button"
                  onClick={scanProject}
                  disabled={isScanningProject || !selectedProjectPath}
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100 disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  {isScanningProject ? (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="none"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8v8H4z"
                        />
                      </svg>
                      <span>Scanning...</span>
                    </>
                  ) : indexStatus?.projectIndexed ? (
                    'Update Index'
                  ) : (
                    'Scan Project'
                  )}
                </button>
              </div>
            </div>

            {/* Project Scan Progress */}
            {isScanningProject && scanProgress && (
              <div className="mt-2 pt-2 border-t border-slate-700/60 space-y-1">
                <div className="flex justify-between text-[10px] text-slate-400">
                  <span className="capitalize">{scanProgress.stage.replace('_', ' ')}...</span>
                  <span>{scanProgress.currentCount.toLocaleString()} headers</span>
                </div>
                <div className="h-1 w-full bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full animate-pulse w-full" />
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="p-2.5 rounded-md bg-red-950/40 border border-red-800 text-red-200 text-xs">
            {error}
          </div>
        )}

        {/* Search Bar & Scope Filters */}
        <div className="space-y-2">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
              {searching ? (
                <svg className="animate-spin w-4 h-4 text-sky-400" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v8H4z"
                  />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              )}
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search headers, classes, or modules (e.g. GameplayStatics, Niagara, JsonObject)..."
              className="w-full pl-10 pr-10 py-2 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-100 placeholder-slate-500 text-xs focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/40 transition-all shadow-inner"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-200"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>

          {/* Scope Filter Pills & Search Results Count */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-400 mr-1">Scope:</span>
              <button
                type="button"
                onClick={toggleAllScopes}
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                  allScopesSelected
                    ? 'bg-sky-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() =>
                  setFilterOptions((prev) => ({
                    ...prev,
                    includeEngine: !prev.includeEngine,
                  }))
                }
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                  filterOptions.includeEngine
                    ? 'bg-sky-900/60 text-sky-200 border border-sky-600/50'
                    : 'bg-slate-800/80 text-slate-400 border border-transparent hover:bg-slate-700'
                }`}
              >
                Engine Core
              </button>
              <button
                type="button"
                onClick={() =>
                  setFilterOptions((prev) => ({
                    ...prev,
                    includeEnginePlugins: !prev.includeEnginePlugins,
                  }))
                }
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                  filterOptions.includeEnginePlugins
                    ? 'bg-indigo-900/60 text-indigo-200 border border-indigo-600/50'
                    : 'bg-slate-800/80 text-slate-400 border border-transparent hover:bg-slate-700'
                }`}
              >
                Engine Plugins
              </button>
              <button
                type="button"
                onClick={() =>
                  setFilterOptions((prev) => ({
                    ...prev,
                    includeProject: !prev.includeProject,
                  }))
                }
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                  filterOptions.includeProject
                    ? 'bg-emerald-900/60 text-emerald-200 border border-emerald-600/50'
                    : 'bg-slate-800/80 text-slate-400 border border-transparent hover:bg-slate-700'
                }`}
              >
                Project Source
              </button>
              <button
                type="button"
                onClick={() =>
                  setFilterOptions((prev) => ({
                    ...prev,
                    includeProjectPlugins: !prev.includeProjectPlugins,
                  }))
                }
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
                  filterOptions.includeProjectPlugins
                    ? 'bg-amber-900/60 text-amber-200 border border-amber-600/50'
                    : 'bg-slate-800/80 text-slate-400 border border-transparent hover:bg-slate-700'
                }`}
              >
                Project Plugins
              </button>
            </div>

            <div className="text-xs text-slate-400">
              {searching ? (
                <span className="flex items-center gap-1.5 text-sky-400 text-xs">
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Searching...
                </span>
              ) : searchQuery.trim() ? (
                <span className="text-xs">
                  <strong className="text-slate-200 font-semibold">{results.length}</strong> matches
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Results Table Section (Takes full remaining vertical space) */}
      <div className="flex-1 min-h-0 flex flex-col border border-slate-700/80 rounded-lg overflow-hidden bg-slate-900/50 shadow-sm">
        {results.length > 0 ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <table className="w-full table-fixed text-left text-xs border-collapse">
              <thead className="bg-slate-800/95 backdrop-blur-sm text-slate-300 font-medium sticky top-0 z-10 border-b border-slate-700">
                <tr>
                  <th className="py-2 px-2.5 w-20">Scope</th>
                  <th className="py-2 px-3 w-[28%]">Header File</th>
                  <th className="py-2 px-3">#include Directive</th>
                  <th className="py-2 px-3 w-40">Module (.Build.cs)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {results.map((entry) => {
                  const incKey = `inc-${entry.id}`;
                  const modKey = `mod-${entry.id}`;

                  return (
                    <tr
                      key={entry.id}
                      className="hover:bg-slate-800/40 transition-colors group"
                    >
                      {/* Scope Badge */}
                      <td className="py-2 px-2.5">
                        {getScopeBadge(entry.scope, entry.pluginName)}
                      </td>

                      {/* Header name with open file & reveal buttons on the left */}
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {/* Open in IDE */}
                          <button
                            type="button"
                            onClick={() => openFileInIde(entry)}
                            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors shrink-0"
                            title="Open header file in IDE / Default editor"
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                              />
                            </svg>
                          </button>

                          {/* Reveal in Explorer */}
                          <button
                            type="button"
                            onClick={() => openFolderInExplorer(entry)}
                            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors shrink-0"
                            title="Reveal in File Explorer"
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                              />
                            </svg>
                          </button>

                          <span className="font-semibold text-slate-100 truncate" title={entry.headerName}>
                            {entry.headerName}
                          </span>
                        </div>
                      </td>

                      {/* Clickable #include directive pill with copy icon in dedicated column */}
                      <td className="py-2 px-3">
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => handleCopy(incKey, () => copyInclude(entry))}
                            className={`group/inc inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono border text-left transition-colors max-w-full truncate ${
                              copiedId === incKey
                                ? 'bg-sky-600/30 text-sky-200 border-sky-500/60'
                                : 'bg-slate-950/60 hover:bg-sky-950/70 text-sky-300 hover:text-sky-200 border-slate-700/60 hover:border-sky-600/50'
                            }`}
                            title="Click to copy #include directive"
                          >
                            <span className="truncate">#include &quot;{entry.includePath}&quot;</span>
                            {copiedId === incKey ? (
                              <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : (
                              <svg
                                className="w-3.5 h-3.5 text-slate-400 group-hover/inc:text-sky-300 shrink-0 transition-colors"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                />
                              </svg>
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Clickable Module pill with copy icon */}
                      <td className="py-2 px-3">
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => handleCopy(modKey, () => copyModule(entry))}
                            className={`group/mod inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium border transition-colors max-w-full truncate ${
                              copiedId === modKey
                                ? 'bg-emerald-600/30 text-emerald-200 border-emerald-500/60'
                                : 'bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-400 hover:text-emerald-300 border-emerald-800/40 hover:border-emerald-700/60'
                            }`}
                            title="Click to copy .Build.cs module dependency"
                          >
                            <span className="truncate">{entry.moduleName}</span>
                            {copiedId === modKey ? (
                              <svg className="w-3.5 h-3.5 text-emerald-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : (
                              <svg
                                className="w-3.5 h-3.5 text-emerald-500/70 group-hover/mod:text-emerald-300 shrink-0 transition-colors"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                                />
                              </svg>
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : searchQuery.trim() ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-6 text-center space-y-2">
            <svg
              className="w-8 h-8 mx-auto text-slate-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-sm text-slate-300 font-medium">
              No matching headers or modules found
            </p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Try adjusting your search query or verify if the engine and project indices are scanned.
            </p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-6 text-center space-y-3">
            <div className="w-10 h-10 rounded-full bg-slate-800/80 border border-slate-700 flex items-center justify-center mx-auto text-sky-400">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-200">
                Search Unreal Engine Headers & Modules
              </p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Type a class or header name above to view include paths and module dependencies.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
              <span className="text-xs text-slate-500">Popular searches:</span>
              {['GameplayStatics', 'ActorComponent', 'NiagaraComponent', 'JsonObject', 'UserWidget'].map(
                (sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setSearchQuery(sample)}
                    className="px-2 py-0.5 rounded text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700/60 transition-colors"
                  >
                    {sample}
                  </button>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
