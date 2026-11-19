const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productFilename;
  const resourcesDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources');

  const assetsCarSrc = path.join(__dirname, '..', 'assets', 'Assets.car');
  if (fs.existsSync(assetsCarSrc)) {
    fs.copyFileSync(assetsCarSrc, path.join(resourcesDir, 'Assets.car'));
  }
};
