import fs from "node:fs/promises";
import path from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";

// The AWS SDK is large, so it is only loaded when S3 storage is configured.
type S3Sdk = typeof import("@aws-sdk/client-s3");

/** Where uploaded files (business photos) live: local disk, or S3-compatible storage such as Cloudflare R2. */
export interface FileStore {
  readonly name: string;
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  /** Removing a file that isn't there is not an error. */
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

function checkKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error(`Unsafe storage key: ${key}`);
}

export class DiskStore implements FileStore {
  readonly name = "disk";

  constructor(private readonly dir: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    checkKey(key);
    const file = path.join(this.dir, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }

  async get(key: string): Promise<Buffer | undefined> {
    checkKey(key);
    try {
      return await fs.readFile(path.join(this.dir, key));
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    await fs.rm(path.join(this.dir, key), { force: true });
  }
}

export class MemoryStore implements FileStore {
  readonly name = "memory";
  readonly files = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    checkKey(key);
    this.files.set(key, data);
  }

  async get(key: string): Promise<Buffer | undefined> {
    return this.files.get(key);
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

export interface S3StoreOptions {
  bucket: string;
  /** "auto" for Cloudflare R2. */
  region: string;
  /** Needed for R2 and other S3-compatible services, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint?: string;
  /** Without keys, the AWS SDK's usual credential chain is used. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Folder inside the bucket, e.g. "findzim". */
  prefix?: string;
  forcePathStyle?: boolean;
}

/** Amazon S3, Cloudflare R2 or any S3-compatible store. Keep the bucket private: photos are served through the ops API. */
export class S3Store implements FileStore {
  readonly name = "s3";

  private constructor(
    private readonly sdk: S3Sdk,
    private readonly client: Pick<S3Client, "send">,
    private readonly bucket: string,
    private readonly prefix = "",
  ) {}

  /** Pass `client` to use a stand-in (tests). */
  static async create(opts: S3StoreOptions, client?: Pick<S3Client, "send">): Promise<S3Store> {
    const sdk = await import("@aws-sdk/client-s3");
    const s3 =
      client ??
      new sdk.S3Client({
        region: opts.region,
        endpoint: opts.endpoint,
        forcePathStyle: opts.forcePathStyle,
        credentials:
          opts.accessKeyId && opts.secretAccessKey ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } : undefined,
      });
    return new S3Store(sdk, s3, opts.bucket, opts.prefix);
  }

  private objectKey(key: string): string {
    checkKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    await this.client.send(new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: data, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const res = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : undefined;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}
