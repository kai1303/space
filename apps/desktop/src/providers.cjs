const {join} = require('node:path');

// The packaged main process has no workspace dependencies. Forge copies this catalog into resources.
const catalog = process.versions.electron && require('electron').app?.isPackaged
  ? require(join(process.resourcesPath, 'runner', 'local-providers.json'))
  : require('../../../packages/contracts/local-providers.json');

module.exports = new Map(Object.entries(catalog).map(([id, entry]) => [id, entry.command]));
