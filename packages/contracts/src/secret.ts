/** §4.10 Secret contract. Write-only towards the Renderer (NFR-01). */

export interface SecretRef {
  providerId: string;
  key: string;
}

export interface SecretDescriptor {
  configured: boolean;
  /** e.g. "...7F2A" — never the plaintext (S-3). */
  keyHint: string;
  updatedAt?: string;
}

export interface SecretStore {
  /** One-way write. Callable from the Renderer; never readable back. */
  set(ref: SecretRef, value: string, signal?: AbortSignal): Promise<void>;
  /** Main / Agent Host only. There is no IPC read channel (NFR-01). */
  get(ref: SecretRef): Promise<string | null>;
  delete(ref: SecretRef): Promise<void>;
  exists(ref: SecretRef): Promise<boolean>;
  /** Metadata for the Renderer; never contains plaintext. */
  describe(ref: SecretRef): Promise<SecretDescriptor>;
}

export function secretKey(ref: SecretRef): string {
  return `${ref.providerId}/${ref.key}`;
}

/** keyHint: last 4 characters of the stored ciphertext, uppercased. */
export function keyHint(value: string): string {
  if (!value) return '----';
  return `...${value.slice(-4).toUpperCase()}`;
}
