/**
 * Progress context - shared progress state for the progress bar below the output log.
 * Tools call startProgress() before invoke and finishProgress() in finally.
 * Scheduler uses startProgressForScheduler() for multi-step progress bars.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import { useSettingsContext } from './SettingsContext';

interface ProgressUpdate {
  percent: number;
  elapsedMs: number;
  phaseName?: string;
  currentStep?: number;
  totalSteps?: number;
}

interface ProgressStartOptions {
  showOutputLog?: boolean;
  notifyOnComplete?: boolean;
}

export interface StepProgress {
  totalSteps: number;
  currentStep: number;
  stepPercents: number[];
  stepLabels: string[];
}

interface ProgressContextValue {
  running: boolean;
  percent: number;
  elapsedMs: number;
  stepProgress: StepProgress | null;
  /** When true, ToolBoxTab should open the output log when this run starts. */
  shouldOpenOutputLog: boolean;
  startProgress: (opts?: ProgressStartOptions) => void;
  setNotifyOnComplete: (enabled: boolean) => void;
  finishProgress: () => void;
  startProgressForScheduler: (totalSteps: number, stepLabels: string[]) => void;
  setCurrentStep: (index: number) => void;
  /** Call when user presses Stop. Scheduler checks this to cancel remaining steps. */
  requestStop: () => void;
  /** Ref checked by scheduler loop - true when user requested stop. */
  stopRequestedRef: React.MutableRefObject<boolean>;
}

const ProgressContext = createContext<ProgressContextValue | null>(null);

export function ProgressProvider({ children }: { children: React.ReactNode }) {
  const { settings } = useSettingsContext();
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [stepProgress, setStepProgress] = useState<StepProgress | null>(null);
  const [shouldOpenOutputLog, setShouldOpenOutputLog] = useState(false);
  const stopRequestedRef = useRef(false);
  const prevRunningRef = useRef(running);
  const notifyOnCompleteRef = useRef(true);

  const requestStop = useCallback(() => {
    stopRequestedRef.current = true;
  }, []);

  const startProgress = useCallback((opts?: ProgressStartOptions) => {
    stopRequestedRef.current = false;
    notifyOnCompleteRef.current = opts?.notifyOnComplete ?? true;
    setShouldOpenOutputLog(opts?.showOutputLog ?? false);
    setRunning(true);
    setPercent(0);
    setElapsedMs(0);
    setStartTime(Date.now());
    setStepProgress(null);
  }, []);

  const setNotifyOnComplete = useCallback((enabled: boolean) => {
    notifyOnCompleteRef.current = enabled;
  }, []);

  const startProgressForScheduler = useCallback(
    (totalSteps: number, stepLabels: string[]) => {
      stopRequestedRef.current = false;
      notifyOnCompleteRef.current = true;
      setRunning(true);
      setPercent(0);
      setElapsedMs(0);
      setStartTime(Date.now());
      setStepProgress({
        totalSteps,
        currentStep: 0,
        stepPercents: Array(totalSteps).fill(0),
        stepLabels,
      });
    },
    []
  );

  const setCurrentStep = useCallback((index: number) => {
    setStepProgress((prev) => {
      if (!prev) return prev;
      const next = { ...prev, stepPercents: [...prev.stepPercents] };
      if (prev.currentStep < prev.totalSteps) {
        next.stepPercents[prev.currentStep] = 100;
      }
      next.currentStep = index;
      return next;
    });
  }, []);

  const finishProgress = useCallback(() => {
    setStepProgress((prev) => {
      if (prev) {
        const final = [...prev.stepPercents];
        if (prev.currentStep < prev.totalSteps) {
          final[prev.currentStep] = 100;
        }
        return { ...prev, stepPercents: final };
      }
      return prev;
    });
    setPercent(100);
    setRunning(false);
    setShouldOpenOutputLog(false);
  }, []);

  useEffect(() => {
    const unlisten = listen<ProgressUpdate>('progress-update', (event) => {
      const payload = event.payload;
      setStepProgress((prev) => {
        if (prev && prev.currentStep < prev.totalSteps) {
          const next = { ...prev, stepPercents: [...prev.stepPercents] };
          next.stepPercents[prev.currentStep] = payload.percent;
          return next;
        }
        return prev;
      });
      setPercent(payload.percent);
      if (payload.elapsedMs > 0) {
        setElapsedMs(payload.elapsedMs);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!running || startTime === null) return;
    const interval = setInterval(() => {
      setElapsedMs((prev) => {
        const fromStart = Date.now() - startTime;
        return Math.max(prev, fromStart);
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [running, startTime]);

  useEffect(() => {
    if (prevRunningRef.current && !running && notifyOnCompleteRef.current) {
      notifyOnCompleteRef.current = false;
      (async () => {
        if (!settings.notificationOnComplete) return;
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const win = getCurrentWindow();
          const [minimized, focused] = await Promise.all([win.isMinimized(), win.isFocused()]);
          const shouldNotify = minimized || !focused;
          if (shouldNotify) {
            const { isPermissionGranted, requestPermission, sendNotification } = await import(
              '@tauri-apps/plugin-notification'
            );
            let granted = await isPermissionGranted();
            if (!granted) {
              granted = (await requestPermission()) === 'granted';
            }
            if (granted) {
              sendNotification({ title: 'UE Launcher', body: 'Process completed.' });
            }
          }
        } catch (e) {
          console.error('Notification failed:', e);
        }
      })();
    }
    prevRunningRef.current = running;
  }, [running, settings.notificationOnComplete]);

  return (
    <ProgressContext.Provider
      value={{
        running,
        percent,
        elapsedMs,
        stepProgress,
        shouldOpenOutputLog,
        startProgress,
        setNotifyOnComplete,
        finishProgress,
        startProgressForScheduler,
        setCurrentStep,
        requestStop,
        stopRequestedRef,
      }}
    >
      {children}
    </ProgressContext.Provider>
  );
}

export function useProgress() {
  const ctx = useContext(ProgressContext);
  if (!ctx) throw new Error('useProgress must be used within ProgressProvider');
  return ctx;
}
