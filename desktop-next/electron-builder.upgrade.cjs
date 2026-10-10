const base = require('./electron-builder.cjs');
if (process.env.SOUL_NEXT_TEST_BUILD !== '1' || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(process.env.SOUL_NEXT_UPDATE_URL ?? '')) throw new Error('Isolated loopback upgrade fixture required');
module.exports = {
  ...base,
  directories: { ...base.directories, output: 'release-upgrade' },
  extraMetadata: { version: process.env.SOUL_NEXT_UPGRADE_VERSION },
  publish: { provider: 'generic', url: process.env.SOUL_NEXT_UPDATE_URL, channel: 'candidate' },
};
