const ALPHABET = "0123456789abcdef";
export const CODE_LENGTH = 12;

export function rollCode(rand: () => number): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const idx = Math.floor(rand() * ALPHABET.length);
    out += ALPHABET[idx];
  }
  return out;
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i += 1) {
    if (!ALPHABET.includes(code[i] ?? "")) return false;
  }
  return true;
}
