// electron-builder afterSign hook — notarytool submission (PLAN §10.7).
//
// Skips gracefully when:
//   - the build is unsigned (identity null / no CSC discovered), or
//   - APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are unset
//     (dev machines and the unsigned --dir smoke test).
// When creds are present on a signed build it submits via
// @electron/notarize's notarytool path and staples.
//
// env:
//   APPLE_ID                    Apple ID email for notarytool
//   APPLE_APP_SPECIFIC_PASSWORD app-specific password for that Apple ID
//   APPLE_TEAM_ID               10-char team ID
//   APPLE_KEYCHAIN_PROFILE      notarytool keychain profile name — when set,
//                               `xcrun notarytool submit` + stapler are used
//                               directly and the three env creds are optional
// Alternatively CSC_LINK/CSC_KEY_PASSWORD drive signing itself; the skip
// check below only cares whether signing actually happened.

import { execFileSync } from 'node:child_process';

export default async function notarize(context) {
  const { appOutDir, packager } = context;
  const productName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${productName}.app`;

  const macOptions = packager.platformSpecificBuildOptions;
  if (macOptions && macOptions.identity === null) {
    console.log('[notarize] unsigned build (identity: null) — skipping notarization');
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, APPLE_KEYCHAIN_PROFILE } =
    process.env;

  if (APPLE_KEYCHAIN_PROFILE) {
    // Stored-profile path: `xcrun notarytool store-credentials` once, then
    // every signed build notarizes and staples with no env vars.
    console.log(`[notarize] submitting ${productName}.app via profile ${APPLE_KEYCHAIN_PROFILE}`);
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', appPath, `${appPath}.zip`], {
      stdio: 'inherit',
    });
    try {
      execFileSync(
        'xcrun',
        [
          'notarytool',
          'submit',
          `${appPath}.zip`,
          '--keychain-profile',
          APPLE_KEYCHAIN_PROFILE,
          '--wait',
        ],
        { stdio: 'inherit' },
      );
      execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
      console.log('[notarize] notarization complete and stapled');
    } finally {
      execFileSync('rm', ['-f', `${appPath}.zip`]);
    }
    return;
  }

  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      '[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — skipping notarization',
    );
    return;
  }

  const { notarize } = await import('@electron/notarize');
  console.log(`[notarize] submitting ${productName}.app to notarytool`);
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] notarization complete and stapled');
}
