const { makeDmg } = require('./scripts/make-dmg.cjs');
const { join } = require('node:path');

module.exports = {
  packagerConfig: {
    name: 'Space',
    executableName: 'Space',
    appBundleId: 'io.github.kai1303.space',
    appCategoryType: 'public.app-category.productivity',
    icon: [join(__dirname, 'Space.icon'), join(__dirname, 'assets', 'space-icon.icns')],
    asar: true,
    download: { checksums: require('electron/checksums.json') },
    protocols: [{ name: 'Open Space Desktop', schemes: ['space-desktop'] }],
    extraResource: [join(__dirname, 'dist', 'runner')],
    ...(process.env.SPACE_SIGN_IDENTITY && { osxSign: { identity: process.env.SPACE_SIGN_IDENTITY } }),
    ...(process.env.SPACE_NOTARY_PROFILE && { osxNotarize: { keychainProfile: process.env.SPACE_NOTARY_PROFILE } }),
    extendInfo: {
      NSCameraUsageDescription: 'Space uses your camera for video clips and calls.',
      NSMicrophoneUsageDescription: 'Space uses your microphone for calls, audio and video clips, and dictation.',
    },
    // Package only the runtime, never tests, dependencies, or local tooling.
    ignore: [/^\/(?!src(?:\/|$)|assets(?:\/|$)|package\.json$|desktop\.config\.json$)/],
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
  hooks: {
    generateAssets: () => Promise.all([
      require('./scripts/build-runner.cjs').buildRunner(),
      require('./scripts/build-browser-style.cjs').buildBrowserStyle(),
    ]),
    postMake: async (_config, results) => {
      for (const result of results) {
        if (result.platform === 'darwin') result.artifacts.push(await makeDmg(result.arch));
      }
      return results;
    },
  },
};
