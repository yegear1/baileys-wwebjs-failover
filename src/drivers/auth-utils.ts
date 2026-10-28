import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";

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
