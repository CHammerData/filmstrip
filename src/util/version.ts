import fs from 'fs';
import path from 'path';

/**
 * Build/runtime version info, surfaced by /api/health and the startup log.
 *
 * `version` is the single source of truth from package.json (bumped in lock-step with the release
 * tag). `commit` is baked at Docker build time via the FILMSTRIP_COMMIT build-arg -> env; it's
 * undefined in local/dev runs. Reading package.json with fs (rather than importing it) keeps
 * resolveJsonModule off and works both under ts-node (src/util) and compiled (dist/util) — the
 * file lives two levels up in both layouts.
 */
function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = process.env.FILMSTRIP_VERSION || readPackageVersion();
export const COMMIT = process.env.FILMSTRIP_COMMIT || undefined;

/** The version info object embedded in /api/health responses. */
export interface VersionInfo {
  version: string;
  commit?: string;
}

export function versionInfo(): VersionInfo {
  return COMMIT ? { version: VERSION, commit: COMMIT } : { version: VERSION };
}
