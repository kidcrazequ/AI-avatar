const base = require('./electron-builder.cjs');
if (process.env.SOUL_NEXT_PRODUCTION !== '1') throw new Error('Select the production channel before building');
module.exports = {
  ...base,
  forceCodeSigning: true,
  mac: { ...base.mac, identity: undefined, hardenedRuntime: true, notarize: true },
  win: { ...base.win, publisherName: process.env.SOUL_NEXT_PUBLISHER },
  nsis: { ...base.nsis, runAfterFinish: true },
};
