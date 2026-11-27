const CARD_NUMBER = /(?:[0-9]{4,6}[\s*Xx•-]{3,18}[0-9]{4}|(?<![0-9])(?:[0-9][ -]?){13,19}(?![0-9]))/;

export function hasSensitiveIdentifier(input: string) {
  return CARD_NUMBER.test(input.normalize('NFKC'));
}
