/**
 * Object storage behind one interface:
 *  - "s3": any S3-compatible store (AWS S3 under a BAA, MinIO, R2 …) with
 *    pre-signed multipart uploads and short-lived pre-signed GETs;
 *  - "local": filesystem driver for development/tests. Its signed URLs point at
 *    the app's /api/storage routes and carry an HMAC + expiry.
 *
 * Every key is tenant-scoped: orgs/<orgId>/…  (see tenantKey / assertTenantKey).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectsCommand,
  GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";
import { hmac, randomToken, safeEqual } from "./crypto.js";
import { badRequest, forbidden } from "./errors.js";

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface Storage {
  readonly driver: "local" | "s3";
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  download(key: string, dest: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  signedGetUrl(key: string, ttlS?: number, downloadName?: string): Promise<string>;
  createMultipart(key: string): Promise<string>;
  signedPartUrl(key: string, uploadId: string, partNumber: number, ttlS?: number): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

// ───────────────────────── keys ─────────────────────────

const SAFE_SEGMENT = /^[A-Za-z0-9._\- ()+,@&=]+$/;

export function tenantKey(orgId: string, ...parts: string[]): string {
  return ["orgs", orgId, ...parts].join("/");
}

export function revisionPrefix(orgId: string, caseId: string, revisionId: string): string {
  return tenantKey(orgId, "cases", caseId, "revisions", revisionId);
}

/** Upload keys keep the user's relative path but are sanitised segment by segment. */
export function uploadObjectKey(prefix: string, index: number, relPath: string): string {
  const segs = relPath.split("/").filter(Boolean).map((s) => (SAFE_SEGMENT.test(s) && s !== ".." && s !== "." ? s : s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_")));
  return `${prefix}/upload/${String(index).padStart(5, "0")}/${segs.join("/")}`;
}

export function assertTenantKey(orgId: string, key: string): void {
  if (!key.startsWith(`orgs/${orgId}/`) || key.includes("..")) throw forbidden("Storage key outside tenant");
}

// ───────────────────────── local driver ─────────────────────────

class LocalStorage implements Storage {
  readonly driver = "local" as const;
  constructor(private readonly root: string, private readonly baseUrl: string) {}

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw forbidden("invalid key");
    return p;
  }
  private mpDir(uploadId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw badRequest("invalid upload id");
    return join(resolve(this.root), ".multipart", uploadId);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async download(key: string, dest: string): Promise<void> {
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(createReadStream(this.path(key)), createWriteStream(dest));
  }
  async delete(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => rm(this.path(k), { force: true })));
  }
  async deletePrefix(prefix: string): Promise<number> {
    const items = await this.list(prefix);
    await rm(this.path(prefix), { recursive: true, force: true });
    return items.length;
  }
  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const base = this.path(prefix);
    const out: { key: string; size: number }[] = [];
    const walk = async (dir: string) => {
      let ents;
      try {
        ents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push({ key: p.slice(resolve(this.root).length + 1).split(sep).join("/"), size: (await stat(p)).size });
      }
    };
    await walk(base);
    return out;
  }
  private sign(params: Record<string, string>, ttlS: number): string {
    const exp = String(Math.floor(Date.now() / 1000) + ttlS);
    const q = new URLSearchParams({ ...params, exp });
    q.set("sig", hmac(q.toString(), "local-storage"));
    return q.toString();
  }
  async signedGetUrl(key: string, ttlS = config().SIGNED_URL_TTL, downloadName?: string): Promise<string> {
    return `${this.baseUrl}/api/storage/object?${this.sign({ op: "get", key, ...(downloadName ? { dl: downloadName } : {}) }, ttlS)}`;
  }
  async createMultipart(): Promise<string> {
    const id = randomToken(18);
    await mkdir(this.mpDir(id), { recursive: true });
    return id;
  }
  async signedPartUrl(key: string, uploadId: string, partNumber: number, ttlS = 3600): Promise<string> {
    return `${this.baseUrl}/api/storage/part?${this.sign({ op: "part", key, uploadId, part: String(partNumber) }, ttlS)}`;
  }
  /** Called by the /api/storage/part route after signature verification. */
  async writePart(uploadId: string, partNumber: number, body: ReadableStream<Uint8Array> | Uint8Array): Promise<string> {
    const dir = this.mpDir(uploadId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${partNumber}.tmp`);
    const hash = createHash("md5");
    const src = body instanceof Uint8Array ? Readable.from([body]) : Readable.fromWeb(body as never);
    src.on("data", (c: Buffer) => hash.update(c));
    await pipeline(src, createWriteStream(tmp));
    await rename(tmp, join(dir, String(partNumber)));
    return `"${hash.digest("hex")}"`;
  }
  async completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    const dir = this.mpDir(uploadId);
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const out = createWriteStream(p);
    for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const file = join(dir, String(part.partNumber));
      const data = await readFile(file);
      const etag = `"${createHash("md5").update(data).digest("hex")}"`;
      if (etag !== part.etag) {
        out.destroy();
        throw badRequest(`Part ${part.partNumber} checksum mismatch`);
      }
      if (!out.write(data)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    await rm(dir, { recursive: true, force: true });
  }
  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    await rm(this.mpDir(uploadId), { recursive: true, force: true });
  }
}

/** Verify a local-driver signed URL query; returns its params. */
export function verifyLocalSignature(search: URLSearchParams, op: "get" | "part"): Record<string, string> {
  const sig = search.get("sig") ?? "";
  const q = new URLSearchParams(search);
  q.delete("sig");
  if (!safeEqual(sig, hmac(q.toString(), "local-storage"))) throw forbidden("Invalid signature");
  if (q.get("op") !== op) throw forbidden("Wrong operation");
  if (Number(q.get("exp")) < Date.now() / 1000) throw forbidden("Link expired");
  return Object.fromEntries(q.entries());
}

// ───────────────────────── S3 driver ─────────────────────────

class S3Storage implements Storage {
  readonly driver = "s3" as const;
  private readonly s3: S3Client;
  constructor(private readonly bucket: string) {
    const c = config();
    this.s3 = new S3Client({
      region: c.S3_REGION,
      ...(c.S3_ENDPOINT ? { endpoint: c.S3_ENDPOINT } : {}),
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      ...(c.S3_ACCESS_KEY_ID ? { credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY ?? "" } } : {}),
    });
  }
  async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string): Promise<Uint8Array> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return new Uint8Array(await r.Body!.transformToByteArray());
  }
  async download(key: string, dest: string): Promise<void> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(r.Body as Readable, createWriteStream(dest));
  }
  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000)
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
  }
  async deletePrefix(prefix: string): Promise<number> {
    const items = await this.list(prefix);
    await this.delete(items.map((i) => i.key));
    return items.length;
  }
  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async signedGetUrl(key: string, ttlS = config().SIGNED_URL_TTL, downloadName?: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, "")}"` } : {}) }),
      { expiresIn: ttlS },
    );
  }
  async createMultipart(key: string): Promise<string> {
    const r = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ServerSideEncryption: "AES256" }));
    return r.UploadId!;
  }
  async signedPartUrl(key: string, uploadId: string, partNumber: number, ttlS = 3600): Promise<string> {
    return getSignedUrl(this.s3, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: ttlS });
  }
  async completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }
  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }
}

let instance: Storage | undefined;

export function storage(): Storage {
  if (!instance) {
    const c = config();
    if (c.STORAGE_DRIVER === "s3") {
      if (!c.S3_BUCKET) throw new Error("S3_BUCKET is required for STORAGE_DRIVER=s3");
      instance = new S3Storage(c.S3_BUCKET);
    } else instance = new LocalStorage(resolve(c.STORAGE_LOCAL_DIR), c.APP_URL);
  }
  return instance;
}

export function localStorageDriver(): LocalStorage {
  const s = storage();
  if (!(s instanceof LocalStorage)) throw forbidden("local storage routes are disabled");
  return s;
}

export function resetStorage(): void {
  instance = undefined;
}

/** Upload a directory tree under a key prefix. */
export async function putDirectory(dir: string, prefix: string, contentType: (rel: string) => string | undefined = guessType): Promise<{ key: string; bytes: number }[]> {
  const out: { key: string; bytes: number }[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else {
        const data = new Uint8Array(await readFile(abs));
        await storage().put(`${prefix}/${r}`, data, contentType(r));
        out.push({ key: `${prefix}/${r}`, bytes: data.length });
      }
    }
  };
  await walk(dir, "");
  return out;
}

export function guessType(p: string): string | undefined {
  if (p.endsWith(".json")) return "application/json";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".tsm2")) return "application/octet-stream";
  return undefined;
}
