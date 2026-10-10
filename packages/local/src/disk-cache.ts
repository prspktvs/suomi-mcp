import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JsonCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

function defaultDirectory() {
  if (process.env.SUOMI_MCP_CACHE_DIR === "off") return undefined;
  if (process.env.SUOMI_MCP_CACHE_DIR) return process.env.SUOMI_MCP_CACHE_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "suomi-mcp");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "suomi-mcp");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "suomi-mcp");
}

/** Disk cache stores registry metadata and publisher schemas only; evidence rows are never passed here. */
export class LocalDiskCache implements JsonCache {
  private readonly directory = defaultDirectory();
  private readonly maximumBytes = 100 * 1024 * 1024;
  private writeQueue: Promise<void> = Promise.resolve();
  private filename(key: string) { return join(this.directory!, createHash("sha256").update(key).digest("hex") + ".json"); }
  async get<T>(key: string): Promise<T | undefined> {
    if (!this.directory) return undefined;
    try {
      const path = this.filename(key);
      const value = JSON.parse(await readFile(path, "utf8")) as T;
      const now = new Date();
      await utimes(path, now, now);
      return value;
    } catch { return undefined; }
  }
  async set<T>(key: string, value: T) {
    if (!this.directory) return;
    const operation = async () => {
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      const path = this.filename(key);
      const temporary = path + "." + process.pid + ".tmp";
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, path);
      await this.trim();
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    await this.writeQueue;
  }
  private async trim() {
    if (!this.directory) return;
    const files = await readdir(this.directory).catch(() => []);
    const isCacheFile = (file: string) => file.endsWith(".json") && file.length === 69 && [...file.slice(0, 64)].every((character) => (character >= "0" && character <= "9") || (character >= "a" && character <= "f"));
    const entries = await Promise.all(files.filter(isCacheFile).map(async (file) => {
      const path = join(this.directory!, file);
      const info = await stat(path).catch(() => undefined);
      return info ? { path, size: info.size, accessed: info.atimeMs } : undefined;
    }));
    const sorted = entries.filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => a.accessed - b.accessed);
    let total = sorted.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of sorted) {
      if (total <= this.maximumBytes) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
  }
}

export function createDisabledDiskCache(): JsonCache {
  return { async get() { return undefined; }, async set() {} };
}
