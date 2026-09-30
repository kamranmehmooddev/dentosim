/**
 * Simulation package client: reads metadata.json and stage TSM2 files through
 * short-lived signed URLs, with an LRU cache and prefetch of upcoming stages.
 * The viewer never needs the original upload.
 */
import { decodeTsm2, type DecodedTsm2 } from "./tsm2.js";

export type Jaw = "upper" | "lower";

export interface ToothMovement {
  jaw: Jaw;
  toothId: string;
  fdi?: number;
  stage: number;
  translationMm: [number, number, number];
  translationMagnitudeMm: number;
  mesialDistalMm: number;
  buccalLingualMm: number;
  extrusionIntrusionMm: number;
  rotationDeg: number;
  tipDeg: number;
  torqueDeg: number;
  rotationAboutLongAxisDeg: number;
}

export interface PackageMetadata {
  packageFormat: string;
  stageCount: number;
  stagesPerJaw: Partial<Record<Jaw, number>>;
  disclaimer: string[];
  thumbnails: string[];
  compression: { ratio: number; errorTrimmedMeanMm: number };
  files: Record<string, { sha256: string; bytes: number }>;
  case: {
    arches: Partial<Record<Jaw, { jaw: Jaw; stages: { index: number; sourceLabel?: string; segmented: boolean; parts: { id: string; kind: string; fdi?: number; mesh: { uri: string } }[] }[] }>>;
    scans?: Partial<Record<"upper" | "lower" | "bite", { uri: string }>>;
    toothMovements?: ToothMovement[];
    registration?: { performed: boolean; note: string; upper?: { trimmedMeanMm: number; medianMm: number }; lower?: { trimmedMeanMm: number; medianMm: number } };
    segmentation?: { jaws: Partial<Record<Jaw, { unsegmented: boolean; proceduralGums: boolean }>> };
    normalization?: { interArch: string };
    warnings: { code: string; severity: string; message: string }[];
  };
}

/** path inside the package → URL (signed) */
export type FileUrls = Record<string, string>;

export const stageFile = (jaw: Jaw, index: number) => `${jaw}/stage-${String(index).padStart(2, "0")}.tsm2`;

export class PackageClient {
  private readonly cache = new Map<string, Promise<DecodedTsm2>>();
  private readonly order: string[] = [];
  metadata!: PackageMetadata;

  constructor(
    private urls: FileUrls,
    private readonly opts: { cacheSize?: number; fetchImpl?: typeof fetch; refreshUrls?: () => Promise<FileUrls> } = {},
  ) {}

  async load(): Promise<PackageMetadata> {
    this.metadata = (await (await this.fetchWithRefresh("metadata.json")).json()) as PackageMetadata;
    return this.metadata;
  }

  /** stages available for a jaw (0 when the jaw is absent) */
  stagesOf(jaw: Jaw): number {
    return this.metadata.stagesPerJaw[jaw] ?? 0;
  }

  get jaws(): Jaw[] {
    return (["upper", "lower"] as Jaw[]).filter((j) => this.stagesOf(j) > 0);
  }

  /** The stage file actually shown for a global stage index (an arch that finished earlier holds its last stage). */
  clampStage(jaw: Jaw, stage: number): number {
    return Math.max(0, Math.min(stage, this.stagesOf(jaw) - 1));
  }

  private async fetchWithRefresh(path: string): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    let url = this.urls[path];
    if (!url) throw new Error(`file not in package: ${path}`);
    let res = await f(url);
    // signed URLs are short-lived: refresh once on 403/404/410
    if (!res.ok && this.opts.refreshUrls && [401, 403, 404, 410].includes(res.status)) {
      this.urls = await this.opts.refreshUrls();
      url = this.urls[path];
      res = await f(url);
    }
    if (!res.ok) throw new Error(`failed to load ${path} (${res.status})`);
    return res;
  }

  file(path: string): Promise<DecodedTsm2> {
    let p = this.cache.get(path);
    if (p) {
      this.order.splice(this.order.indexOf(path), 1);
      this.order.push(path);
      return p;
    }
    p = this.fetchWithRefresh(path).then(async (r) => decodeTsm2(new Uint8Array(await r.arrayBuffer())));
    p.catch(() => this.cache.delete(path));
    this.cache.set(path, p);
    this.order.push(path);
    const max = this.opts.cacheSize ?? 64;
    while (this.order.length > max) this.cache.delete(this.order.shift()!);
    return p;
  }

  stage(jaw: Jaw, stage: number): Promise<DecodedTsm2> {
    return this.file(stageFile(jaw, this.clampStage(jaw, stage)));
  }

  /** Warm the cache for the next `ahead` stages of every jaw. */
  prefetch(stage: number, ahead = 3): void {
    for (const j of this.jaws)
      for (let k = 1; k <= ahead; k++) {
        const s = this.clampStage(j, stage + k);
        void this.file(stageFile(j, s)).catch(() => undefined);
      }
  }

  scan(which: "upper" | "lower" | "bite"): Promise<DecodedTsm2> | null {
    const ref = this.metadata.case.scans?.[which];
    return ref ? this.file(ref.uri) : null;
  }

  movementOf(toothId: string, jaw: Jaw, stage: number): ToothMovement | null {
    const s = this.clampStage(jaw, stage);
    return this.metadata.case.toothMovements?.find((m) => m.toothId === toothId && m.jaw === jaw && m.stage === s) ?? null;
  }

  stageLabel(stage: number): string {
    const j = this.jaws[0];
    const st = j ? this.metadata.case.arches[j]?.stages[this.clampStage(j, stage)] : undefined;
    return st?.sourceLabel ?? String(stage);
  }
}
