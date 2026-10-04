/**
 * @ucad/code-intelligence — the Code Intelligence plane.
 *
 * C-1/C-2: `BasicIntelligenceProvider` deliberately does not define `callers`,
 * `callees`, `trace` or `impact`. Absence is the honest signal — an empty array
 * would be misread as "there are none".
 * C-3/C-5: `IntelligenceManager.query()` reports `unsupported` without throwing
 * and keeps `error` a distinct state.
 * NFR-11: no result is ever reported as fresh, because there is no index.
 */

export {
  BasicIntelligenceProvider,
  BASIC_PROVIDER_ID,
  BASIC_STATUS_REASON,
} from './basic-provider';
export type { BasicIntelligenceProviderOptions } from './basic-provider';

export { IntelligenceManager } from './manager';
export type { IntelligenceManagerOptions, IntelligenceQueryOutcome } from './manager';

export {
  BASIC_IGNORED_DIRECTORIES,
  BASIC_MAX_FILE_BYTES,
  BASIC_TEXT_EXTENSIONS,
  extensionOf,
  isTextExtension,
  looksBinary,
  readTextFile,
  walkFiles,
  walkTextFiles,
} from './fs-scan';
export type { ScannedFile, WalkOptions } from './fs-scan';
