module.exports = {
  appId: 'com.soul.desktop.next.validation',
  productName: 'Soul Next',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'dist-electron/**/*', '!dist-electron/*-test.*', 'package.json'],
  extraResources: [{ from: 'build/resources', to: 'soul-resources' }],
  asarUnpack: [
    'node_modules/better-sqlite3/**/*',
    'node_modules/nodejieba/**/*',
    'node_modules/@vscode/ripgrep/**/*',
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
