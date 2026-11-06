const { makeDmg } = require('./scripts/make-dmg.cjs');
const { join } = require('node:path');

module.exports = {
  packagerConfig: {
    name: 'Space',
    executableName: 'Space',
    appBundleId: 'io.github.kai1303.space',
    appCategoryType: 'public.app-category.productivity',
    icon: join(__dirname, 'assets', 'space-icon.icns'),
    asar: true,
    extendInfo: {
      NSCameraUsageDescription: 'Space uses your camera when you enable video in a direct message call.',
      NSMicrophoneUsageDescription: 'Space uses your microphone for direct message calls.',
    },
    // Package only the runtime, never tests, dependencies, or local tooling.
    ignore: [/^\/(?!src(?:\/|$)|assets(?:\/|$)|package\.json$|desktop\.config\.json$)/],
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
  hooks: {
    postMake: async (_config, results) => {
      for (const result of results) {
        if (result.platform === 'darwin') result.artifacts.push(await makeDmg(result.arch));
      }
      return results;
    },
  },
};
