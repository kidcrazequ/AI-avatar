import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
if (process.platform === 'darwin') {
  const value = Buffer.from(process.env.SOUL_NEXT_APPLE_API_KEY_BASE64 ?? '', 'base64').toString('utf8');
  if (!value.includes('-----BEGIN PRIVATE KEY-----') || !value.includes('-----END PRIVATE KEY-----')) throw new Error('Configure the notarization API key in release environment secrets');
  const file = path.join(process.env.RUNNER_TEMP, `soul-notarization-${crypto.randomUUID()}.p8`);
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.appendFileSync(process.env.GITHUB_ENV, `APPLE_API_KEY=${file}\n`);
}
