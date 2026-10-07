/**
 * Include & Module Finder types
 */

export type IncludeScope = 'engine' | 'engine_plugin' | 'project' | 'project_plugin';

export interface IncludeEntry {
  id: number;
  headerName: string;
  includePath: string;
  moduleName: string;
  scope: IncludeScope;
  pluginName?: string | null;
  filePath: string;
  relativePath: string;
}

export interface IndexStatus {
  engineVersion: string;
  engineIndexed: boolean;
  engineHeaderCount: number;
  engineModuleCount: number;
  engineLastScanned?: string | null;
  projectIndexed: boolean;
  projectHeaderCount: number;
  projectModuleCount: number;
  projectLastScanned?: string | null;
}

export interface ScanProgressPayload {
  stage: 'discovering_modules' | 'indexing_headers' | 'finalizing';
  currentCount: number;
  totalEstimated?: number;
  currentFile?: string;
}

export interface SearchFilterOptions {
  includeEngine: boolean;
  includeEnginePlugins: boolean;
  includeProject: boolean;
  includeProjectPlugins: boolean;
}
