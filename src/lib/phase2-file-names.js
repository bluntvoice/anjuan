// Keep Windows aliases out of newly exposed case paths and uploads.
const RESERVED = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]) *$/iu;

export function caseDirectoryKey(value) {
  return process.platform === 'win32' && typeof value === 'string' ? value.toUpperCase() : value;
}

export function validCasePathSegment(name) {
  return typeof name === 'string' && Boolean(name) &&
    !/[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) && !/[ .]$/u.test(name) &&
    !RESERVED.test(name.split('.')[0]);
}

export function validCaseRelativePath(value) {
  return typeof value === 'string' && value.split('/').every(validCasePathSegment);
}
