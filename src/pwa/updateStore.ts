/**
 * Service-worker update coordination. A new version is downloaded in the background,
 * but it is only activated when the reader chooses to, and never while a recording
 * is active, so an update can never interrupt an attempt or discard unsaved work.
 */
export interface UpdateState {
  needRefresh: boolean;
  offlineReady: boolean;
  registrationError: string | null;
}

type Apply = (reload: boolean) => Promise<void>;

export class UpdateStore {
  private state: UpdateState = { needRefresh: false, offlineReady: false, registrationError: null };
  private listeners = new Set<() => void>();
  private applyFn: Apply | null = null;
  private deferred = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  attach(apply: Apply) {
    this.applyFn = apply;
  }

  markNeedRefresh() {
    this.set({ needRefresh: true });
  }

  markOfflineReady() {
    this.set({ offlineReady: true });
  }

  markError(message: string) {
    this.set({ registrationError: message });
  }

  /** Whether activating the update now is safe. */
  static canApply(context: { recordingActive: boolean }): boolean {
    return !context.recordingActive;
  }

  /**
   * Applies the waiting update if safe. Returns false (and remembers the request)
   * when a recording is active; call `flushDeferred` when it ends.
   */
  async apply(context: { recordingActive: boolean }): Promise<boolean> {
    if (!this.state.needRefresh || !this.applyFn) return false;
    if (!UpdateStore.canApply(context)) {
      this.deferred = true;
      return false;
    }
    this.deferred = false;
    await this.applyFn(true);
    return true;
  }

  get isDeferred() {
    return this.deferred;
  }

  dismiss() {
    this.set({ needRefresh: false });
  }
}

export const updateStore = new UpdateStore();
