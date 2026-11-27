import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * One-time start-up clean-up: an earlier version kept uploads and extracted data under
 * `<dataDir>/import/` and swept them itself. That feature is gone, so nothing sweeps the folder
 * any more; this removes it. Only that one folder, only when it sits directly inside `dataDir`.
 * Never throws: a failure is logged once and the box starts anyway. Returns true when removed.
 */
export function removeLegacyImportDir(dataDir: string, warn: (msg: string) => void = console.warn): boolean {
  try {
    const root = resolve(dataDir);
    const target = join(root, 'import');
    if (dirname(target) !== root || target === root) return false;
    if (!existsSync(target)) return false;
    // never delete through a symbolic link or Windows junction: only a real folder is removed
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      warn('The old import folder is not a plain folder; left in place.');
      return false;
    }
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    warn(`Could not remove the old import folder: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
