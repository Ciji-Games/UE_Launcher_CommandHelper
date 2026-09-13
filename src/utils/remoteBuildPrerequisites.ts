import type {
  CheckoutStatus,
  EngineEntry,
  PipelineStepId,
  ProcessStatus,
  ProfilePrerequisites,
  RemoteBuildProfile,
  RemoteBuildRun,
  RemoteBuildStageStatus,
  RemoteBuildStatus,
  StepPrerequisiteReport,
  StepPrerequisiteStatus,
} from '../types';
import { remoteBuildOutputRoot } from '../hooks/useRemoteBuildProfiles';

export interface PrerequisiteEvaluationContext {
  profile: RemoteBuildProfile;
  githubConnected: boolean;
  checkoutStatus?: CheckoutStatus | null;
  installedEngines: EngineEntry[];
  uprojectRunningProcesses: ProcessStatus[];
  isAnyPackageRunning?: boolean;
  globalSettings: {
    keepBuildsEnabled: boolean;
    keepBuildsCount: number;
    archiveOnly: boolean;
  };
}

export function findMatchingEngine(
  projectEngineVersion: string | undefined,
  configuredEnginePath: string | undefined,
  installedEngines: EngineEntry[]
): EngineEntry | undefined {
  if (configuredEnginePath) {
    const directMatch = installedEngines.find(
      (e) => e.editorPath.toLowerCase() === configuredEnginePath.toLowerCase()
    );
    if (directMatch) return directMatch;
  }

  if (!projectEngineVersion || projectEngineVersion === 'Unknown') {
    return undefined;
  }

  const normalized = projectEngineVersion.trim().toLowerCase();
  return installedEngines.find((candidate) => {
    const version = candidate.version.toLowerCase();
    const id = candidate.id?.toLowerCase();
    return (
      version === normalized ||
      version.startsWith(`${normalized}.`) ||
      id === normalized ||
      id === `{${normalized}}` ||
      (normalized.startsWith('{') && normalized.endsWith('}') && id === normalized.slice(1, -1))
    );
  });
}

export function evaluateProfilePrerequisites(context: PrerequisiteEvaluationContext): ProfilePrerequisites {
  const {
    profile,
    githubConnected,
    checkoutStatus,
    installedEngines,
    uprojectRunningProcesses,
    isAnyPackageRunning = false,
    globalSettings,
  } = context;

  const isCurrentPackaging =
    profile.progressStages?.package === 'running' ||
    (profile.lastStatus === 'running' && profile.progressStages?.package !== 'failed' && profile.progressStages?.package !== 'disabled');
  const isPackagingInProgress = isCurrentPackaging || isAnyPackageRunning;

  const hasValidGitCheckout = checkoutStatus ? checkoutStatus.result.ok : profile.cloneStatus === 'ready';
  const isCloned = profile.cloneStatus === 'ready' && hasValidGitCheckout;

  // 1. CLONE STEP
  const cloneItems: StepPrerequisiteReport['items'] = [
    {
      id: 'clone-github-auth',
      label: 'GitHub Authentication',
      state: githubConnected ? 'passed' : 'blocking',
      message: githubConnected ? 'GitHub account is connected' : 'GitHub account not connected',
      remediation: githubConnected ? undefined : 'Connect your GitHub account in the Automatic Build settings.',
    },
    {
      id: 'clone-destination',
      label: 'Destination Directory',
      state: profile.repositoryPath.trim() ? 'passed' : 'blocking',
      message: profile.repositoryPath.trim()
        ? `Target directory: ${profile.repositoryPath}`
        : 'Destination folder path is required',
      remediation: profile.repositoryPath.trim() ? undefined : 'Specify a repository path in profile settings.',
    },
    {
      id: 'clone-repository',
      label: 'Remote Repository & Branch',
      state: profile.repository && profile.buildBranch ? 'passed' : 'blocking',
      message: profile.repository
        ? `Repository: ${profile.repository.fullName} (${profile.buildBranch || 'no branch selected'})`
        : 'No GitHub repository selected',
      remediation: profile.repository ? undefined : 'Select a GitHub repository and build branch.',
    },
  ];

  let cloneStatus: StepPrerequisiteStatus = 'ready';
  if (profile.cloneStatus === 'cloning') {
    cloneStatus = 'running';
  } else if (profile.cloneStatus === 'failed') {
    cloneStatus = 'blocked';
  } else {
    const hasBlocking = cloneItems.some((item) => item.state === 'blocking');
    cloneStatus = hasBlocking ? 'blocked' : 'ready';
  }

  const cloneReport: StepPrerequisiteReport = {
    stepId: 'clone',
    label: 'Clone Repository',
    status: cloneStatus,
    items: cloneItems,
    blockingReason: cloneItems.find((item) => item.state === 'blocking')?.message,
  };

  // 2. REPO SYNC STEP
  const repoItems: StepPrerequisiteReport['items'] = [];

  if (!isCloned) {
    repoItems.push({
      id: 'repo-checkout',
      label: 'Repository Checkout',
      state: 'blocking',
      message: 'Repository has not been cloned yet',
      remediation: 'Clone the repository before synchronizing code.',
    });
    repoItems.push({
      id: 'repo-branch',
      label: 'Branch Alignment',
      state: 'info',
      message: `Target branch: '${profile.buildBranch}'`,
    });
    repoItems.push({
      id: 'repo-worktree',
      label: 'Clean Working Tree',
      state: 'info',
      message: 'Worktree check pending initial clone',
    });
    repoItems.push({
      id: 'repo-gitignore',
      label: 'Unreal Engine .gitignore',
      state: 'info',
      message: '.gitignore check pending initial clone',
    });
  } else {
    // Repository is cloned
    const hasValidGitRepo = checkoutStatus ? checkoutStatus.result.ok : true;
    repoItems.push({
      id: 'repo-checkout',
      label: 'Repository Checkout',
      state: hasValidGitRepo ? 'passed' : 'blocking',
      message: hasValidGitRepo ? 'Valid Git repository checkout' : checkoutStatus?.result.error || 'Invalid repository checkout',
      remediation: hasValidGitRepo ? undefined : 'Verify the repository path or re-clone the repository.',
    });

    const isCurrentBranchMatch = checkoutStatus
      ? checkoutStatus.currentBranch === profile.buildBranch
      : profile.safetyStatus !== 'wrong-branch';
    repoItems.push({
      id: 'repo-branch',
      label: 'Branch Alignment',
      state: isCurrentBranchMatch ? 'passed' : 'blocking',
      message: isCurrentBranchMatch
        ? `Checked out on '${profile.buildBranch}'`
        : `Currently on '${checkoutStatus?.currentBranch || 'unknown'}', expected '${profile.buildBranch}'`,
      remediation: isCurrentBranchMatch ? undefined : `Switch local checkout to branch '${profile.buildBranch}'.`,
    });

    const isWorktreeClean = checkoutStatus ? checkoutStatus.worktreeClean : profile.safetyStatus !== 'local-changes';
    repoItems.push({
      id: 'repo-worktree',
      label: 'Clean Working Directory',
      state: isWorktreeClean ? 'passed' : 'blocking',
      message: isWorktreeClean
        ? 'Working directory clean (no uncommitted modifications)'
        : 'Uncommitted modifications or untracked files detected in checkout',
      remediation: isWorktreeClean ? undefined : 'Commit, stash, or discard local modifications before syncing.',
    });

    const isIndexClean = checkoutStatus ? checkoutStatus.indexClean : true;
    repoItems.push({
      id: 'repo-index',
      label: 'Clean Staged Index',
      state: isIndexClean ? 'passed' : 'blocking',
      message: isIndexClean ? 'Staged index is clean' : 'Uncommitted staged changes detected in index',
      remediation: isIndexClean ? undefined : 'Commit or unstage changes in index before syncing.',
    });

    // Unreal Engine .gitignore verification
    const gitignoreValid = checkoutStatus?.gitignoreValid ?? true;
    const missingEntries = checkoutStatus?.gitignoreMissingEntries ?? [];
    if (checkoutStatus && typeof checkoutStatus.gitignoreValid === 'boolean') {
      repoItems.push({
        id: 'repo-gitignore',
        label: 'Unreal Engine .gitignore',
        state: gitignoreValid ? 'passed' : 'blocking',
        message: gitignoreValid
          ? '.gitignore includes required Unreal Engine rules (Binaries, DerivedDataCache, Intermediate)'
          : `Missing required .gitignore entries: ${missingEntries.join(', ')}`,
        remediation: gitignoreValid
          ? undefined
          : `Add ${missingEntries.map((e) => `${e}/`).join(', ')} to .gitignore to prevent packaging files from dirtying the repository.`,
      });
    } else {
      repoItems.push({
        id: 'repo-gitignore',
        label: 'Unreal Engine .gitignore',
        state: 'passed',
        message: 'Unreal Engine .gitignore verification',
      });
    }

    // Git LFS: only required if repo uses LFS
    const requiresLfs = checkoutStatus?.requiresGitLfs ?? false;
    if (requiresLfs) {
      const lfsAvailable = checkoutStatus?.gitLfsAvailable ?? true;
      repoItems.push({
        id: 'repo-lfs',
        label: 'Git LFS Support',
        state: lfsAvailable ? 'passed' : 'blocking',
        message: lfsAvailable
          ? 'Git LFS installed and operational'
          : checkoutStatus?.gitLfsError || 'Git LFS is required by repository .gitattributes but not found in PATH',
        remediation: lfsAvailable ? undefined : 'Install Git LFS on this machine to download large assets.',
      });
    } else {
      repoItems.push({
        id: 'repo-lfs',
        label: 'Git LFS Support',
        state: 'passed',
        message: 'Git LFS not required for this repository',
      });
    }

    // Remote connectivity
    if (checkoutStatus && checkoutStatus.remoteCommit) {
      repoItems.push({
        id: 'repo-remote',
        label: 'Remote Reachability',
        state: 'passed',
        message: `Remote commit reachable (${checkoutStatus.remoteCommit.slice(0, 7)})`,
      });
    } else if (checkoutStatus && !checkoutStatus.result.ok) {
      repoItems.push({
        id: 'repo-remote',
        label: 'Remote Reachability',
        state: 'warning',
        message: 'Unable to reach remote repository',
        remediation: 'Check network connectivity or remote permissions.',
      });
    }
  }

  let repoStatus: StepPrerequisiteStatus = 'ready';
  if (repoItems.some((i) => i.state === 'blocking')) {
    repoStatus = 'blocked';
  } else if (repoItems.some((i) => i.state === 'warning')) {
    repoStatus = 'warning';
  }

  const repoReport: StepPrerequisiteReport = {
    stepId: 'repo',
    label: 'Git Sync & Checkout',
    status: repoStatus,
    items: repoItems,
    blockingReason: repoItems.find((i) => i.state === 'blocking')?.message,
  };

  // 3. PACKAGING STEP
  const packageItems: StepPrerequisiteReport['items'] = [];

  // Editor Process Safety
  const runningUe = uprojectRunningProcesses.filter((p) => p.isRunning);
  if (runningUe.length > 0 && !isPackagingInProgress) {
    const pids = runningUe.flatMap((p) => p.pids).filter(Boolean);
    const names = runningUe.map((p) => p.displayName).join(', ');
    packageItems.push({
      id: 'package-editor-process',
      label: 'Unreal Engine Process Check',
      state: 'blocking',
      message: `Unreal Engine is currently running (${names}${pids.length ? ` - PID ${pids.join(', ')}` : ''})`,
      remediation: 'Close Unreal Editor before packaging to avoid file locking conflicts and build failures.',
    });
  } else if (runningUe.length > 0 && isPackagingInProgress) {
    packageItems.push({
      id: 'package-editor-process',
      label: 'Unreal Engine Process Check',
      state: 'passed',
      message: isCurrentPackaging
        ? 'Unreal Engine build process is actively packaging'
        : 'Another build profile is actively packaging',
    });
  } else {
    packageItems.push({
      id: 'package-editor-process',
      label: 'Unreal Engine Process Check',
      state: 'passed',
      message: 'No active Unreal Engine processes detected',
    });
  }

  // Project file
  let detectedProjectVersion: string | undefined;
  if (profile.projectPath) {
    const filename = profile.projectPath.split(/[/\\]/).pop() || profile.projectPath;
    packageItems.push({
      id: 'package-project-file',
      label: 'Unreal Project File',
      state: 'passed',
      message: `Project file configured: ${filename}`,
    });
  } else if (checkoutStatus?.projects && checkoutStatus.projects.length === 1) {
    detectedProjectVersion = checkoutStatus.projects[0].engineVersion;
    packageItems.push({
      id: 'package-project-file',
      label: 'Unreal Project File',
      state: 'passed',
      message: `Detected project: ${checkoutStatus.projects[0].projectName}.uproject`,
    });
  } else if (checkoutStatus?.projects && checkoutStatus.projects.length > 1) {
    packageItems.push({
      id: 'package-project-file',
      label: 'Unreal Project File',
      state: 'warning',
      message: `Multiple (${checkoutStatus.projects.length}) .uproject files detected in checkout`,
      remediation: 'Select a specific project in profile settings.',
    });
  } else if (!isCloned) {
    packageItems.push({
      id: 'package-project-file',
      label: 'Unreal Project File',
      state: 'info',
      message: 'Project file check pending repository clone',
    });
  } else {
    packageItems.push({
      id: 'package-project-file',
      label: 'Unreal Project File',
      state: 'blocking',
      message: 'No .uproject file found in checkout',
      remediation: 'Ensure a valid .uproject file exists in the repository.',
    });
  }

  // Engine resolution
  const matchedEngine = findMatchingEngine(
    detectedProjectVersion,
    profile.enginePath,
    installedEngines
  );

  if (matchedEngine) {
    packageItems.push({
      id: 'package-engine',
      label: 'Engine Association',
      state: 'passed',
      message: `Engine resolved: ${matchedEngine.displayName || matchedEngine.version} (${matchedEngine.editorPath})`,
    });
  } else if (!isCloned && !profile.enginePath) {
    packageItems.push({
      id: 'package-engine',
      label: 'Engine Association',
      state: 'info',
      message: 'Engine association check pending repository clone',
    });
  } else {
    packageItems.push({
      id: 'package-engine',
      label: 'Engine Association',
      state: 'blocking',
      message: profile.enginePath
        ? `Configured engine path not found in installed engines: ${profile.enginePath}`
        : 'No matching installed Unreal Engine found for project association',
      remediation: 'Install the matching Unreal Engine version or select an engine path in profile settings.',
    });
  }

  // Target platform & configuration
  packageItems.push({
    id: 'package-config',
    label: 'Build Target & Platform',
    state: 'passed',
    message: `Target platform: ${profile.platform || 'Win64'} (${profile.packageConfig || 'Development'})`,
  });

  let packageStatus: StepPrerequisiteStatus = 'ready';
  if (packageItems.some((i) => i.state === 'blocking')) {
    packageStatus = 'blocked';
  } else if (packageItems.some((i) => i.state === 'warning')) {
    packageStatus = 'warning';
  }

  const packageReport: StepPrerequisiteReport = {
    stepId: 'package',
    label: 'Unreal Engine Packaging',
    status: packageStatus,
    items: packageItems,
    blockingReason: packageItems.find((i) => i.state === 'blocking')?.message,
  };

  // 4. ZIP ARCHIVE STEP
  const zipItems: StepPrerequisiteReport['items'] = [];
  let zipStatus: StepPrerequisiteStatus = 'ready';

  if (!globalSettings.archiveOnly) {
    zipStatus = 'disabled';
    zipItems.push({
      id: 'zip-mode',
      label: 'Zip Archive Mode',
      state: 'info',
      message: 'Zip compression is disabled in schedule settings (unpacked build kept).',
    });
  } else {
    zipItems.push({
      id: 'zip-target',
      label: 'Archive Output Destination',
      state: 'passed',
      message: `Zip archive will be written to ${profile.repositoryPath ? remoteBuildOutputRoot(profile.repositoryPath) : 'configured output root'}`,
    });
    zipItems.push({
      id: 'zip-dependency',
      label: 'Packaging Dependency',
      state: 'passed',
      message: 'Requires successful completion of the packaging stage.',
    });
  }

  const zipReport: StepPrerequisiteReport = {
    stepId: 'zip',
    label: 'Zip Compression',
    status: zipStatus,
    items: zipItems,
  };

  // 5. CLEANUP STEP
  const cleanupItems: StepPrerequisiteReport['items'] = [];
  let cleanupStatus: StepPrerequisiteStatus = 'ready';

  if (!globalSettings.keepBuildsEnabled && !globalSettings.archiveOnly) {
    cleanupStatus = 'disabled';
    cleanupItems.push({
      id: 'cleanup-mode',
      label: 'Retention Policy',
      state: 'info',
      message: 'Automatic cleanup is not configured in schedule settings.',
    });
  } else {
    cleanupItems.push({
      id: 'cleanup-policy',
      label: 'Retention Policy',
      state: 'passed',
      message: `Retains the ${globalSettings.keepBuildsCount} latest build(s) and cleans older output.`,
    });
  }

  const cleanupReport: StepPrerequisiteReport = {
    stepId: 'cleanup',
    label: 'Artifact Retention Cleanup',
    status: cleanupStatus,
    items: cleanupItems,
  };

  return {
    profileId: profile.id,
    evaluatedAt: new Date().toISOString(),
    isCloned,
    steps: {
      clone: cloneReport,
      repo: repoReport,
      package: packageReport,
      zip: zipReport,
      cleanup: cleanupReport,
    },
  };
}

export function isProfileBlocked(prereqs: ProfilePrerequisites): boolean {
  return (
    prereqs.steps.clone.status === 'blocked' ||
    prereqs.steps.repo.status === 'blocked' ||
    prereqs.steps.package.status === 'blocked'
  );
}

export function getProfileBlockReason(prereqs: ProfilePrerequisites): string | undefined {
  return (
    prereqs.steps.clone.blockingReason ||
    prereqs.steps.repo.blockingReason ||
    prereqs.steps.package.blockingReason
  );
}

export function getStepStatusWithLiveStage(
  _stepId: PipelineStepId,
  prereqStatus: StepPrerequisiteStatus,
  liveStageStatus: RemoteBuildStageStatus | undefined,
  profileStatus: RemoteBuildStatus
): StepPrerequisiteStatus {
  if (liveStageStatus === 'running') return 'running';
  if (liveStageStatus === 'failed') return 'blocked';
  if (liveStageStatus === 'disabled') return 'disabled';
  if (liveStageStatus === 'success' && profileStatus === 'success') return 'ready';
  return prereqStatus;
}

export function recordOrMergeRun(
  history: RemoteBuildRun[] | undefined,
  newRun: RemoteBuildRun
): RemoteBuildRun[] {
  const currentHistory = history || [];
  if (currentHistory.length === 0) {
    return [newRun];
  }
  const [lastRun, ...rest] = currentHistory;
  const isFailure = newRun.status === 'failed' || newRun.status === 'blocked';
  const isSameFailure =
    isFailure &&
    lastRun.status === newRun.status &&
    (lastRun.failedStage === newRun.failedStage || (!lastRun.failedStage && !newRun.failedStage)) &&
    ((lastRun.errorSummary && newRun.errorSummary && lastRun.errorSummary.trim() === newRun.errorSummary.trim()) ||
      (lastRun.error && newRun.error && lastRun.error.trim() === newRun.error.trim()));

  if (isSameFailure) {
    const mergedRun: RemoteBuildRun = {
      ...lastRun,
      ...newRun,
      id: lastRun.id,
      startedAt: lastRun.startedAt,
      completedAt: newRun.completedAt ?? newRun.startedAt,
      durationSeconds: (lastRun.durationSeconds ?? 0) + (newRun.durationSeconds ?? 0),
      count: (lastRun.count ?? 1) + (newRun.count ?? 1),
    };
    return [mergedRun, ...rest].slice(0, 50);
  }

  return [newRun, ...currentHistory].slice(0, 50);
}
