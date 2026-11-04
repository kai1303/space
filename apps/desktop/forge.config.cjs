const { makeDmg } = require('./scripts/make-dmg.cjs');

module.exports = {
  packagerConfig: {
    name: 'Space',
    executableName: 'Space',
    appBundleId: 'io.github.kai1303.space',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    // Package only the runtime, never tests, dependencies, or local tooling.
    ignore: [/^\/(?!src(?:\/|$)|package\.json$|desktop\.config\.json$)/],
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
