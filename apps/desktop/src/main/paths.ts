import * as path from 'node:path';
import { app } from 'electron';

/**
 * Every on-disk location UCAD owns.
 *
 * The DB holds conversation transcripts and source-code slices, so it lives
 * under Electron's `userData` (encrypted at rest via the SecretStore key) and
 * never inside the user's workspace.
 */
export interface AppPaths {
  userData: string;
  dbPath: string;
  blobDir: string;
  logDir: string;
  cacheDir: string;
  /** staged installers for the update flow */
  downloadDir: string;
}

export function resolvePaths(userDataOverride?: string): AppPaths {
  const userData = userDataOverride ?? app.getPath('userData');
  return {
    userData,
    dbPath: path.join(userData, 'ucad.db'),
    blobDir: path.join(userData, 'blobs'),
    logDir: path.join(userData, 'logs'),
    cacheDir: path.join(userData, 'cache'),
    downloadDir: path.join(userData, 'downloads'),
  };
}
