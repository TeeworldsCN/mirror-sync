export const validate = (filename: string, data: Buffer): { valid: boolean; reason?: string } => {
  try {
    const hash = filename.match(/(?:(?:_([0-9a-z]{8}))|(?:_([0-9a-z]{64})))\.map/);
    if (hash[2]) {
      const actual = new Bun.CryptoHasher("sha256").update(data.buffer).digest('hex');
      const expected = hash[2];
      if (actual == expected) {
        return { valid: true };
      } else {
        return { valid: false, reason: `hash mismatch, expected ${expected}, actual ${actual}` };
      }
    }
    if (hash[1]) {
      const actual = Bun.hash.crc32(data).toString(16).padStart(8, '0');
      const expected = hash[1];
      if (actual == expected) {
        return { valid: true };
      } else {
        return { valid: false, reason: `crc mismatch, expected ${expected}, actual ${actual}` };
      }
    }
    return { valid: false, reason: 'hash not found in filename' };
  } catch (e) {
    return { valid: false, reason: `unknown error: ${e.message || e}` };
  }
};
