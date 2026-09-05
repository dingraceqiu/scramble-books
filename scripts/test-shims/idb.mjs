/**
 * 测试专用内存版 IndexedDB shim（覆盖 src/lib/db.ts 用到的 idb API 子集）。
 * 仅用于 Node 环境的 persistence 集成测试；通过 loader hook 把裸模块 'idb' 指到这里。
 * 语义保真点：版本化 + upgrade(db, oldVersion) 只在升版时执行一次；keyPath 主键；
 * out-of-line key（kv store）；index(keyPath).getAllKeys(query)。
 */
const registry = new Map(); // name -> { version, db }

class Index {
  constructor(store, name, keyPath) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
  }
  #matches(record, query) {
    return query === undefined || record?.[this.keyPath] === query;
  }
  *#records(query) {
    for (const r of this.store.entries.values()) {
      if (this.#matches(r, query)) yield r;
    }
  }
  getAllKeys(query) {
    return [...this.#records(query)].map((r) => r[this.store.keyPath]);
  }
  getAll(query) {
    return [...this.#records(query)];
  }
}

class Store {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    // pk -> value（keyPath 主键从 value 取；out-of-line key 由调用方显式传入）
    this.entries = new Map();
    this.indexes = new Map();
  }
  createIndex(name, keyPath) {
    this.indexes.set(name, new Index(this, name, keyPath));
  }
  index(name) {
    const idx = this.indexes.get(name);
    if (!idx) throw new Error(`NotFoundError: index "${name}" on store "${this.name}"`);
    return idx;
  }
  #pk(value, key) {
    const pk = this.keyPath ? value?.[this.keyPath] : key;
    if (pk === undefined || pk === null) {
      throw new Error('DataError: record key is required');
    }
    return pk;
  }
  put(value, key) {
    let pk;
    try {
      pk = this.#pk(value, key);
    } catch (e) {
      return Promise.reject(e);
    }
    this.entries.set(pk, value);
    return Promise.resolve(pk);
  }
  get(key) {
    return Promise.resolve(this.entries.get(key));
  }
  delete(key) {
    this.entries.delete(key);
    return Promise.resolve();
  }
  getAll() {
    return Promise.resolve([...this.entries.values()]);
  }
  getAllKeys() {
    return Promise.resolve([...this.entries.keys()]);
  }
  clear() {
    this.entries.clear();
    return Promise.resolve();
  }
}

class MockDB {
  constructor(version) {
    this.version = version;
    this.stores = new Map();
  }
  createObjectStore(name, opts = {}) {
    const store = new Store(name, opts.keyPath);
    this.stores.set(name, store);
    return store;
  }
  #store(name) {
    const store = this.stores.get(name);
    if (!store) throw new Error(`NotFoundError: object store "${name}"`);
    return store;
  }
  transaction(storeNames /* eslint-disable-line @typescript-eslint/no-unused-vars */) {
    const self = this;
    return {
      objectStore(name) {
        return self.#store(name);
      },
      done: Promise.resolve(),
    };
  }
  get(store, key) {
    return this.#store(store).get(key);
  }
  getAll(store) {
    return this.#store(store).getAll();
  }
  put(store, value, key) {
    return this.#store(store).put(value, key);
  }
  delete(store, key) {
    return this.#store(store).delete(key);
  }
  getAllFromIndex(store, indexName, query) {
    return Promise.resolve(this.#store(store).index(indexName).getAll(query));
  }
  getAllKeysFromIndex(store, indexName, query) {
    return Promise.resolve(this.#store(store).index(indexName).getAllKeys(query));
  }
}

export function openDB(name, version, { upgrade } = {}) {
  let entry = registry.get(name);
  if (!entry) {
    entry = { version: 0, db: new MockDB(0) };
    registry.set(name, entry);
  }
  return new Promise((resolve, reject) => {
    if (version <= entry.version) {
      resolve(entry.db);
      return;
    }
    const oldVersion = entry.version;
    entry.version = version;
    entry.db.version = version;
    try {
      upgrade?.(entry.db, oldVersion, version);
    } catch (e) {
      reject(e);
      return;
    }
    resolve(entry.db);
  });
}

/** 测试隔离用：清空整个内存 registry */
export function __resetAllDatabases() {
  registry.clear();
}
