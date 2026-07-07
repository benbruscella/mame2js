// Browser-side cartridge library. Console carts the visitor drops are
// remembered in THEIR OWN browser (IndexedDB `mamekit-carts`) so the console
// shelf survives reloads — reintroduced for consoles by explicit user
// approval (2026-07-07). Nothing ever touches the server (gotchas §24 still
// holds for fetching); Eject deletes; the menu's legacy-storage purge must
// never target this DB.
//
// When IndexedDB is unavailable (private browsing, quota, disabled) the store
// degrades to a per-session in-memory Map with the same interface and
// `persistent: false` so the room can show a banner.

const DB_NAME = 'mamekit-carts';
const DB_VERSION = 1;
const STORE = 'carts';

export interface CartRecord {
  /** `${console}:${crc32 of the whole file, hex8}` */
  id: string;
  console: string;
  /** original filename (display only) */
  name: string;
  bytes: ArrayBuffer;
  size: number;
  addedAt: number;
  /** parsed header summary (identification re-runs against a fresh catalog each visit) */
  ines: { mapper: number; prgSize: number; chrSize: number; mirroring: string; battery: boolean };
  prgCrc: string;
  chrCrc: string | null;
}

export interface CartStore {
  /** false => in-memory fallback; carts last only this session */
  persistent: boolean;
  list(consoleName: string): Promise<CartRecord[]>;
  get(id: string): Promise<CartRecord | null>;
  add(rec: CartRecord): Promise<{ existed: boolean }>;
  remove(id: string): Promise<void>;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class IdbCartStore implements CartStore {
  persistent = true;
  private db: IDBDatabase;
  constructor(db: IDBDatabase) { this.db = db; }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }
  async list(consoleName: string): Promise<CartRecord[]> {
    const all = await req(this.store('readonly').index('console').getAll(consoleName));
    return (all as CartRecord[]).sort((a, b) => a.addedAt - b.addedAt);
  }
  async get(id: string): Promise<CartRecord | null> {
    return ((await req(this.store('readonly').get(id))) as CartRecord | undefined) ?? null;
  }
  async add(rec: CartRecord): Promise<{ existed: boolean }> {
    if (await this.get(rec.id)) return { existed: true };
    await req(this.store('readwrite').put(rec));
    return { existed: false };
  }
  async remove(id: string): Promise<void> {
    await req(this.store('readwrite').delete(id));
  }
}

class MemoryCartStore implements CartStore {
  persistent = false;
  private map = new Map<string, CartRecord>();
  async list(consoleName: string): Promise<CartRecord[]> {
    return [...this.map.values()].filter(r => r.console === consoleName).sort((a, b) => a.addedAt - b.addedAt);
  }
  async get(id: string): Promise<CartRecord | null> { return this.map.get(id) ?? null; }
  async add(rec: CartRecord): Promise<{ existed: boolean }> {
    if (this.map.has(rec.id)) return { existed: true };
    this.map.set(rec.id, rec);
    return { existed: false };
  }
  async remove(id: string): Promise<void> { this.map.delete(id); }
}

let storePromise: Promise<CartStore> | undefined;

export function openCartStore(): Promise<CartStore> {
  storePromise ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('console', 'console');
        }
      };
      const db = await req(open as IDBRequest<IDBDatabase>);
      // some browsers only fail on first use — probe with a harmless read
      await req(db.transaction(STORE, 'readonly').objectStore(STORE).count());
      return new IdbCartStore(db);
    } catch {
      return new MemoryCartStore();
    }
  })();
  return storePromise;
}
