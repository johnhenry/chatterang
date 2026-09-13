/**
 * Types for `patch-native.mjs`, which is plain ESM so `npm run sync` can run
 * it with no build step. Declared here rather than converting the script to
 * TypeScript, because a sync hook that needs compiling before it can run is a
 * sync hook that will be skipped.
 *
 * THIS FILE IS THE CONTRACT, AND IT IS HAND-WRITTEN, so an export added to the
 * `.mjs` is invisible to TypeScript until it is added here too. `tsc` reads
 * this, not the script. The failure is loud — "has no exported member" — but
 * only for code that imports the new name, so it surfaces in the test that
 * uses it rather than at the script.
 */
export declare const ANDROID_MANIFEST: string;
export declare const ANDROID_DATA_EXTRACTION_RULES: string;
export declare const ANDROID_BACKUP_RULES: string;
export declare const IOS_APP_DELEGATE: string;
export declare const IOS_INFO_PLIST: string;
export declare const DATA_EXTRACTION_RULES_XML: string;
export declare const BACKUP_RULES_XML: string;
/**
 * The iOS camera usage string (#128), shown in the OS permission dialog.
 *
 * Exported so `tests/privacy-copy.test.ts` can pin the exact sentence — it is
 * a product decision displayed to users and read by App Review, not a config
 * value.
 */
export declare const CAMERA_USAGE_DESCRIPTION: string;
/** Throws if the Capacitor template has no `allowBackup` attribute to patch. */
export declare function patchAndroidManifest(xml: string): string;
/** Throws if the Capacitor template has no `<manifest>` element to patch. */
export declare function patchAndroidCamera(xml: string): string;
/** Throws if the Capacitor template's Info.plist has no `<dict>` to patch. */
export declare function patchInfoPlist(plist: string): string;
/** Throws if the Capacitor template's AppDelegate methods are not found. */
export declare function patchAppDelegate(swift: string): string;

/**
 * What `main` applies, as data — so a test can assert a transform is WIRED and
 * not merely exported. A pure transform nobody calls is the failure this repo
 * keeps finding.
 */
export declare const NATIVE_PATCHES: readonly {
  readonly platform: 'android' | 'ios';
  readonly file: string;
  readonly transform: (contents: string) => string;
}[];
