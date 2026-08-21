// Human invitation codes. Thirty-two unambiguous symbols produce exactly
// twenty bits of code space while avoiding I/1 and O/0 transcription errors.
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 4;

export function inviteCode(bytes) {
  if (!bytes || bytes.length < INVITE_CODE_LENGTH) {
    throw new Error('Four random bytes are required for an invitation code.');
  }
  return Array.from(bytes).slice(0, INVITE_CODE_LENGTH)
    .map((byte) => INVITE_ALPHABET[byte & 31]).join('');
}

/** New codes are case-insensitive. Preserve legacy Firestore IDs exactly. */
export function normalizeInviteCode(value) {
  const code = String(value || '').trim();
  return code.length === INVITE_CODE_LENGTH ? code.toUpperCase() : code;
}
