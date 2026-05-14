/**
 * Plugin loader.
 *
 * At host boot, scans `src/plugins/*` for modules. Each plugin must export
 * a default async function that registers transformers/handlers via the
 * `extension-points` registries.
 *
 *   // src/plugins/example/index.ts
 *   import { registerInboundTransformer } from '../../extension-points.js';
 *   export default async function init() {
 *     registerInboundTransformer(async (event) => event);
 *   }
 *
 * Loader is intentionally simple: no dependency graph, no hot reload,
 * no version checks. Plugins are install-time code, not runtime config.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { log } from './log.js';

const PLUGINS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins');

export async function loadPlugins(): Promise<void> {
  if (!fs.existsSync(PLUGINS_DIR)) {
    log.debug('No plugins directory, skipping plugin load', { path: PLUGINS_DIR });
    return;
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const name of pluginDirs) {
    const indexFile = path.join(PLUGINS_DIR, name, 'index.js');
    if (!fs.existsSync(indexFile)) {
      log.warn('Plugin missing index.js, skipping', { plugin: name });
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(indexFile).href)) as { default?: () => Promise<void> };
      if (typeof mod.default !== 'function') {
        log.warn('Plugin has no default export function, skipping', { plugin: name });
        continue;
      }
      await mod.default();
      log.info('Plugin loaded', { plugin: name });
    } catch (err) {
      log.error('Plugin load failed', { plugin: name, err });
    }
  }
}
