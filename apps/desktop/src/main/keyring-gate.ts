/**
 * The start-up gate on the OS key store.
 *
 * ## Why the question is asked before the vault is built
 *
 * The database key is written to the OS key store and nowhere else (NFR-15), so
 * a key store that cannot encrypt means UCAD has nowhere correct to put the key.
 * Refusing to start is therefore the whole answer — but *how* the refusal is
 * said matters, because the reason the store is unusable is usually fixable and
 * almost never obvious from the exception.
 *
 * Left to itself, the failure surfaces inside `SafeStorageSecretStore.commit()`
 * as `Error while encrypting the text provided to safeStorage.encryptString.
 * Encryption is not available.` — a stack trace that names the symptom and
 * hides the cause. The real causes are platform-specific: on Linux,
 * Chromium picks a key store backend by looking at the declared desktop
 * environment, so a session with a working Secret Service but no
 * `XDG_CURRENT_DESKTOP` gets *no* backend at all and is indistinguishable from
 * a machine with no key store; on Windows the same text means DPAPI refused
 * this token (a service account, or an impersonated one); on macOS it is a
 * locked or unauthorised keychain. Each of those has a different remedy, and a
 * user reading the stack trace learns none of them.
 *
 * ## What this module deliberately does not do
 *
 * It does not import Electron. The caller hands in the two-method slice of
 * `safeStorage` it actually needs, which keeps the gate testable and keeps
 * `app-container.ts` the only file below the Electron lifecycle layer that
 * touches the OS key store.
 *
 * It does not degrade. There is no "start unencrypted", no prompt to continue
 * anyway, and no silent retry with a different backend — a build that cannot
 * protect the key stops, and says why in one line.
 */

/** The slice of Electron's `safeStorage` the gate asks about. */
type KeyringStorage = {
  isEncryptionAvailable(): boolean;
};

/**
 * Why the OS key store cannot protect the database key, with the remedy for
 * the platform it was found on.
 */
export class KeyringUnavailableError extends Error {
  readonly platform: NodeJS.Platform;
  readonly remedy: string;

  constructor(platform: NodeJS.Platform, remedy: string) {
    super(`the OS key store cannot encrypt, so UCAD has nowhere to keep the database key: ${remedy}`);
    this.name = 'KeyringUnavailableError';
    this.platform = platform;
    this.remedy = remedy;
  }
}

/** The remedy text for a platform, or the generic text for an unknown one. */
function remedyFor(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'linux':
      return (
        'no Secret Service answered over the D-Bus session bus, or no key store backend was ' +
        'selected at all. Start UCAD from a desktop session with gnome-keyring or KWallet ' +
        'running, and declare the desktop (XDG_CURRENT_DESKTOP, e.g. "GNOME" or "KDE") — ' +
        'Chromium chooses its key store backend from that, and an undeclared desktop gets ' +
        'no backend even when the keyring is healthy.'
      );
    case 'win32':
      return (
        'Windows data protection (DPAPI) refused to encrypt for this token. UCAD must run ' +
        'as the interactive user it was launched for — not as a service account, and not ' +
        'under an impersonated token.'
      );
    case 'darwin':
      return (
        'the macOS keychain is locked, or UCAD is not authorised to use it. Unlock the ' +
        'keychain and answer the access prompt, then start UCAD again.'
      );
    default:
      return `no key store backend is available on platform "${platform}".`;
  }
}

/**
 * Throw {@link KeyringUnavailableError} unless `storage` can encrypt.
 *
 * `platform` is a parameter rather than `process.platform` in the body so the
 * three platform texts can be asserted without three operating systems.
 */
export function assertKeyringUsable(
  storage: KeyringStorage,
  platform: NodeJS.Platform = process.platform,
): void {
  if (storage.isEncryptionAvailable()) return;
  throw new KeyringUnavailableError(platform, remedyFor(platform));
}
