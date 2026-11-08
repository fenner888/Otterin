// electron-builder afterPack hook — Electron fuse flips (PLAN §8).
//
// Flips the security fuses on the packaged Electron binary BEFORE signing
// (afterSign/notarize runs later, so the signature covers the fused binary):
//   RunAsNode=off                               — `ELECTRON_RUN_AS_NODE` must
//                                                 not turn the app into a
//                                                 Node REPL (key-theft path)
//   EnableNodeOptionsEnvironmentVariable=off    — NODE_OPTIONS injection off
//   EnableNodeCliInspectArguments=off           --inspect flags off
//   EnableCookieEncryption=on                   — cookie store encrypted
//
// asar-integrity is deliberately NOT flipped: it cannot function unsigned.
//
// Wire-up: electron-builder.yml needs `afterPack: scripts/afterPack.mjs`
// alongside the existing afterSign entry (that file is owned by the
// packaging slice; this hook is idempotent and safe to wire now).

import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { join } from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }
  const productName = context.packager.appInfo.productFilename;
  const electronBinaryPath = join(
    context.appOutDir,
    `${productName}.app`,
    'Contents',
    'MacOS',
    productName,
  );
  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
  console.log(`[afterPack] fuses flipped on ${productName} (RunAsNode/NodeOptions/CliInspect off, CookieEncryption on)`);
}
