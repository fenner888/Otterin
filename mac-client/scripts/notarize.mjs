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
// Alternatively CSC_LINK/CSC_KEY_PASSWORD drive signing itself; the skip
// check below only cares whether signing actually happened.

export default async function notarize(context) {
  const { appOutDir, packager } = context;
  const productName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${productName}.app`;

  const macOptions = packager.platformSpecificBuildOptions;
  if (macOptions && macOptions.identity === null) {
    console.log('[notarize] unsigned build (identity: null) — skipping notarization');
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
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
