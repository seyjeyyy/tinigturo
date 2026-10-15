// Builds the signed Android app (Trusted Web Activity) for Tinig Turo.
//
//   npm run android:build
//
// Outputs:
//   public/download/tinigturo.apk         signed APK, served by the website for sideloading
//   android/app-release-bundle.aab        signed bundle for the Google Play Console
//   public/.well-known/assetlinks.json    Digital Asset Links proving the app and site belong together
//
// The signing key lives OUTSIDE the repository. By default it is read from
// %USERPROFILE%/.tinigturo-signing/ (tinigturo-upload.jks + signing-info.txt).
// Override with TINIGTURO_KEYSTORE, TINIGTURO_KEY_ALIAS and TINIGTURO_KEYSTORE_PASSWORD.
//
// Requirements: JDK 17 (JAVA_HOME) and the Android SDK (ANDROID_HOME, or Android
// Studio's default location) with build-tools installed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const androidDir = join(root, 'android');
const isWindows = process.platform === 'win32';

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ---- signing key (never inside the repo) ---------------------------------
const signingDir = join(homedir(), '.tinigturo-signing');
const keystore = process.env.TINIGTURO_KEYSTORE ?? join(signingDir, 'tinigturo-upload.jks');
const alias = process.env.TINIGTURO_KEY_ALIAS ?? 'tinigturo';
let password = process.env.TINIGTURO_KEYSTORE_PASSWORD;
if (!password && existsSync(join(signingDir, 'signing-info.txt'))) {
  password = readFileSync(join(signingDir, 'signing-info.txt'), 'utf8').match(/^store password: (.+)$/m)?.[1]?.trim();
}
if (!existsSync(keystore)) fail(`Signing keystore not found at ${keystore}`);
if (!password) fail('Keystore password not found (set TINIGTURO_KEYSTORE_PASSWORD).');
if (keystore.startsWith(root)) fail('The keystore must not be inside the repository.');

// ---- tools -----------------------------------------------------------------
const javaHome = process.env.JAVA_HOME;
if (!javaHome) fail('JAVA_HOME is not set (JDK 17 required).');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const buildToolsRoot = join(sdk, 'build-tools');
if (!existsSync(buildToolsRoot)) fail(`Android SDK build-tools not found under ${sdk}`);
const buildTools = join(
  buildToolsRoot,
  readdirSync(buildToolsRoot).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop(),
);
const zipalign = join(buildTools, isWindows ? 'zipalign.exe' : 'zipalign');
const apksigner = join(buildTools, isWindows ? 'apksigner.bat' : 'apksigner');
const java = (tool) => join(javaHome, 'bin', isWindows ? `${tool}.exe` : tool);
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', env, shell: isWindows && cmd.endsWith('.bat'), ...opts });

// ---- 1. Gradle release build -----------------------------------------------
writeFileSync(join(androidDir, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`);
console.log('▶ Building release APK and bundle with Gradle…');
run(join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew'), ['assembleRelease', 'bundleRelease', '--no-daemon', '--console=plain'], { cwd: androidDir, shell: isWindows });

const outputs = join(androidDir, 'app', 'build', 'outputs');
const unsignedApk = join(outputs, 'apk', 'release', 'app-release-unsigned.apk');
const unsignedAab = join(outputs, 'bundle', 'release', 'app-release.aab');
if (!existsSync(unsignedApk) || !existsSync(unsignedAab)) fail('Gradle did not produce the release outputs.');

// ---- 2. Align and sign the APK -----------------------------------------------
console.log('▶ Aligning and signing the APK…');
const alignedApk = join(outputs, 'apk', 'release', 'app-release-aligned.apk');
run(zipalign, ['-v', '-f', '-p', '4', unsignedApk, alignedApk], { stdio: 'ignore' });
mkdirSync(join(root, 'public', 'download'), { recursive: true });
const signedApk = join(root, 'public', 'download', 'tinigturo.apk');
run(apksigner, ['sign', '--v4-signing-enabled', 'false', '--ks', keystore, '--ks-key-alias', alias, '--ks-pass', `pass:${password}`, '--key-pass', `pass:${password}`, '--out', signedApk, alignedApk]);
run(apksigner, ['verify', '--min-sdk-version', '24', signedApk]);

// ---- 3. Sign the bundle for Google Play -------------------------------------
console.log('▶ Signing the Play Store bundle…');
const signedAab = join(androidDir, 'app-release-bundle.aab');
copyFileSync(unsignedAab, signedAab);
run(java('jarsigner'), ['-keystore', keystore, '-storepass', password, '-keypass', password, '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', signedAab, alias], { stdio: 'ignore' });

// ---- 4. Digital Asset Links ---------------------------------------------------
const listing = execFileSync(java('keytool'), ['-list', '-v', '-keystore', keystore, '-alias', alias, '-storepass', password], { encoding: 'utf8' });
const fingerprint = listing.match(/SHA256:\s*([0-9A-F:]{95})/)?.[1];
if (!fingerprint) fail('Could not read the signing certificate fingerprint.');
const twa = JSON.parse(readFileSync(join(androidDir, 'twa-manifest.json'), 'utf8'));
const fingerprints = [fingerprint, ...(process.env.PLAY_APP_SIGNING_SHA256 ? [process.env.PLAY_APP_SIGNING_SHA256] : [])];
mkdirSync(join(root, 'public', '.well-known'), { recursive: true });
writeFileSync(
  join(root, 'public', '.well-known', 'assetlinks.json'),
  JSON.stringify([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: twa.packageId, sha256_cert_fingerprints: fingerprints },
  }], null, 2) + '\n',
);

const mb = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`;
console.log(`\n✓ APK:    public/download/tinigturo.apk (${mb(signedApk)})`);
console.log(`✓ Bundle: android/app-release-bundle.aab (${mb(signedAab)})`);
console.log(`✓ Asset links for ${twa.packageId}: ${fingerprint}`);
console.log('\nNext: npm run build and deploy, so the site serves the APK and assetlinks.json.');
