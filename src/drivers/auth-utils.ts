import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensures that the credentials authentication directory exists with strict 0700 permissions.
 *
 * INVARIANT: Baileys and WWebJS session credentials contain sensitive cryptographic ratchets
 * and noise protocol keys; directory must be restricted to owner-only read/write/execute (0700)
 * to prevent unauthorized session extraction in shared container environments.
 */
export function ensureSecureAuthDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  try {
    const stats = statSync(dirPath);
    // On POSIX environments, verify and enforce 0700 (rwx------)
    const currentMode = stats.mode & 0o777;
    if (currentMode !== 0o700) {
      chmodSync(dirPath, 0o700);
    }
  } catch {
    // INVARIANT: File systems without POSIX mode support (e.g. FAT/NTFS mounts) may fail chmod;
    // gracefully continue if directory creation succeeded.
  }
}

/**
 * Safely wipes all stale authentication credentials and browser profile files inside
 * `dirPath` while preserving the directory root itself.
 *
 * INVARIANT: Deleting `dirPath` directly fails with EBUSY when mounted as a Docker volume
 * bind mount (`/data/auth/baileys` or `/data/auth/wwebjs`). Only child entries must be
 * removed, followed by re-enforcing 0700 permissions on the root directory.
 */
export function purgeAuthDirectory(dirPath: string): void {
  if (existsSync(dirPath)) {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      rmSync(join(dirPath, entry), { recursive: true, force: true });
    }
  }

  ensureSecureAuthDirectory(dirPath);
}
