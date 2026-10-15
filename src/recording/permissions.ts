/**
 * Microphone permission without prompting. When the person has blocked the
 * microphone, the app explains how to allow it on this kind of device instead of
 * calling getUserMedia again: browsers refuse a blocked request without asking, and
 * repeated prompts confuse children and adults alike.
 */
export type MicrophonePermission = 'granted' | 'prompt' | 'denied' | 'unknown';

function normalize(state: string): MicrophonePermission {
  return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown';
}

async function permissionStatus(): Promise<PermissionStatus | null> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
  try {
    return await navigator.permissions.query({ name: 'microphone' as PermissionName });
  } catch {
    return null; // e.g. Firefox does not support querying the microphone permission
  }
}

/** Reads the microphone permission. 'unknown' where the browser cannot tell. */
export async function queryMicrophonePermission(): Promise<MicrophonePermission> {
  const status = await permissionStatus();
  return status ? normalize(status.state) : 'unknown';
}

/** Calls back when the permission changes in the browser or system settings. */
export function watchMicrophonePermission(onChange: (state: MicrophonePermission) => void): () => void {
  let status: PermissionStatus | null = null;
  let stopped = false;
  const handler = () => {
    if (status) onChange(normalize(status.state));
  };
  void permissionStatus().then((s) => {
    if (stopped || !s) return;
    status = s;
    s.addEventListener('change', handler);
  });
  return () => {
    stopped = true;
    status?.removeEventListener('change', handler);
  };
}

export interface DeviceContext {
  platform: 'android' | 'ios' | 'desktop';
  /** Running as an installed app (home-screen PWA or the Android app), without an address bar. */
  installed: boolean;
}

export function detectDeviceContext(
  env: { userAgent: string; maxTouchPoints?: number; standalone?: boolean; displayModeStandalone?: boolean; referrer?: string } = currentEnvironment(),
): DeviceContext {
  const ua = env.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1);
  const android = /Android/.test(ua);
  const installed = Boolean(env.displayModeStandalone || env.standalone || env.referrer?.startsWith('android-app://'));
  return { platform: ios ? 'ios' : android ? 'android' : 'desktop', installed };
}

function currentEnvironment() {
  if (typeof navigator === 'undefined') return { userAgent: '' };
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone: typeof window !== 'undefined' && Boolean(window.matchMedia?.('(display-mode: standalone)').matches),
    referrer: typeof document !== 'undefined' ? document.referrer : '',
  };
}

/**
 * When the browser already allows the microphone but capture is still refused, the
 * device's own privacy settings are usually blocking the browser.
 */
export function systemMicrophoneSteps(context: DeviceContext): string[] {
  if (context.platform === 'android') {
    return ['Open the phone’s Settings, then Apps → Chrome (or Tinig Turo) → Permissions → Microphone, and choose Allow.'];
  }
  if (context.platform === 'ios') {
    return ['Open the Settings app, find Safari (on newer versions: Apps, then Safari), and set Microphone to Ask or Allow.'];
  }
  return [
    'Windows: Settings → Privacy & security → Microphone, and allow apps and this browser to use it.',
    'Mac: System Settings → Privacy & Security → Microphone, and turn it on for this browser.',
  ];
}

/**
 * Where a grown-up usually allows the microphone again. Menus differ between browser
 * versions, so the wording names what to look for rather than exact positions.
 */
export function microphoneRecoverySteps(context: DeviceContext): string[] {
  const end = 'Come back to Tinig Turo and press “Check again”.';
  if (context.platform === 'android') {
    return context.installed
      ? [
          'Touch and hold the Tinig Turo icon on the home screen, then choose “Site settings” or “App info”.',
          'Open Permissions, choose Microphone, and select Allow.',
          end,
        ]
      : [
          'Tap the settings icon to the left of the web address.',
          'Choose Permissions, then turn on Microphone (or choose Allow).',
          end,
        ];
  }
  if (context.platform === 'ios') {
    return context.installed
      ? [
          'Open the Settings app and find Safari (on newer versions: Apps, then Safari).',
          'Set Microphone to Ask or Allow.',
          'Close Tinig Turo completely, open it again, and press Start.',
        ]
      : [
          'Tap the page settings button (“aA”) in the address bar, then Website Settings.',
          'Set Microphone to Allow.',
          end,
        ];
  }
  return context.installed
    ? [
        'Open the app menu (⋮ or … at the top of the window) and choose App info or Site settings.',
        'Set Microphone to Allow.',
        end,
      ]
    : [
        'Click the icon to the left of the web address (a lock or settings icon).',
        'Set Microphone to Allow. Some browsers then ask you to reload the page.',
        end,
      ];
}
