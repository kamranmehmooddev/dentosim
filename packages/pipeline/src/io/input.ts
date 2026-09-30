/**
 * Export intake: turn whatever the lab uploaded (a .zip, nested zips, a folder,
 * loose files, .7z/.rar when the worker has 7-Zip) into a flat list of virtual
 * files, enforcing upload hardening rules:
 *
 *  - file-count, per-file and total size limits
 *  - zip-slip: absolute paths / ".." segments are rejected
 *  - zip-bomb: declared compression ratio and total inflated size are capped
 *  - nested archives up to a fixed depth
 *  - OS junk (__MACOSX, .DS_Store, Thumbs.db) dropped
 *  - byte-identical duplicates reported (adapters decide whether they are redundant)
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { unzipSync } from "fflate";

export interface VirtualFile {
  /** normalised relative path, forward slashes, no leading slash */
  path: string;
  size: number;
  data: Uint8Array;
  sha256: string;
}

export interface IntakeLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** maximum inflated/compressed ratio of a single zip entry */
  maxCompressionRatio: number;
  maxArchiveDepth: number;
}

export const DEFAULT_LIMITS: IntakeLimits = {
  maxFiles: 5000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxArchiveDepth: 3,
};

export interface IntakeResult {
  files: VirtualFile[];
  /** byte-identical files (path → first path with the same content); informational */
  duplicates: { path: string; duplicateOf: string }[];
  /** junk files dropped */
  skipped: string[];
}

export class IntakeError extends Error {
  constructor(
    public readonly code: "LIMIT_FILES" | "LIMIT_SIZE" | "ZIP_SLIP" | "ZIP_BOMB" | "BAD_ARCHIVE" | "UNSUPPORTED_ARCHIVE" | "EMPTY",
    message: string,
  ) {
    super(message);
    this.name = "IntakeError";
  }
}

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)(\/|$)/i;

/** Normalise an archive/entry path and reject traversal attempts. */
export function safePath(raw: string): string {
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new IntakeError("ZIP_SLIP", `Absolute path in upload rejected: ${raw}`);
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new IntakeError("ZIP_SLIP", `Path traversal in upload rejected: ${raw}`);
    parts.push(seg);
  }
  return parts.join("/");
}

const isZip = (d: Uint8Array) => d.length >= 4 && d[0] === 0x50 && d[1] === 0x4b && (d[2] === 3 || d[2] === 5) && (d[3] === 4 || d[3] === 6);
const is7z = (d: Uint8Array) => d.length >= 6 && d[0] === 0x37 && d[1] === 0x7a && d[2] === 0xbc && d[3] === 0xaf;
const isRar = (d: Uint8Array) => d.length >= 4 && d[0] === 0x52 && d[1] === 0x61 && d[2] === 0x72 && d[3] === 0x21;

/** 3MF is a zip, but it is a mesh, not an archive to expand. */
const isArchivePath = (p: string) => /\.(zip|7z|rar)$/i.test(p);

class Collector {
  files: VirtualFile[] = [];
  byHash = new Map<string, string>();
  duplicates: { path: string; duplicateOf: string }[] = [];
  skipped: string[] = [];
  total = 0;
  constructor(readonly limits: IntakeLimits) {}

  add(path: string, data: Uint8Array, depth: number): void {
    if (JUNK.test(path)) {
      this.skipped.push(path);
      return;
    }
    if (isArchivePath(path) && (isZip(data) || is7z(data) || isRar(data))) {
      if (depth >= this.limits.maxArchiveDepth) throw new IntakeError("BAD_ARCHIVE", `Archives nested deeper than ${this.limits.maxArchiveDepth} levels`);
      const prefix = path.replace(/\.(zip|7z|rar)$/i, "");
      expandArchive(data, path, this.limits, (p, d) => this.add(`${prefix}/${p}`, d, depth + 1));
      return;
    }
    if (data.length > this.limits.maxFileBytes) throw new IntakeError("LIMIT_SIZE", `File exceeds ${fmt(this.limits.maxFileBytes)}: ${path}`);
    this.total += data.length;
    if (this.total > this.limits.maxTotalBytes) throw new IntakeError("LIMIT_SIZE", `Upload exceeds ${fmt(this.limits.maxTotalBytes)} in total`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    // identical bytes are kept (an unchanged gingiva model in every stage folder is legitimate);
    // adapters drop true duplicates when two identical files claim the same slot
    const prev = this.byHash.get(sha256);
    if (prev) this.duplicates.push({ path, duplicateOf: prev });
    else this.byHash.set(sha256, path);
    this.files.push({ path, size: data.length, data, sha256 });
    if (this.files.length > this.limits.maxFiles) throw new IntakeError("LIMIT_FILES", `Upload contains more than ${this.limits.maxFiles} files`);
  }

  result(): IntakeResult {
    if (this.files.length === 0) throw new IntakeError("EMPTY", "The upload contains no usable files");
    this.files.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
    return { files: this.files, duplicates: this.duplicates, skipped: this.skipped };
  }
}

function fmt(bytes: number): string {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`;
}

function expandArchive(data: Uint8Array, name: string, limits: IntakeLimits, emit: (path: string, data: Uint8Array) => void): void {
  if (isZip(data)) {
    let declaredTotal = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(data, {
        filter: (f) => {
          safePath(f.name); // throws on traversal
          if (f.name.endsWith("/")) return false;
          if (f.originalSize > limits.maxFileBytes) throw new IntakeError("LIMIT_SIZE", `Archive entry exceeds ${fmt(limits.maxFileBytes)}: ${f.name}`);
          if (f.size > 0 && f.originalSize / f.size > limits.maxCompressionRatio && f.originalSize > 1 << 20)
            throw new IntakeError("ZIP_BOMB", `Archive entry has a suspicious compression ratio (${Math.round(f.originalSize / f.size)}:1): ${f.name}`);
          declaredTotal += f.originalSize;
          if (declaredTotal > limits.maxTotalBytes) throw new IntakeError("ZIP_BOMB", `Archive inflates beyond ${fmt(limits.maxTotalBytes)}`);
          return true;
        },
      });
    } catch (e) {
      if (e instanceof IntakeError) throw e;
      throw new IntakeError("BAD_ARCHIVE", `Could not read archive ${name}: ${(e as Error).message}`);
    }
    for (const [p, d] of Object.entries(entries)) emit(safePath(p), d);
    return;
  }
  // .7z / .rar via the 7-Zip CLI when installed on the worker
  const exe = ["7zz", "7z", "7za"].find((c) => spawnSync(c, ["i"], { stdio: "ignore" }).status === 0);
  if (!exe) throw new IntakeError("UNSUPPORTED_ARCHIVE", `${basename(name)}: .7z/.rar archives need 7-Zip on the processing worker; please upload a .zip instead`);
  const dir = mkdtempSync(join(tmpdir(), "dentosim-7z-"));
  try {
    const list = spawnSync(exe, ["l", "-slt", "-si" + basename(name)], { input: data, maxBuffer: 64 << 20 });
    const listing = list.stdout?.toString() ?? "";
    let declared = 0;
    for (const m of listing.matchAll(/^Path = (.*)$/gm)) safePath(m[1]);
    for (const m of listing.matchAll(/^Size = (\d+)$/gm)) declared += +m[1];
    if (declared > limits.maxTotalBytes) throw new IntakeError("ZIP_BOMB", `Archive inflates beyond ${fmt(limits.maxTotalBytes)}`);
    const archivePath = join(dir, "in" + name.slice(name.lastIndexOf(".")));
    writeFileSync(archivePath, data);
    const r = spawnSync(exe, ["x", "-y", "-snl-", `-o${join(dir, "out")}`, archivePath], { stdio: "ignore", timeout: 120_000 });
    if (r.status !== 0) throw new IntakeError("BAD_ARCHIVE", `Could not extract ${basename(name)}`);
    walk(join(dir, "out"), (abs, rel) => emit(safePath(rel), new Uint8Array(readFileSync(abs))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walk(root: string, visit: (abs: string, rel: string) => void): void {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isSymbolicLink()) continue; // never follow links out of the upload
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) visit(abs, relative(root, abs).split(sep).join("/"));
    }
  }
}

/** Read an export from a path on disk: a directory, an archive, or a single mesh file. */
export function readExportPath(input: string, limits: IntakeLimits = DEFAULT_LIMITS): IntakeResult {
  const c = new Collector(limits);
  const st = statSync(input);
  if (st.isDirectory()) walk(input, (abs, rel) => c.add(safePath(rel), new Uint8Array(readFileSync(abs)), 0));
  else {
    const data = new Uint8Array(readFileSync(input));
    // a single uploaded archive is the export itself: expand without a folder prefix
    if (isArchivePath(input) && (isZip(data) || is7z(data) || isRar(data))) expandArchive(data, basename(input), limits, (p, d) => c.add(p, d, 1));
    else c.add(safePath(basename(input)), data, 0);
  }
  return c.result();
}

/** Read several loose files (browser multi-select / folder drop) given as path → bytes. */
export function readExportFiles(entries: { path: string; data: Uint8Array }[], limits: IntakeLimits = DEFAULT_LIMITS): IntakeResult {
  const c = new Collector(limits);
  for (const e of entries) c.add(safePath(e.path), e.data, 0);
  return c.result();
}

