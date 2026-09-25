import fs from "node:fs/promises";
import path from "node:path";

/** Where uploaded files (field photos) live. Local disk now; S3 or R2 later behind the same interface. */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
}

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;

function checkKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error(`Unsafe storage key: ${key}`);
}

export class DiskStore implements FileStore {
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
}

export class MemoryStore implements FileStore {
  readonly files = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    checkKey(key);
    this.files.set(key, data);
  }

  async get(key: string): Promise<Buffer | undefined> {
    return this.files.get(key);
  }
}
