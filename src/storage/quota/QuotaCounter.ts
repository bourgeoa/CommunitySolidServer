import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { joinFilePath, normalizeFilePath } from '../../util/PathUtil';
import type { FileIdentifierMapper } from '../mapping/FileIdentifierMapper';
import type { Size } from '../size-reporter/Size';
import { UNIT_BYTES } from '../size-reporter/Size';
import { DuSizeReporter } from '../size-reporter/DuSizeReporter';

// In-memory counter entry for one pod.
interface CounterEntry {
  total: number;
  valid: boolean;
  podMtimeMs: number;
  /** Epoch ms at which the counter was last known to be correct. */
  updatedAt: number;
}

/**
 * Incremental per-pod byte counter (design C).
 *
 * Keeps the apparent-byte total of every pod in memory, updated O(1) per
 * write by the {@link QuotaDeltaDataAccessor} delta hook, and persisted to a
 * per-pod sidecar (`<podRoot>/.internal/css-quota.json`, atomic rename) so
 * counters survive restarts. A full `du`/Node walk (via DuSizeReporter) is
 * only used to bootstrap a pod (first access, no sidecar) or recover a
 * de-synchronized counter.
 *
 * The counter is a cache; the filesystem is the source of truth. Staleness
 * (out-of-band changes, crash window) is detected cheaply by comparing the
 * pod root directory's mtime against the recorded one, then re-walking once.
 *
 * Because the pod root mtime only changes for direct children, deep out-of-band
 * changes are invisible to that check. An optional max age (`maxAgeMs`, 0 =
 * disabled) bounds this window: a counter older than the max age is always
 * re-walked on access, guaranteeing the total is at most `maxAgeMs` old.
 *
 * Benchmark (Windows, Node-walk fallback, 3 000 x 1 KiB files in one pod, see
 * `scripts/benchmark-quota-counter.cjs`): one full pod walk ~365 ms, an O(1)
 * counter read ~0.25 ms (~1 000-1 500x faster per quota check), and a delta +
 * sidecar persist ~4 ms per write.
 */
export class QuotaCounter {
  private readonly fileIdentifierMapper: FileIdentifierMapper;
  private readonly rootFilePath: string;
  private readonly sidecarRelativePath: string;
  private readonly maxAgeMs: number;
  private readonly walker: DuSizeReporter;
  private readonly entries = new Map<string, CounterEntry>();
  private readonly locks = new Map<string, Promise<void>>();

  public constructor(
    fileIdentifierMapper: FileIdentifierMapper,
    rootFilePath: string,
    ignoreFolders: string[] = [],
    sidecarRelativePath = '/.internal/css-quota.json',
    maxAgeMs = 0,
  ) {
    this.fileIdentifierMapper = fileIdentifierMapper;
    this.rootFilePath = normalizeFilePath(rootFilePath);
    this.sidecarRelativePath = sidecarRelativePath;
    this.maxAgeMs = maxAgeMs;
    // Dedicated walker with no cache — every call is a fresh recount.
    this.walker = new DuSizeReporter(fileIdentifierMapper, rootFilePath, ignoreFolders, 0);
  }

  /** The QuotaCounter always reports in bytes. */
  public getUnit(): string {
    return UNIT_BYTES;
  }

  /**
   * Returns the pod's current total, performing a recount (walk) only when
   * the pod has no valid counter (first access, no sidecar, or staleness).
   */
  public async getSize(podIdentifier: ResourceIdentifier): Promise<Size> {
    const path = await this.mapDataPath(podIdentifier);
    const entry = await this.ensureEntry(path, podIdentifier);
    return { unit: UNIT_BYTES, amount: entry.total };
  }

  /**
   * Marks a path as a pod root so {@link IncrementalSizeReporter} routes
   * pod-root identifiers to the counter. Called by the delta hook when it
   * first discovers a pod.
   */
  public async register(podIdentifier: ResourceIdentifier): Promise<void> {
    const path = await this.mapDataPath(podIdentifier);
    if (!this.entries.has(path)) {
      this.entries.set(path, { total: 0, valid: false, podMtimeMs: 0, updatedAt: Date.now() });
    }
  }

  /** Whether the given identifier maps to a known pod root. */
  public async isPodRoot(identifier: ResourceIdentifier): Promise<boolean> {
    return this.entries.has(await this.mapDataPath(identifier));
  }

  /**
   * Applies a size delta to the pod. Updates the in-memory counter and
   * persists the sidecar atomically. Per-pod mutex serializes concurrent
   * writes.
   */
  public async add(podIdentifier: ResourceIdentifier, delta: number): Promise<void> {
    const path = await this.mapDataPath(podIdentifier);
    await this.withLock(path, async(): Promise<void> => {
      const entry = this.entries.get(path) ?? { total: 0, valid: false, podMtimeMs: 0, updatedAt: Date.now() };
      entry.total += delta;
      entry.valid = true;
      entry.updatedAt = Date.now();
      this.entries.set(path, entry);
      await this.persistWithMtime(path, entry);
    });
  }

  /** Drops the counter for a pod and removes its sidecar (pod deletion). */
  public async remove(podIdentifier: ResourceIdentifier): Promise<void> {
    const path = await this.mapDataPath(podIdentifier);
    await this.withLock(path, async(): Promise<void> => {
      this.entries.delete(path);
      try {
        await fs.rm(this.sidecarPath(path), { force: true });
      } catch {
        // Best-effort: dropping the in-memory counter is authoritative; a leftover
        // sidecar is detected via pod-root mtime and re-walked on next access.
      }
    });
  }

  /**
   * Apparent size of a single resource (not a pod root) — used by the
   * reporter for the overwritten-resource subtraction in
   * `QuotaStrategy.getAvailableSpace`. Single stat for a document; walk for a
   * container.
   */
  public async sizeOfResource(identifier: ResourceIdentifier): Promise<number> {
    const filePath = await this.mapDataPath(identifier);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        return stat.size;
      }
      // Container — walk it (rare: only the overwritten resource is a file).
      return (await this.walker.getSize(identifier)).amount;
    } catch {
      return 0;
    }
  }

  /** Maps an identifier to its data file path (normalized). */
  public async mapDataPath(identifier: ResourceIdentifier): Promise<string> {
    const { filePath } = await this.fileIdentifierMapper.mapUrlToFilePath(identifier, false);
    return normalizeFilePath(filePath);
  }

  /**
   * Full apparent-byte walk of a resource/container (used by the delta hook
   * for container before/after sizing — rare, e.g. create/delete container).
   */
  public async walk(identifier: ResourceIdentifier): Promise<number> {
    return (await this.walker.getSize(identifier)).amount;
  }

  // --- Internals ---

  private async ensureEntry(path: string, podIdentifier: ResourceIdentifier): Promise<CounterEntry> {
    let entry = this.entries.get(path);
    if (this.isFresh(entry)) {
      const mtime = await this.podRootMtime(path);
      if (entry.podMtimeMs === mtime) {
        return entry;
      }
      // Pod root mtime moved — the counter may be stale, recount below.
    }
    // Try the sidecar first (persisted counter), then a full walk.
    return this.withLock(path, async(): Promise<CounterEntry> => {
      entry = this.entries.get(path);
      if (this.isFresh(entry)) {
        const mtime = await this.podRootMtime(path);
        if (entry.podMtimeMs === mtime) {
          return entry;
        }
      }
      const loaded = await this.loadSidecar(path);
      if (this.isFresh(loaded)) {
        const mtime = await this.podRootMtime(path);
        if (loaded.podMtimeMs === mtime) {
          this.entries.set(path, loaded);
          return loaded;
        }
      }
      // No valid counter — full walk (bootstrap / recovery / max-age expiry).
      const total = (await this.walker.getSize(podIdentifier)).amount;
      const fresh: CounterEntry = { total, valid: true, podMtimeMs: 0, updatedAt: Date.now() };
      this.entries.set(path, fresh);
      await this.persistWithMtime(path, fresh);
      return fresh;
    });
  }

  /**
   * Whether the entry can be trusted without a recount: it must be valid and,
   * when a max age is configured, not older than `maxAgeMs`. A `maxAgeMs` of 0
   * (or less) disables the age check entirely.
   */
  private isFresh(entry: CounterEntry | undefined): entry is CounterEntry {
    return entry !== undefined && entry.valid &&
      (this.maxAgeMs <= 0 || Date.now() - entry.updatedAt < this.maxAgeMs);
  }

  private async podRootMtime(path: string): Promise<number> {
    try {
      const stat = await fs.stat(path);
      return stat.isDirectory() ? stat.mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  private sidecarPath(podRootPath: string): string {
    return normalizeFilePath(joinFilePath(podRootPath, this.sidecarRelativePath));
  }

  private async loadSidecar(path: string): Promise<CounterEntry | undefined> {
    try {
      const raw = await fs.readFile(this.sidecarPath(path), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' && parsed !== null &&
        'total' in parsed && 'podMtimeMs' in parsed &&
        typeof parsed.total === 'number' && typeof parsed.podMtimeMs === 'number'
      ) {
        // Older sidecars may lack `updatedAt`; treat them as immediately stale
        // so they are refreshed once when a max age is configured.
        let updatedAt = 0;
        if ('updatedAt' in parsed && typeof parsed.updatedAt === 'string') {
          updatedAt = Date.parse(parsed.updatedAt);
          if (!Number.isFinite(updatedAt)) {
            updatedAt = 0;
          }
        }
        return { total: parsed.total, valid: true, podMtimeMs: parsed.podMtimeMs, updatedAt };
      }
    } catch {
      // Missing or malformed sidecar → recount.
    }
    return undefined;
  }

  private async persist(path: string, entry: CounterEntry): Promise<void> {
    const sidecar = this.sidecarPath(path);
    const tmp = `${sidecar}.tmp`;
    try {
      await fs.mkdir(join(path, '.internal'), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify({
        version: 1,
        total: entry.total,
        podMtimeMs: entry.podMtimeMs,
        updatedAt: new Date().toISOString(),
      }));
      await fs.rename(tmp, sidecar);
    } catch {
      // Persistence is best-effort: keep the in-memory counter authoritative.
    }
  }

  /**
   * Persist, then record the pod root mtime AFTER the persist. Persisting the
   * sidecar may create the `.internal/` directory (a new pod-root child), which
   * bumps the pod root's mtime — recording the mtime before would leave every
   * subsequent read thinking the counter is stale.
   */
  private async persistWithMtime(path: string, entry: CounterEntry): Promise<void> {
    await this.persist(path, entry);
    entry.podMtimeMs = await this.podRootMtime(path);
    await this.persist(path, entry);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve): void => {
      resolveGate = resolve;
    });
    // Waiters chain on `previous`, then wait for this call's `gate` to open.
    const next = previous.then(async(): Promise<void> => {
      await gate;
    });
    this.locks.set(key, next);
    await previous;
    try {
      return await fn();
    } finally {
      resolveGate?.();
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }
}
