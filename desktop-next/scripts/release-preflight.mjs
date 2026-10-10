import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function validateProduction(env = process.env, platform = process.platform) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Production requires matching stable package and lock versions');
  if (env.SOUL_NEXT_PRODUCTION !== '1' || env.SOUL_NEXT_TEST_BUILD === '1') throw new Error('Production build must explicitly select the production channel');
  const url = new URL(env.SOUL_NEXT_UPDATE_URL ?? '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.hostname.endsWith('.invalid') || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('A public HTTPS update feed is required');
  if (platform === 'darwin') {
    if (!env.CSC_LINK || !env.CSC_KEY_PASSWORD || !env.APPLE_API_KEY || !env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) throw new Error('Mac signing and notarization credentials are required');
  } else if (platform === 'win32') {
    if (!env.CSC_LINK || !env.CSC_KEY_PASSWORD || !env.SOUL_NEXT_PUBLISHER) throw new Error('Windows certificate and publisher are required');
  } else throw new Error('Production build requires native macOS or Windows');
  return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { validateProduction(); console.log('Production inputs validated; native signing still must succeed'); }
