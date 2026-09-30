import { loadMesh, meshFormatOf, MeshParseError, type LoadedFile } from "../io/loaders.js";
import type { VirtualFile } from "../io/input.js";

/** Shared, cached access to the files of one export during detection and import. */
export class ImportContext {
  readonly files: VirtualFile[];
  private readonly byPath = new Map<string, VirtualFile>();
  private readonly cache = new Map<string, LoadedFile | MeshParseError>();

  constructor(files: VirtualFile[]) {
    this.files = files;
    for (const f of files) this.byPath.set(f.path, f);
  }

  file(path: string): VirtualFile | undefined {
    return this.byPath.get(path);
  }

  /** Files with a supported mesh extension. */
  get meshFiles(): VirtualFile[] {
    return this.files.filter((f) => meshFormatOf(f.path));
  }

  get otherFiles(): VirtualFile[] {
    return this.files.filter((f) => !meshFormatOf(f.path));
  }

  /** Parse a mesh file (cached). Throws MeshParseError with a human-readable message. */
  mesh(path: string): LoadedFile {
    const hit = this.cache.get(path);
    if (hit instanceof MeshParseError) throw hit;
    if (hit) return hit;
    const f = this.byPath.get(path);
    if (!f) throw new MeshParseError(`File not found in export: ${path}`);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    try {
      const loaded = loadMesh(path, f.data, (uri) => this.byPath.get(dir + uri)?.data);
      this.cache.set(path, loaded);
      return loaded;
    } catch (e) {
      const err = e instanceof MeshParseError ? e : new MeshParseError(`${path}: ${(e as Error).message}`);
      if (!err.message.includes(path)) err.message = `${path}: ${err.message}`;
      this.cache.set(path, err);
      throw err;
    }
  }

  /** Parse every mesh file; returns the failures (the validation step fails the job on any). */
  parseAll(): { path: string; error: string }[] {
    const failures: { path: string; error: string }[] = [];
    for (const f of this.meshFiles) {
      try {
        this.mesh(f.path);
      } catch (e) {
        failures.push({ path: f.path, error: (e as Error).message });
      }
    }
    return failures;
  }
}
