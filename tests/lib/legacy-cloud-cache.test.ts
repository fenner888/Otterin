const mockFiles = new Map<string, boolean>();

jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents' },
  File: class {
    readonly uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join('/');
    }
    get exists() {
      return mockFiles.get(this.uri) === true;
    }
    delete() {
      if (!this.exists) throw new Error(`missing ${this.uri}`);
      mockFiles.delete(this.uri);
    }
  },
}));

import { deleteLegacyCloudCache } from '../../src/lib/legacyCloudCache';

const SQLITE_DIR = 'file:///documents/SQLite';

describe('deleteLegacyCloudCache', () => {
  beforeEach(() => mockFiles.clear());

  it('removes the legacy Cloud cache database and its WAL sidecars', async () => {
    for (const name of ['devinx_cache.db', 'devinx_cache.db-wal', 'devinx_cache.db-shm', 'other.db']) {
      mockFiles.set(`${SQLITE_DIR}/${name}`, true);
    }

    await deleteLegacyCloudCache();

    expect([...mockFiles.keys()]).toEqual([`${SQLITE_DIR}/other.db`]);
  });

  it('is a no-op when no legacy cache exists', async () => {
    await expect(deleteLegacyCloudCache()).resolves.toBeUndefined();
    await expect(deleteLegacyCloudCache()).resolves.toBeUndefined();
  });
});
