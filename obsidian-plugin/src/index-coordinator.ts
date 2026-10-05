import { createHash, randomUUID } from "crypto";
import { runEmbedSequence, type EmbedSequenceResult, type EmbedStepName } from "./health-checks";
import { parseQmdEnvironment, runQmdEmbed, runQmdUpdate } from "./qmd-request";
import type { AhaPluginSettings } from "./settings";

export interface InventoryFile { path: string; filesystemId?: string }
export interface IndexNote extends InventoryFile { token: string }
export interface IndexState {
  version: 1;
  target: string;
  initialized: boolean;
  notes: IndexNote[];
  pending: string[];
  retryAfter: number;
  lastSuccess: number | null;
  error: string | null;
}
export type IndexStatus =
  | { kind: "idle"; pending: number; lastSuccess: number | null }
  | { kind: "running"; pending: number; step: EmbedStepName }
  | { kind: "failed"; pending: number; message: string; retryAfter: number };

export function normalizeIndexThreshold(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 10;
}
export function emptyIndexState(target: string): IndexState {
  return { version: 1, target, initialized: false, notes: [], pending: [], retryAfter: 0, lastSuccess: null, error: null };
}
export function normalizeIndexState(raw: unknown): IndexState | undefined {
  if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 ||
    !("target" in raw) || typeof raw.target !== "string" ||
    !("initialized" in raw) || typeof raw.initialized !== "boolean" ||
    !("notes" in raw) || !Array.isArray(raw.notes) ||
    !("pending" in raw) || !Array.isArray(raw.pending)) return undefined;
  const notes: IndexNote[] = [];
  const tokens = new Set<string>();
  const paths = new Set<string>();
  for (const note of raw.notes) {
    if (!note || typeof note !== "object" || typeof note.path !== "string" || typeof note.token !== "string" ||
      tokens.has(note.token) || paths.has(note.path) || (note.filesystemId !== undefined && typeof note.filesystemId !== "string")) return undefined;
    notes.push({ path: note.path, token: note.token, filesystemId: note.filesystemId });
    tokens.add(note.token);
    paths.add(note.path);
  }
  return {
    ...emptyIndexState(raw.target), initialized: raw.initialized, notes,
    pending: [...new Set(raw.pending.filter((token): token is string => typeof token === "string" && tokens.has(token)))],
    retryAfter: "retryAfter" in raw && typeof raw.retryAfter === "number" && Number.isFinite(raw.retryAfter) ? raw.retryAfter : 0,
    lastSuccess: "lastSuccess" in raw && typeof raw.lastSuccess === "number" && Number.isFinite(raw.lastSuccess) ? raw.lastSuccess : null,
    error: "error" in raw && typeof raw.error === "string" ? raw.error : null,
  };
}
export function indexTarget(settings: AhaPluginSettings): string {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QMD_") || key === "XDG_CACHE_HOME" || key === "XDG_CONFIG_HOME" || key === "HOME" || key === "INDEX_PATH"));
  const env = { ...inherited, ...parseQmdEnvironment(settings.qmdEnvironment) };
  return createHash("sha256").update(JSON.stringify([settings.qmdCommand, settings.qmdIndex, Object.entries(env).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
}

export function reconcileInventory(state: IndexState, files: InventoryFile[], newToken: () => string = randomUUID): IndexState {
  const byPath = new Map(state.notes.map(note => [note.path, note]));
  const used = new Set<string>();
  const oldIds = new Map<string, IndexNote[]>();
  const newIds = new Map<string, number>();
  for (const note of state.notes) {
    if (note.filesystemId?.startsWith("srcfs:")) oldIds.set(note.filesystemId, [...(oldIds.get(note.filesystemId) ?? []), note]);
  }
  for (const file of files) if (file.filesystemId) newIds.set(file.filesystemId, (newIds.get(file.filesystemId) ?? 0) + 1);
  for (const file of files) { const note = byPath.get(file.path); if (note) used.add(note.token); }
  const pending = new Set(state.pending);
  const notes = files.map(file => {
    let previous = byPath.get(file.path);
    if (!previous && file.filesystemId && newIds.get(file.filesystemId) === 1) {
      const matches = oldIds.get(file.filesystemId);
      if (matches?.length === 1 && !used.has(matches[0].token)) previous = matches[0];
    }
    const token = previous?.token ?? newToken();
    used.add(token);
    if (!previous && state.initialized) pending.add(token);
    return { ...file, token };
  });
  return { ...state, initialized: true, notes, pending: [...pending].filter(token => used.has(token)) };
}

interface IndexCoordinatorDeps {
  settings(): AhaPluginSettings;
  inventory(): Promise<InventoryFile[]>;
  persist(state: IndexState): Promise<void>;
  now?(): number;
}

export class IndexCoordinator {
  private state: IndexState;
  private writes: Promise<void> = Promise.resolve();
  private flight?: Promise<EmbedSequenceResult>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(status: IndexStatus) => void>();
  private running?: EmbedStepName;
  private failure?: string;
  private ready = false;
  private scheduledRetry = false;
  private retryAfter = 0;
  private disposed = false;
  private now: () => number;
  private configuration: string;

  constructor(private deps: IndexCoordinatorDeps, restored?: IndexState) {
    this.state = restored ?? emptyIndexState(indexTarget(deps.settings()));
    this.now = deps.now ?? Date.now;
    this.configuration = this.configurationKey();
  }
  get status(): IndexStatus {
    const pending = this.state.pending.length;
    if (this.running) return { kind: "running", pending, step: this.running };
    if (this.failure || this.state.error) return { kind: "failed", pending, message: this.failure ?? this.state.error ?? "Index update failed.", retryAfter: this.state.retryAfter };
    return { kind: "idle", pending, lastSuccess: this.state.lastSuccess };
  }
  subscribe(listener: (status: IndexStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }
  private emit(): void { for (const listener of this.listeners) listener(this.status); }
  private change(next: (current: IndexState) => Promise<IndexState> | IndexState): Promise<void> {
    const operation = this.writes.then(async () => {
      if (this.disposed) return;
      const value = await next(this.state);
      await this.deps.persist(value);
      this.state = value;
      this.emit();
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async reconcile(): Promise<void> {
    await this.change(async current => {
      const target = indexTarget(this.deps.settings());
      const next = reconcileInventory(current.target === target ? current : emptyIndexState(target), await this.deps.inventory());
      if (current.target !== target) { this.failure = undefined; this.retryAfter = 0; }
      return next;
    });
  }
  async start(): Promise<void> {
    if (this.disposed) return;
    this.ready = true;
    await this.observe();
  }
  private configurationKey(): string {
    const settings = this.deps.settings();
    return JSON.stringify([indexTarget(settings), settings.autoIndexEnabled, normalizeIndexThreshold(settings.autoIndexNoteThreshold)]);
  }
  configure(): void {
    const configuration = this.configurationKey();
    if (configuration === this.configuration) return;
    this.configuration = configuration;
    if (this.ready) this.schedule();
  }
  schedule(oldPath?: string, newPath?: string, allowRetry = true): void {
    if (!this.ready || this.disposed) return;
    if (oldPath && newPath) {
      void this.change(state => ({ ...state, notes: state.notes.map(note => note.path === oldPath || note.path.startsWith(`${oldPath}/`) ? { ...note, path: newPath + note.path.slice(oldPath.length) } : note) })).catch(error => this.report(error));
    }
    this.scheduledRetry ||= allowRetry;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const retry = this.scheduledRetry;
      this.scheduledRetry = false;
      void this.observe(retry);
    }, 350);
  }
  private report(error: unknown): void {
    this.failure = error instanceof Error ? error.message : String(error);
    this.emit();
  }
  private async observe(allowRetry = true): Promise<void> {
    try {
      await this.reconcile();
      if (allowRetry && this.canAutoRun()) void this.refresh();
    } catch (error) { this.report(error); }
  }
  private canAutoRun(): boolean {
    const settings = this.deps.settings();
    return this.ready && !this.disposed && !this.flight && settings.autoIndexEnabled &&
      this.state.pending.length >= normalizeIndexThreshold(settings.autoIndexNoteThreshold) && this.now() >= Math.max(this.state.retryAfter, this.retryAfter);
  }
  refresh(): Promise<EmbedSequenceResult> {
    if (this.flight) return this.flight;
    if (this.disposed || !this.ready) return Promise.resolve({ ok: false, steps: [{ step: "update", ok: false, message: "Index maintenance is not ready." }] });
    const controller = new AbortController();
    this.controller = controller;
    const flight = Promise.resolve().then(() => this.run(controller.signal));
    this.flight = flight;
    void flight.then(result => {
      this.flight = undefined;
      this.controller = undefined;
      this.running = undefined;
      this.emit();
      if (result.ok && this.canAutoRun()) this.schedule();
    });
    return flight;
  }
  private async run(signal: AbortSignal): Promise<EmbedSequenceResult> {
    let target = "";
    try {
      await this.reconcile();
      const settings = { ...this.deps.settings() };
      target = indexTarget(settings);
      if (this.state.target !== target || signal.aborted) throw new Error("Index update cancelled.");
      const batch = new Set(this.state.pending);
      this.failure = undefined;
      const result = await runEmbedSequence({
        runUpdate: () => runQmdUpdate(settings, signal),
        runEmbed: () => runQmdEmbed(settings, signal),
      }, (step) => { this.running = step; this.emit(); });
      if (!result.ok) throw new Error(result.steps.at(-1)?.message ?? "Index update failed.");
      if (signal.aborted) throw new Error("Index update cancelled.");
      await this.reconcile();
      if (this.state.target !== target || indexTarget(this.deps.settings()) !== target) {
        return { ok: false, steps: [{ step: "embed", ok: false, message: "QMD target changed during update. Refresh the current index." }] };
      }
      await this.change(state => state.target === target && indexTarget(this.deps.settings()) === target ? {
        ...state, pending: state.pending.filter(token => !batch.has(token)), retryAfter: 0, lastSuccess: this.now(), error: null,
      } : state);
      this.retryAfter = 0;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (target && indexTarget(this.deps.settings()) !== target) {
        return { ok: false, steps: [{ step: this.running ?? "update", ok: false, message: "QMD target changed during update. Refresh the current index." }] };
      }
      this.retryAfter = this.now() + 60_000;
      this.report(error);
      try {
        await this.change(state => !target || state.target === target ? { ...state, error: message, retryAfter: this.retryAfter } : state);
      } catch {}
      return { ok: false, steps: [{ step: this.running ?? "update", ok: false, message }] };
    }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.listeners.clear();
  }
}
