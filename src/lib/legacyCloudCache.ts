/**
 * Removes the SQLite read cache left on disk by pre-Local-only builds, which
 * held the Cloud sessions board. expo-sqlite kept it in Documents/SQLite with
 * WAL sidecar files.
 */

import { File, Paths } from 'expo-file-system';

const LEGACY_CACHE_FILES = ['devinx_cache.db', 'devinx_cache.db-wal', 'devinx_cache.db-shm'];

export async function deleteLegacyCloudCache(): Promise<void> {
  for (const name of LEGACY_CACHE_FILES) {
    const file = new File(Paths.document, 'SQLite', name);
    if (file.exists) file.delete();
  }
}
