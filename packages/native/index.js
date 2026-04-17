const { existsSync } = require('fs');
const { join } = require('path');

const localPath = join(__dirname, 'quink-native.win32-x64-msvc.node');

let nativeBinding = null;
if (existsSync(localPath)) {
  nativeBinding = require(localPath);
}

module.exports = {
  onSelection: nativeBinding?.onSelection || (() => {}),
  grabSelection: nativeBinding?.grabSelection || (() => {}),
};
