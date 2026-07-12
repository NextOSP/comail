// Port of Superhuman's open-source command-score algorithm.
// https://github.com/superhuman/command-score (MIT License)
//
// Scores an abbreviation against a string: 1.0 for exact match, decaying
// through continuous-match bonuses (word beginnings, camelCase, punctuation)
// and gap penalties down to 0 for no match.

const SCORE_CONTINUE_MATCH = 1.0;
// A new match at the start of a word scores better than a new match elsewhere.
const SCORE_SPACE_WORD_JUMP = 0.9;
const SCORE_NON_SPACE_WORD_JUMP = 0.8;
// Any other match isn't ideal, but we include it for completeness.
const SCORE_CHARACTER_JUMP = 0.17;
// If the user transposed two letters, it should be significantly penalized.
const SCORE_TRANSPOSITION = 0.1;
// The goodness of a match should decay slightly with each missing character.
const PENALTY_SKIPPED = 0.999;
// The goodness of an exact-case match should be higher than a case-insensitive one.
const PENALTY_CASE_MISMATCH = 0.9999;
// If the word has more characters than the user typed, it should be penalized slightly.
const PENALTY_NOT_COMPLETE = 0.99;

const IS_GAP_REGEXP = /[\\/_+.#"@[({&]/;
const COUNT_GAPS_REGEXP = /[\\/_+.#"@[({&]/g;
const IS_SPACE_REGEXP = /[\s-]/;
const COUNT_SPACE_REGEXP = /[\s-]/g;

function commandScoreInner(
  string: string,
  abbreviation: string,
  lowerString: string,
  lowerAbbreviation: string,
  stringIndex: number,
  abbreviationIndex: number,
  memoizedResults: Record<string, number>,
): number {
  if (abbreviationIndex === abbreviation.length) {
    if (stringIndex === string.length) {
      return SCORE_CONTINUE_MATCH;
    }
    return PENALTY_NOT_COMPLETE;
  }

  const memoizeKey = `${stringIndex},${abbreviationIndex}`;
  if (memoizedResults[memoizeKey] !== undefined) {
    return memoizedResults[memoizeKey];
  }

  const abbreviationChar = lowerAbbreviation.charAt(abbreviationIndex);
  let index = lowerString.indexOf(abbreviationChar, stringIndex);
  let highScore = 0;

  let score: number;
  let transposedScore: number;
  let wordBreaks: RegExpMatchArray | null;
  let spaceBreaks: RegExpMatchArray | null;

  while (index >= 0) {
    score = commandScoreInner(
      string,
      abbreviation,
      lowerString,
      lowerAbbreviation,
      index + 1,
      abbreviationIndex + 1,
      memoizedResults,
    );
    if (score > highScore) {
      if (index === stringIndex) {
        score *= SCORE_CONTINUE_MATCH;
      } else if (IS_GAP_REGEXP.test(string.charAt(index - 1))) {
        score *= SCORE_NON_SPACE_WORD_JUMP;
        wordBreaks = string.slice(stringIndex, index - 1).match(COUNT_GAPS_REGEXP);
        if (wordBreaks && stringIndex > 0) {
          score *= Math.pow(PENALTY_SKIPPED, wordBreaks.length);
        }
      } else if (IS_SPACE_REGEXP.test(string.charAt(index - 1))) {
        score *= SCORE_SPACE_WORD_JUMP;
        spaceBreaks = string.slice(stringIndex, index - 1).match(COUNT_SPACE_REGEXP);
        if (spaceBreaks && stringIndex > 0) {
          score *= Math.pow(PENALTY_SKIPPED, spaceBreaks.length);
        }
      } else {
        score *= SCORE_CHARACTER_JUMP;
        if (stringIndex > 0) {
          score *= Math.pow(PENALTY_SKIPPED, index - stringIndex);
        }
      }

      if (string.charAt(index) !== abbreviation.charAt(abbreviationIndex)) {
        score *= PENALTY_CASE_MISMATCH;
      }
    }

    if (
      (score < SCORE_TRANSPOSITION &&
        lowerString.charAt(index - 1) === lowerAbbreviation.charAt(abbreviationIndex + 1)) ||
      (lowerAbbreviation.charAt(abbreviationIndex + 1) === lowerAbbreviation.charAt(abbreviationIndex) &&
        lowerString.charAt(index - 1) !== lowerAbbreviation.charAt(abbreviationIndex))
    ) {
      transposedScore = commandScoreInner(
        string,
        abbreviation,
        lowerString,
        lowerAbbreviation,
        index + 1,
        abbreviationIndex + 2,
        memoizedResults,
      );
      if (transposedScore * SCORE_TRANSPOSITION > score) {
        score = transposedScore * SCORE_TRANSPOSITION;
      }
    }

    if (score > highScore) {
      highScore = score;
    }

    index = lowerString.indexOf(abbreviationChar, index + 1);
  }

  memoizedResults[memoizeKey] = highScore;
  return highScore;
}

function formatInput(string: string): string {
  // convert all valid space characters to space so they match each other
  return string.toLowerCase().replace(COUNT_SPACE_REGEXP, " ");
}

export function commandScore(string: string, abbreviation: string): number {
  return commandScoreInner(
    string,
    abbreviation,
    formatInput(string),
    formatInput(abbreviation),
    0,
    0,
    {},
  );
}
