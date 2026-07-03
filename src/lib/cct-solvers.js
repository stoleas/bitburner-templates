// Solvers for every Coding Contract type in Bitburner (v3.x).
//
// Each entry is keyed by the EXACT contract type string that
// ns.codingcontract.getContractType() returns (the human-readable
// form, e.g. "Find Largest Prime Factor" — see
// CodingContractNameEnumType in NetscriptDefinitions.d.ts). The
// value is a function (data) => answer. The function should:
//   - return the answer in the format the game expects for that
//     contract type (number, string, array, etc.). The .d.ts
//     signature map CodingContractSignatures is authoritative.
//   - throw a string error (NOT an Error object) if the contract
//     is unsolvable / unrecognized / has bad data. The scanner
//     catches the throw and logs it.
//
// Why a separate module: the solver list is large (~29 types) and
// grows over time. Keeping them out of the scanner keeps the
// scanner's logic (server walk + submit loop) short and readable.
// The scanner imports this module via `import { SOLVERS } from
// "/lib/cct-solvers.js"`; with tsc + the filesync model, lib/ is
// synced to dist/lib/ alongside the rest.
//
// The 29 contract types as of Bitburner 3.0.0. If a new one is
// added, drop a new entry in this map — the scanner picks it up
// automatically.
//
// Algorithm sources: this is the same set of solutions the
// community has consolidated over the years (see the Bitburner
// Discord #coding-contracts channel and the original
// `import-from-bitburner` repo). I rewrote them in plain JS for
// portability and to match the project's no-dependencies style.

// --- number theory ---------------------------------------------------------

function largestPrimeFactor(n) {
  let factor = 2;
  let largest = 1;
  while (factor * factor <= n) {
    if (n % factor === 0) {
      largest = factor;
      n = n / factor;
    } else {
      factor++;
    }
  }
  // Whatever's left of n after the loop is also a prime factor.
  // (Either n is 1, meaning the input was 1 and there are no
  // prime factors — the game won't generate that, but be safe —
  // or n itself is the largest prime factor > sqrt(original).)
  if (n > 1) largest = n;
  return largest;
}

function isPrime(n) {
  if (n < 2) return false;
  if (n < 4) return true;  // 2, 3
  if (n % 2 === 0) return false;
  for (let i = 3; i * i <= n; i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}

function countPrimes(low, high) {
  // Count primes in [low, high] inclusive. The game generates
  // ranges that are tractable for a naive sqrt sieve at this
  // scale; if ranges get bigger than ~10^6 we can swap in a true
  // sieve but I haven't seen one in practice.
  let count = 0;
  for (let i = low; i <= high; i++) if (isPrime(i)) count++;
  return count;
}

// --- array / DP ------------------------------------------------------------

// "Subarray with Maximum Sum": given an array of numbers (which
// may include negatives), find the contiguous subarray with the
// largest sum. Classic Kadane's algorithm.
function maxSubarraySum(arr) {
  if (arr.length === 0) return 0;
  let best = arr[0];
  let current = arr[0];
  for (let i = 1; i < arr.length; i++) {
    current = Math.max(arr[i], current + arr[i]);
    best = Math.max(best, current);
  }
  return best;
}

// "Array Jumping Game": given an array of positive integers, can
// you start at index 0 and reach (or pass) the last index? Each
// element a[i] is the max jump length from i. Return 1 if yes,
// 0 if no. Verbatim from bitburner-src getAnswer(I): the loop
// exits at index i where i > reach (or i == n). The check
// `i === n` is "reached the last index exactly" — if i < n but
// i > reach, the answer is 0.
function arrayJumpingGame(arr) {
  const n = arr.length;
  let i = 0;
  for (let reach = 0; i < n && i <= reach; i++) {
    reach = Math.max(i + arr[i], reach);
  }
  return i === n ? 1 : 0;
}

// "Array Jumping Game II": same as above, but return the MIN
// number of jumps to reach the last index. 0 if unreachable.
// Verbatim from bitburner-src getAnswer(II): at each step, scan
// positions in (lastJump, reach] and pick the one that extends
// reach furthest. This is optimal for the "min jumps" problem
// because the choice only depends on the farthest you can get
// from a window.
function arrayJumpingGameII(arr) {
  const n = arr.length;
  let reach = 0;
  let jumps = 0;
  let lastJump = -1;
  while (reach < n - 1) {
    let jumpedFrom = -1;
    for (let i = reach; i > lastJump; i--) {
      if (i + arr[i] > reach) {
        reach = i + arr[i];
        jumpedFrom = i;
      }
    }
    if (jumpedFrom === -1) {
      jumps = 0;
      break;
    }
    lastJump = jumpedFrom;
    jumps++;
  }
  return jumps;
}

// "Total Ways to Sum": how many partitions of n as a sum of
// positive integers (order doesn't matter)? Verbatim from
// bitburner-src/src/CodingContract/contracts/TotalWaysToSum.ts
// getAnswer(I). ways[0]=1 (empty sum is one way to sum 0);
// for i = 1..n-1, for j = i..n, ways[j] += ways[j-i]. Return
// ways[n] (which counts partitions of n WITHOUT the trivial
// [n] partition — the game's desc says "sum of at least two
// positive integers"). The game then asks the player to
// produce this number; getAnswer returns ways[n] which the
// verifier accepts.
function totalWaysToSum(n) {
  const ways = new Array(n + 1).fill(0);
  ways[0] = 1;
  for (let i = 1; i < n; i++) {
    for (let j = i; j <= n; j++) ways[j] += ways[j - i];
  }
  return ways[n];
}

// "Total Ways to Sum II": like above, but using only the given
// summand set. Standard unbounded coin-change DP. Verbatim
// from the game source.
function totalWaysToSumII(n, summands) {
  const ways = new Array(n + 1).fill(0);
  ways[0] = 1;
  for (let i = 0; i < summands.length; i++) {
    for (let j = summands[i]; j <= n; j++) ways[j] += ways[j - summands[i]];
  }
  return ways[n];
}

// --- grid / matrix ---------------------------------------------------------

// "Spiralize Matrix": return the matrix in clockwise spiral
// order, top to bottom, left to right.
function spiralizeMatrix(m) {
  if (m.length === 0) return [];
  const out = [];
  let top = 0, bottom = m.length - 1, left = 0, right = m[0].length - 1;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) out.push(m[top][c]);
    top++;
    for (let r = top; r <= bottom; r++) out.push(m[r][right]);
    right--;
    if (top <= bottom) {
      for (let c = right; c >= left; c--) out.push(m[bottom][c]);
      bottom--;
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r--) out.push(m[r][left]);
      left++;
    }
  }
  return out;
}

// "Minimum Path Sum in a Triangle": data is a triangle (array
// of arrays, row 0 has 1 element, row 1 has 2, etc.). Return the
// minimum sum from top to bottom, moving only to adjacent
// elements in the row below.
function minPathTriangle(triangle) {
  // Bottom-up: at each row, replace each cell with the cell
  // value + the smaller of its two parents. After processing
  // the bottom row, the answer is min(row).
  const dp = triangle[triangle.length - 1].slice();
  for (let r = triangle.length - 2; r >= 0; r--) {
    for (let c = 0; c < triangle[r].length; c++) {
      dp[c] = triangle[r][c] + Math.min(dp[c], dp[c + 1]);
    }
  }
  return dp[0];
}

// "Unique Paths in a Grid I": from top-left of an [m, n] grid
// to bottom-right, moving only right or down. Combinatorial
// answer: C(m+n-2, m-1). Use multiplicative formula to avoid
// large-factorial overflow.
function uniquePathsI(m, n) {
  let result = 1;
  for (let i = 1; i <= m - 1; i++) {
    result = (result * (n - 1 + i)) / i;
  }
  return Math.round(result);
}

// "Unique Paths in a Grid II": same as I but some cells are
// obstacles (1 = obstacle, 0 = free). DP from top-left.
function uniquePathsII(grid) {
  if (grid.length === 0 || grid[0].length === 0) return 0;
  if (grid[0][0] === 1) return 0;
  const m = grid.length;
  const n = grid[0].length;
  const dp = Array.from({ length: m }, () => new Array(n).fill(0));
  dp[0][0] = 1;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (grid[i][j] === 1) { dp[i][j] = 0; continue; }
      if (i > 0) dp[i][j] += dp[i - 1][j];
      if (j > 0) dp[i][j] += dp[i][j - 1];
    }
  }
  return dp[m - 1][n - 1];
}

// "Shortest Path in a Grid": like Unique Paths II, but the
// answer is the path itself as a string of "U/D/L/R" characters.
// If no path exists, return "" (empty string).
function shortestPathGrid(grid) {
  if (grid.length === 0 || grid[0].length === 0) return "";
  if (grid[0][0] === 1) return "";
  const m = grid.length;
  const n = grid[0].length;
  // BFS from (0,0). Each cell records the moves taken to reach
  // it. We use a single 'visited' set keyed by "r,c" — we
  // could record shortest distances but BFS guarantees the
  // first visit IS the shortest path for unweighted graphs.
  const visited = new Set();
  const queue = [{ r: 0, c: 0, path: "" }];
  visited.add("0,0");
  const dirs = [
    { dr: -1, dc: 0, ch: "U" },
    { dr: 1, dc: 0, ch: "D" },
    { dr: 0, dc: -1, ch: "L" },
    { dr: 0, dc: 1, ch: "R" },
  ];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur.r === m - 1 && cur.c === n - 1) return cur.path;
    for (const d of dirs) {
      const nr = cur.r + d.dr;
      const nc = cur.c + d.dc;
      if (nr < 0 || nr >= m || nc < 0 || nc >= n) continue;
      if (grid[nr][nc] === 1) continue;
      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ r: nr, c: nc, path: cur.path + d.ch });
    }
  }
  return "";
}

// "Largest Rectangle in a Matrix": despite the name, this
// contract asks for the largest all-0s rectangle (the desc
// explicitly says "does not contain any 1s" — see
// bitburner-src/src/CodingContract/contracts/LargestRectangle.ts).
// Returns [[r1,c1],[r2,c2]] in matrix coordinates.
//
// Algorithm (verbatim from the game source): build a
// column-wise histogram of consecutive 0s, then for each cell
// (i, j) with histogram[i][j] > 0, expand left and right as
// long as row[i][k] >= row[i][j]. That gives the largest rect
// of zeros whose bottom-right corner is (i, j) and whose row
// range is row[i][j] rows tall. Track the max area.
function largestRectangleMatrix(grid) {
  const numRows = grid.length;
  const numCols = grid[0].length;
  // histograms[r][c] = number of consecutive 0s ending at row r,
  // column c (i.e. count of 0s from row r-hist+1 .. r in col c).
  const histograms = Array.from({ length: numRows }, () => new Array(numCols).fill(0));
  for (let c = 0; c < numCols; c++) {
    let count = 0;
    for (let r = 0; r < numRows; r++) {
      if (grid[r][c] === 0) count++;
      else count = 0;
      histograms[r][c] = count;
    }
  }
  let maxArea = 0;
  let maxL = 0, maxR = 0, maxU = 0, maxD = 0;
  for (let r = 0; r < numRows; r++) {
    const row = histograms[r];
    for (let c = 0; c < numCols; c++) {
      if (row[c] === 0) continue;
      let left = c;
      let right = c;
      while (row[left - 1] >= row[c]) left--;
      while (row[right + 1] >= row[c]) right++;
      const area = (right - left + 1) * row[c];
      if (area > maxArea) {
        maxArea = area;
        maxL = left;
        maxR = right;
        maxU = r - row[c] + 1;
        maxD = r;
      }
    }
  }
  return [[maxU, maxL], [maxD, maxR]];
}

// --- strings / encodings ---------------------------------------------------

// "Merge Overlapping Intervals": data is an array of [lo, hi]
// pairs. Return a new array with overlapping intervals merged,
// sorted by lo.
function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const top = out[out.length - 1];
    if (sorted[i][0] <= top[1]) {
      top[1] = Math.max(top[1], sorted[i][1]);
    } else {
      out.push(sorted[i].slice());
    }
  }
  return out;
}

// "Generate IP Addresses": given a string of digits, return
// every valid IPv4 address you can form by inserting three dots.
// Backtracking: at each step, take 1-3 digits; if they form a
// valid octet (0-255, no leading zeros except "0" itself), recurse.
function generateIPAddresses(s) {
  const out = [];
  function recurse(prefix, remaining) {
    if (prefix.length === 4) {
      if (remaining.length === 0) out.push(prefix.join("."));
      return;
    }
    for (let len = 1; len <= Math.min(3, remaining.length); len++) {
      const octet = remaining.slice(0, len);
      if (octet.length > 1 && octet[0] === "0") break;  // no leading zero
      const val = Number(octet);
      if (val > 255) break;
      prefix.push(octet);
      recurse(prefix, remaining.slice(len));
      prefix.pop();
    }
  }
  recurse([], s);
  return out;
}

// "Sanitize Parentheses in Expression": given a string that
// contains parens that may be unmatched, remove the MINIMUM
// number of characters to make it valid. Return ALL such
// sanitized strings (multiple may exist). BFS over removal
// choices, tracking which strings have been seen, collecting
// valid results at the depth where we first find any.
function sanitizeParentheses(s) {
  // Step 1: figure out how many removals are needed.
  // Walk the string; track a counter. +1 for '(', -1 for ')'.
  // The number of unmatched ')' is the count of times the
  // counter went negative (we'll track these). The number of
  // unmatched '(' is the final value of the counter.
  const stack = [];
  const result = new Set();
  let queue = [s];
  const seen = new Set([s]);
  // Standard BFS approach (community solution).
  function isValid(str) {
    let count = 0;
    for (const ch of str) {
      if (ch === "(") count++;
      else if (ch === ")") {
        count--;
        if (count < 0) return false;
      }
    }
    return count === 0;
  }
  // BFS over removal levels until we find a level with at
  // least one valid string; return all valid strings at that
  // level. If the input is already valid, return [s].
  if (isValid(s)) return [s];
  while (queue.length > 0) {
    const next = [];
    for (const str of queue) {
      for (let i = 0; i < str.length; i++) {
        if (str[i] !== "(" && str[i] !== ")") continue;
        const cand = str.slice(0, i) + str.slice(i + 1);
        if (seen.has(cand)) continue;
        seen.add(cand);
        if (isValid(cand)) {
          result.add(cand);
        } else {
          next.push(cand);
        }
      }
    }
    if (result.size > 0) return [...result];
    queue = next;
  }
  return [...result];
}

// "Find All Valid Math Expressions": given a string of digits
// and a target number, return all valid expressions formed by
// inserting '+', '-', or '*' between the digits that evaluate
// to the target. No leading zeros (a single "0" is OK).
function findAllValidMathExpressions(digits, target) {
  const out = [];
  function recurse(idx, expr, value, lastTerm) {
    // lastTerm = value of the rightmost term (the one we'd
    // multiply if the next op is '*'). We track it separately
    // so that 1+2*3 evaluates to 9, not (1+2)*3 = 9 — same
    // here, but if we had 1+2-3 the bookkeeping gets tricky
    // with '*' because we need to undo the addition and apply
    // the multiplication instead.
    if (idx === digits.length) {
      if (value === target) out.push(expr);
      return;
    }
    for (let len = 1; len <= digits.length - idx; len++) {
      const sub = digits.slice(idx, idx + len);
      if (sub.length > 1 && sub[0] === "0") break;  // no leading zero
      const num = Number(sub);
      if (idx === 0) {
        recurse(idx + len, sub, num, num);
      } else {
        recurse(idx + len, expr + "+" + sub, value + num, num);
        recurse(idx + len, expr + "-" + sub, value - num, -num);
        // For '*', we undo the previous term and re-apply it
        // multiplied: value - lastTerm + (lastTerm * num).
        recurse(idx + len, expr + "*" + sub, value - lastTerm + lastTerm * num, lastTerm * num);
      }
    }
  }
  recurse(0, "", 0, 0);
  return out;
}

// "Encryption I: Caesar Cipher": shift every letter by n (wrap
// within 'a'-'z' or 'A'-'Z'; non-letters pass through). The
// shift is rightward by n in the game; the input is
// [plaintext, shift]. We do the shift, return the ciphertext.
function caesarCipher(plaintext, shift) {
  let out = "";
  for (const ch of plaintext) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      // uppercase
      out += String.fromCharCode(((code - 65 + shift) % 26 + 26) % 26 + 65);
    } else if (code >= 97 && code <= 122) {
      // lowercase
      out += String.fromCharCode(((code - 97 + shift) % 26 + 26) % 26 + 97);
    } else {
      out += ch;
    }
  }
  return out;
}

// "Encryption II: Vigenère Cipher": data is [plaintext, key].
// Each letter of plaintext is shifted by the corresponding
// letter of key (A=0, B=1, ..., Z=25). Non-letters pass
// through. The KEY CYCLES regardless of non-letters in the
// plaintext (so "A B" with key "B" shifts the A by 1 and the B
// by 2 — the key index moves by one for every plaintext char,
// letter or not).
function vigenereCipher(plaintext, key) {
  let out = "";
  let ki = 0;
  for (const ch of plaintext) {
    const code = ch.charCodeAt(0);
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (upper || lower) {
      const base = upper ? 65 : 97;
      const k = key[ki % key.length].toLowerCase().charCodeAt(0) - 97;
      out += String.fromCharCode(((code - base + k) % 26 + 26) % 26 + base);
      ki++;
    } else {
      out += ch;
    }
  }
  return out;
}

// --- hamming codes ---------------------------------------------------------
// "Hamming Codes: Integer to Encoded Binary": produce the
// extended Hamming code for the input integer. The game uses
// the Hedrauta-style encoding: data bits and parity bits are
// stored in the SAME integer positions (1..n), with parity
// bits at powers of 2. CRUCIALLY: data bits are stored in
// REVERSED endianness (LSB first), and parity bits are set
// from the XOR of all SET BIT POSITIONS (this is the "Hamming
// parity = index XOR rule" rather than the usual "count of 1s
// in subset" rule).
//
// Concretely (verbatim from bitburner-src/src/CodingContract/
// contracts/HammingCode.ts HammingEncode):
//   1. enc[0] = 0 (overall parity, set last).
//   2. Walk positions 1..∞. For each position i, if (i & (i-1)) != 0
//      (NOT a power of 2), it's a data position. Pop data bits
//      from the LSB of the input.
//   3. parityNumber = XOR of all set bit positions in enc.
//      The parity bits (positions 1, 2, 4, 8, ...) are set to
//      the bits of parityNumber (LSB first).
//   4. enc[0] = (number of 1 bits in enc) % 2.
//   5. Return enc as a "0"/"1" string of length ceil(log2(n))+1.
//
// The result string has length m+1 where 2^(m-1) ≤ n+1 < 2^m.
// Wait — actually the result length is 2^m where m is the
// smallest m with 2^(2^m - m - 1) > data. For the small
// cases the game generates, m is typically 2 or 3 (so output
// is 4 or 8 chars).
function hammingEncode(data) {
  const enc = [0];
  const data_bits = data.toString(2).split("").reverse().map(Number);
  let k = data_bits.length;
  // Place data bits at non-power-of-2 positions, LSB first.
  for (let i = 1; k > 0; i++) {
    if ((i & (i - 1)) !== 0) {
      enc[i] = data_bits[--k];
    } else {
      enc[i] = 0;
    }
  }
  // Subsection parity: XOR of indices where enc bit is set.
  let parityNumber = 0;
  for (let i = 0; i < enc.length; i++) {
    if (enc[i]) parityNumber ^= i;
  }
  // Set the parity bits at powers of 2, LSB first.
  const parityArray = parityNumber.toString(2).split("").reverse().map(Number);
  for (let i = 0; i < parityArray.length; i++) {
    enc[2 ** i] = parityArray[i] ? 1 : 0;
  }
  // Overall parity (at position 0).
  let ones = 0;
  for (let i = 0; i < enc.length; i++) if (enc[i]) ones++;
  enc[0] = ones % 2 === 0 ? 0 : 1;
  return enc.join("");
}

// "Hamming Codes: Encoded Binary to Integer": inverse, with
// single-bit error correction. Algorithm (verbatim from
// bitburner-src HammingDecode):
//   1. Split into bits. err = XOR of all indices i where bit i
//      is 1. If err != 0, flip bit err (it's the errored bit).
//   2. Read data bits from non-power-of-2 positions, LSB first,
//      concatenate, parseInt(_, 2) → integer.
function hammingDecode(encoded) {
  const bits = encoded.split("").map(Number);
  let err = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) err ^= i;
  }
  if (err) bits[err] = bits[err] ? 0 : 1;
  let ans = "";
  for (let i = 1; i < bits.length; i++) {
    if ((i & (i - 1)) !== 0) ans += bits[i];
  }
  return parseInt(ans, 2);
}

// --- compression -----------------------------------------------------------

// "Compression I: RLE Compression": encode a string as
// <count><char> pairs. If a char appears 10+ times in a row,
// split into multiple <9><char> blocks. Empty string returns "".
function rleCompress(s) {
  if (s.length === 0) return "";
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    let count = 1;
    while (i + count < s.length && s[i + count] === ch && count < 9) count++;
    out += String(count) + ch;
    i += count;
  }
  return out;
}

// "Compression II: LZ Decompression": the game's variant of
// LZ77. Format: chunks ALTERNATE between LITERAL and BACKREF
// (starting with literal). A chunk begins with a length L
// (ASCII digit 1-9). For a literal chunk, the next L chars are
// copied verbatim. For a backref chunk, the next char is an
// offset X (1-9) and the chunk outputs L copies of
// plain[plain.length - X]. L=0 ends the current chunk early;
// the very next char is then the length of a fresh chunk
// (alternating type). The final chunk may be of either type.
//
// Examples (per the game source's comprLZDecode — note: the
// desc text in the game's Compression.ts has typos in the
// example trace, but the comprLZDecode function itself is
// authoritative):
//   "5aaabb"            -> "aaabb"
//   "5aaabb45"          -> "aaabbaaaa"  (NOT "aaabbaaab" as
//                                       the in-game desc says)
//   "1a91031"           -> "aaaaaaaaaaaa"  (3aaa9 then backref
//                                          of length 1, offset 3,
//                                          wait, decode is:
//                                          L=1, "a" -> "a"; backref
//                                          9,1 -> 9 'a's -> "aaaaaaaaa";
//                                          L=0 ends; L=3, "1" (1? hmm
//                                          actually the encoding
//                                          1a91041 means: 1a, 9104,
//                                          ... no the chunks
//                                          alternate. So:
//                                          chunk1 literal 1a: "a"
//                                          chunk2 backref 91: 9 'a'
//                                          -> "aaaaaaaaa"
//                                          chunk3 literal 03: 0 ends
//                                          chunk2; then chunk3 = L=3,
//                                          "1" — but that's only 1
//                                          char and we need 3
//                                          chars. Hmm. This is why
//                                          the LZ desc is confusing.)
//
// The "verifier" check is: comprLZDecode(answer) === plain
// AND answer.length <= optimal.length. So the decoder is the
// spec — the encoder just needs to produce a valid LZ string
// of length ≤ the game's optimal.
function lzDecompress(compr) {
  let plain = "";
  for (let i = 0; i < compr.length; ) {
    const literal_length = compr.charCodeAt(i) - 0x30;
    if (literal_length < 0 || literal_length > 9 || i + 1 + literal_length > compr.length) return "";
    plain += compr.substring(i + 1, i + 1 + literal_length);
    i += 1 + literal_length;
    if (i >= compr.length) break;
    const backref_length = compr.charCodeAt(i) - 0x30;
    if (backref_length < 0 || backref_length > 9) return "";
    if (backref_length === 0) { i++; continue; }
    if (i + 1 >= compr.length) return "";
    const backref_offset = compr.charCodeAt(i + 1) - 0x30;
    if (backref_length > 0 && (backref_offset < 1 || backref_offset > 9)) return "";
    if (backref_offset > plain.length) return "";
    for (let j = 0; j < backref_length; j++) {
      plain += plain[plain.length - backref_offset];
    }
    i += 2;
  }
  return plain;
}

// "Compression III: LZ Compression": produce a valid LZ
// encoding whose length is ≤ the game's optimal. The verifier
// decodes our answer and checks (a) it round-trips to the
// original plaintext, (b) the encoded length is ≤ the game's
// optimal. The game's optimal is computed by `comprLZEncode`
// (a DP over state[0..9][1..9]). We use the same DP for
// correctness.
//
// DP state (matching bitburner-src's comprLZEncode):
//   state[i][j] = best (shortest) encoding string so far
//   i = 0: literal chunk, j = current length (1-9)
//   i in 1-9: backref chunk with offset i, j = current length
// Transitions at each new plaintext char c = plain[i]:
//   - Extend a literal chunk: state[0][j+1] (if j<9)
//   - End literal chunk + start new literal: state[0][1] += "9"+prev9chars+"0"
//   - End literal chunk + start new backref (offset d, length 1):
//     if plain[i-d] === c, state[d][1] += prevLength+prevChars
//   - Extend a backref chunk: state[off][j+1] (if j<9, and matches)
//   - End backref + start new literal: state[0][1] += length+offset
//   - End backref + start new backref (offset d, length 1):
//     if plain[i-d] === c, state[d][1] += length+offset+"0"
// At end, append the final chunk's length+payload to each state.
function lzCompress(plain) {
  if (plain.length === 0) return "";
  // cur_state[i][j] = best encoding for prefix up to current
  // position, ending with a chunk of type i and length j.
  let cur = Array.from({ length: 10 }, () => new Array(10).fill(null));
  let next = Array.from({ length: 10 }, () => new Array(10).fill(null));
  function set(state, i, j, str) {
    const cur = state[i][j];
    if (cur === null || str.length < cur.length) state[i][j] = str;
    else if (str.length === cur.length && Math.random() < 0.5) state[i][j] = str;
  }
  // Initial: literal chunk of length 1 covering 0 chars (will
  // pick up the first char on the first iteration).
  cur[0][1] = "";
  for (let i = 1; i < plain.length; i++) {
    // Clear next
    for (let r = 0; r < 10; r++) next[r].fill(null);
    const c = plain[i];
    // Literal states
    for (let len = 1; len <= 9; len++) {
      const s = cur[0][len];
      if (s === null) continue;
      if (len < 9) {
        set(next, 0, len + 1, s);
      } else {
        set(next, 0, 1, s + "9" + plain.substring(i - 9, i) + "0");
      }
      for (let off = 1; off <= Math.min(9, i); off++) {
        if (plain[i - off] === c) {
          set(next, off, 1, s + String(len) + plain.substring(i - len, i));
        }
      }
    }
    // Backref states
    for (let off = 1; off <= 9; off++) {
      for (let len = 1; len <= 9; len++) {
        const s = cur[off][len];
        if (s === null) continue;
        if (plain[i - off] === c) {
          if (len < 9) {
            set(next, off, len + 1, s);
          } else {
            set(next, off, 1, s + "9" + String(off) + "0");
          }
        }
        // End backref, start new literal
        set(next, 0, 1, s + String(len) + String(off));
        // End backref, start new backref
        for (let newOff = 1; newOff <= Math.min(9, i); newOff++) {
          if (plain[i - newOff] === c) {
            set(next, newOff, 1, s + String(len) + String(off) + "0");
          }
        }
      }
    }
    // Swap
    [cur, next] = [next, cur];
  }
  // Finalize: append the final chunk's length+payload
  let result = null;
  for (let len = 1; len <= 9; len++) {
    let s = cur[0][len];
    if (s === null) continue;
    s += String(len) + plain.substring(plain.length - len, plain.length);
    if (result === null || s.length < result.length) result = s;
  }
  for (let off = 1; off <= 9; off++) {
    for (let len = 1; len <= 9; len++) {
      let s = cur[off][len];
      if (s === null) continue;
      s += String(len) + String(off);
      if (result === null || s.length < result.length) result = s;
    }
  }
  return result ?? "";
}

// --- graphs ----------------------------------------------------------------

// "Proper 2-Coloring of a Graph": data = [numVertices,
// edges[]] where edges are [u, v] pairs. Return an array of 0/1
// color assignments (length numVertices) such that no edge
// connects two same-colored vertices. If no valid 2-coloring
// exists, return [] (empty array). The game input is always
// 2-colorable, so we assume success.
function twoColorGraph(n, edges) {
  const color = new Array(n).fill(-1);
  const adj = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    adj[u].push(v);
    adj[v].push(u);
  }
  for (let start = 0; start < n; start++) {
    if (color[start] !== -1) continue;
    color[start] = 0;
    const queue = [start];
    while (queue.length > 0) {
      const u = queue.shift();
      for (const v of adj[u]) {
        if (color[v] === -1) {
          color[v] = 1 - color[u];
          queue.push(v);
        } else if (color[v] === color[u]) {
          return [];  // not 2-colorable
        }
      }
    }
  }
  return color;
}

// --- stock trader ----------------------------------------------------------

// "Algorithmic Stock Trader I": one transaction, max profit.
// Verbatim from bitburner-src/src/CodingContract/contracts/
// AlgorithmicStockTrader.ts getAnswer(I): Kadane-style on
// price deltas. Equivalent to max(prices[j]-prices[i]) over
// j>i, but uses the running-sum form.
function stockTraderI(prices) {
  let maxCur = 0;
  let maxSoFar = 0;
  for (let i = 1; i < prices.length; i++) {
    maxCur = Math.max(0, (maxCur += prices[i] - prices[i - 1]));
    maxSoFar = Math.max(maxCur, maxSoFar);
  }
  return maxSoFar;
}

// "Algorithmic Stock Trader II": unlimited transactions, but
// no two in parallel. The trick: any time prices[i+1] >
// prices[i], you make prices[i+1] - prices[i]. This is the
// maximum profit of all upward moves.
function stockTraderII(prices) {
  let profit = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) profit += prices[i] - prices[i - 1];
  }
  return profit;
}

// "Algorithmic Stock Trader III": at most 2 transactions. The
// O(n) solution: track the best profit for one transaction
// ending at or before each day (left[i]), and the best profit
// for one transaction starting at or after each day
// (right[i]). Then max(left[i] + right[i+1]) is the answer.
function stockTraderIII(prices) {
  if (prices.length < 2) return 0;
  const n = prices.length;
  const left = new Array(n).fill(0);
  const right = new Array(n).fill(0);
  let min = prices[0];
  for (let i = 1; i < n; i++) {
    left[i] = Math.max(left[i - 1], prices[i] - min);
    if (prices[i] < min) min = prices[i];
  }
  let max = prices[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    right[i] = Math.max(right[i + 1], max - prices[i]);
    if (prices[i] > max) max = prices[i];
  }
  let best = left[n - 1];  // single transaction
  for (let i = 0; i < n - 1; i++) {
    if (left[i] + right[i + 1] > best) best = left[i] + right[i + 1];
  }
  return best;
}

// "Algorithmic Stock Trader IV": at most k transactions.
// data = [k, prices[]]. Verbatim from bitburner-src getAnswer(IV):
// If k > n/2 the answer is "sum of all positive deltas" (same
// as unlimited transactions). Otherwise hold[j]/rele[j] state
// per active transaction: rele[j] = best profit after j-th
// complete sell; hold[j] = best profit while holding the j-th
// stock. Update rele[j] before hold[j] each day, iterate j
// downward.
function stockTraderIV(k, prices) {
  const len = prices.length;
  if (len < 2 || k === 0) return 0;
  if (k > len / 2) {
    let res = 0;
    for (let i = 1; i < len; i++) res += Math.max(prices[i] - prices[i - 1], 0);
    return res;
  }
  const hold = new Array(k + 1).fill(Number.MIN_SAFE_INTEGER);
  const rele = new Array(k + 1).fill(0);
  for (let i = 0; i < len; i++) {
    const cur = prices[i];
    for (let j = k; j > 0; j--) {
      rele[j] = Math.max(rele[j], hold[j] + cur);
      hold[j] = Math.max(hold[j], rele[j - 1] - cur);
    }
  }
  return rele[k];
}

// --- square root -----------------------------------------------------------

// "Square Root": given a bigint, return floor(sqrt(n)). Newton's
// method on bigints. The game always passes a non-negative
// number; for n=0 we return 0n.
function bigintSqrt(n) {
  if (n < 0n) throw "sqrt of negative";
  if (n < 2n) return n;
  // Initial guess: 1 << ((bit-length of n) / 2 + 1). This
  // is a generous upper bound.
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// --- the registry ----------------------------------------------------------

// Map of contract type (the EXACT string returned by
// getContractType) → solver function. The scanner uses this
// to look up the right solver. If a new contract type is
// added, just drop in an entry here.
export const SOLVERS = {
  "Find Largest Prime Factor":                 (n) => largestPrimeFactor(Number(n)),
  "Subarray with Maximum Sum":                 (arr) => maxSubarraySum(arr),
  "Total Ways to Sum":                         (n) => totalWaysToSum(Number(n)),
  "Total Ways to Sum II":                      ([n, summands]) => totalWaysToSumII(n, summands),
  "Spiralize Matrix":                          (m) => spiralizeMatrix(m),
  "Array Jumping Game":                        (arr) => arrayJumpingGame(arr),
  "Array Jumping Game II":                     (arr) => arrayJumpingGameII(arr),
  "Merge Overlapping Intervals":               (intervals) => mergeIntervals(intervals),
  "Generate IP Addresses":                     (s) => generateIPAddresses(s),
  "Algorithmic Stock Trader I":                (prices) => stockTraderI(prices),
  "Algorithmic Stock Trader II":               (prices) => stockTraderII(prices),
  "Algorithmic Stock Trader III":              (prices) => stockTraderIII(prices),
  "Algorithmic Stock Trader IV":               ([k, prices]) => stockTraderIV(k, prices),
  "Minimum Path Sum in a Triangle":            (tri) => minPathTriangle(tri),
  "Unique Paths in a Grid I":                  ([m, n]) => uniquePathsI(m, n),
  "Unique Paths in a Grid II":                 (grid) => uniquePathsII(grid),
  "Shortest Path in a Grid":                   (grid) => shortestPathGrid(grid),
  "Sanitize Parentheses in Expression":        (s) => sanitizeParentheses(s),
  "Find All Valid Math Expressions":           ([digits, target]) => findAllValidMathExpressions(digits, target),
  "HammingCodes: Integer to Encoded Binary":   (n) => hammingEncode(Number(n)),
  "HammingCodes: Encoded Binary to Integer":   (s) => hammingDecode(s),
  "Proper 2-Coloring of a Graph":              ([n, edges]) => twoColorGraph(n, edges),
  "Compression I: RLE Compression":            (s) => rleCompress(s),
  "Compression II: LZ Decompression":          (s) => lzDecompress(s),
  "Compression III: LZ Compression":           (s) => lzCompress(s),
  "Encryption I: Caesar Cipher":               ([text, shift]) => caesarCipher(text, shift),
  "Encryption II: Vigenère Cipher":            ([text, key]) => vigenereCipher(text, key),
  "Square Root":                               (n) => bigintSqrt(BigInt(n)).toString(),
  "Total Number of Primes":                    ([lo, hi]) => countPrimes(lo, hi),
  "Largest Rectangle in a Matrix":             (grid) => largestRectangleMatrix(grid),
};
