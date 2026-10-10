module.exports = {
  appId: 'com.soul.desktop.next.validation',
  productName: 'Soul Next',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'dist-electron/**/*', 'package.json'],
  extraResources: [{ from: 'build/resources', to: 'soul-resources' }],
  asarUnpack: [
    // Background threads use physical module paths, including transitive OCR/PDF deps.
    'node_modules/**/*',
    'dist-electron/knowledge-worker.cjs',
    'dist-electron/pdf-worker.cjs',
  ],
  npmRebuild: true,
  publish: process.env.SOUL_NEXT_UPDATE_URL ? { provider: 'generic', url: process.env.SOUL_NEXT_UPDATE_URL, channel: process.env.SOUL_NEXT_PRODUCTION === '1' ? 'latest' : 'candidate' } : null,
  generateUpdatesFilesForAllChannels: false,
  // Each architecture must be built on its own native host. No afterPack binary swaps.
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.productivity', icon: 'icon.icns', identity: null },
  dmg: { title: 'Soul Next', contents: [{ x: 130, y: 220 }, { x: 410, y: 220, type: 'link', path: '/Applications' }] },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'icon.ico', signAndEditExecutable: true },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: false,
    createDesktopShortcut: false,
    deleteAppDataOnUninstall: false,
  },
  artifactName: 'Soul-Next-${version}-${os}-${arch}.${ext}',
};
