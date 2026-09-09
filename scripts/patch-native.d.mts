/**
 * Types for `patch-native.mjs`, which is plain ESM so `npm run sync` can run
 * it with no build step. Declared here rather than converting the script to
 * TypeScript, because a sync hook that needs compiling before it can run is a
 * sync hook that will be skipped.
 */
export declare const ANDROID_MANIFEST: string;
export declare const ANDROID_DATA_EXTRACTION_RULES: string;
export declare const ANDROID_BACKUP_RULES: string;
export declare const IOS_APP_DELEGATE: string;
export declare const DATA_EXTRACTION_RULES_XML: string;
export declare const BACKUP_RULES_XML: string;
/** Throws if the Capacitor template has no `allowBackup` attribute to patch. */
export declare function patchAndroidManifest(xml: string): string;
/** Throws if the Capacitor template's AppDelegate methods are not found. */
export declare function patchAppDelegate(swift: string): string;
