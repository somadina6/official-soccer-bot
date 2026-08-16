/** Stable internal error codes for the per-event image flow (plan section 15). */
export type ImageFlowErrorCode =
  | 'IMAGE_GENERATION_TIMEOUT'
  | 'IMAGE_GENERATION_RATE_LIMITED'
  | 'IMAGE_GENERATION_MODERATION_BLOCKED'
  | 'IMAGE_GENERATION_EMPTY_RESULT'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_COMPOSITE_FAILED'
  | 'IMAGE_TOO_LARGE'
  | 'STORAGE_UPLOAD_FAILED'
  | 'STORAGE_DOWNLOAD_FAILED'
  | 'X_MEDIA_UPLOAD_FAILED'
  | 'FALLBACK_NOT_FOUND';

export class ImageFlowError extends Error {
  readonly code: ImageFlowErrorCode;

  constructor(code: ImageFlowErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ImageFlowError';
    this.code = code;
  }
}

/** Sanitized diagnostic text safe to persist in last_error_message. */
export function sanitizedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Never persist credentials or base64 payloads; keep it short and textual.
  return message.replace(/[A-Za-z0-9+/=]{200,}/g, '[base64 omitted]').slice(0, 500);
}

export function errorCodeOf(error: unknown): string {
  return error instanceof ImageFlowError ? error.code : 'UNEXPECTED_ERROR';
}
