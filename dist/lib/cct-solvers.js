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
        }
        else {
            factor++;
        }
    }
    // Whatever's left of n after the loop is also a prime factor.
    // (Either n is 1, meaning the input was 1 and there are no
    // prime factors — the game won't generate that, but be safe —
    // or n itself is the largest prime factor > sqrt(original).)
    if (n > 1)
        largest = n;
    return largest;
}
function isPrime(n) {
    if (n < 2)
        return false;
    if (n < 4)
        return true; // 2, 3
    if (n % 2 === 0)
        return false;
    for (let i = 3; i * i <= n; i += 2) {
        if (n % i === 0)
            return false;
    }
    return true;
}
function countPrimes(low, high) {
    // Count primes in [low, high] inclusive. The game generates
    // ranges that are tractable for a naive sqrt sieve at this
    // scale; if ranges get bigger than ~10^6 we can swap in a true
    // sieve but I haven't seen one in practice.
    let count = 0;
    for (let i = low; i <= high; i++)
        if (isPrime(i))
            count++;
    return count;
}
// --- array / DP ------------------------------------------------------------
// "Subarray with Maximum Sum": given an array of numbers (which
// may include negatives), find the contiguous subarray with the
// largest sum. Classic Kadane's algorithm.
function maxSubarraySum(arr) {
    if (arr.length === 0)
        return 0;
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
        for (let j = i; j <= n; j++)
            ways[j] += ways[j - i];
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
        for (let j = summands[i]; j <= n; j++)
            ways[j] += ways[j - summands[i]];
    }
    return ways[n];
}
// --- grid / matrix ---------------------------------------------------------
// "Spiralize Matrix": return the matrix in clockwise spiral
// order, top to bottom, left to right.
function spiralizeMatrix(m) {
    if (m.length === 0)
        return [];
    const out = [];
    let top = 0, bottom = m.length - 1, left = 0, right = m[0].length - 1;
    while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++)
            out.push(m[top][c]);
        top++;
        for (let r = top; r <= bottom; r++)
            out.push(m[r][right]);
        right--;
        if (top <= bottom) {
            for (let c = right; c >= left; c--)
                out.push(m[bottom][c]);
            bottom--;
        }
        if (left <= right) {
            for (let r = bottom; r >= top; r--)
                out.push(m[r][left]);
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
    if (grid.length === 0 || grid[0].length === 0)
        return 0;
    if (grid[0][0] === 1)
        return 0;
    const m = grid.length;
    const n = grid[0].length;
    const dp = Array.from({ length: m }, () => new Array(n).fill(0));
    dp[0][0] = 1;
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
            if (grid[i][j] === 1) {
                dp[i][j] = 0;
                continue;
            }
            if (i > 0)
                dp[i][j] += dp[i - 1][j];
            if (j > 0)
                dp[i][j] += dp[i][j - 1];
        }
    }
    return dp[m - 1][n - 1];
}
// "Shortest Path in a Grid": like Unique Paths II, but the
// answer is the path itself as a string of "U/D/L/R" characters.
// If no path exists, return "" (empty string).
function shortestPathGrid(grid) {
    if (grid.length === 0 || grid[0].length === 0)
        return "";
    if (grid[0][0] === 1)
        return "";
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
        if (cur.r === m - 1 && cur.c === n - 1)
            return cur.path;
        for (const d of dirs) {
            const nr = cur.r + d.dr;
            const nc = cur.c + d.dc;
            if (nr < 0 || nr >= m || nc < 0 || nc >= n)
                continue;
            if (grid[nr][nc] === 1)
                continue;
            const key = `${nr},${nc}`;
            if (visited.has(key))
                continue;
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
            if (grid[r][c] === 0)
                count++;
            else
                count = 0;
            histograms[r][c] = count;
        }
    }
    let maxArea = 0;
    let maxL = 0, maxR = 0, maxU = 0, maxD = 0;
    for (let r = 0; r < numRows; r++) {
        const row = histograms[r];
        for (let c = 0; c < numCols; c++) {
            if (row[c] === 0)
                continue;
            let left = c;
            let right = c;
            while (row[left - 1] >= row[c])
                left--;
            while (row[right + 1] >= row[c])
                right++;
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
    if (intervals.length === 0)
        return [];
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    const out = [sorted[0].slice()];
    for (let i = 1; i < sorted.length; i++) {
        const top = out[out.length - 1];
        if (sorted[i][0] <= top[1]) {
            top[1] = Math.max(top[1], sorted[i][1]);
        }
        else {
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
            if (remaining.length === 0)
                out.push(prefix.join("."));
            return;
        }
        for (let len = 1; len <= Math.min(3, remaining.length); len++) {
            const octet = remaining.slice(0, len);
            if (octet.length > 1 && octet[0] === "0")
                break; // no leading zero
            const val = Number(octet);
            if (val > 255)
                break;
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
            if (ch === "(")
                count++;
            else if (ch === ")") {
                count--;
                if (count < 0)
                    return false;
            }
        }
        return count === 0;
    }
    // BFS over removal levels until we find a level with at
    // least one valid string; return all valid strings at that
    // level. If the input is already valid, return [s].
    if (isValid(s))
        return [s];
    while (queue.length > 0) {
        const next = [];
        for (const str of queue) {
            for (let i = 0; i < str.length; i++) {
                if (str[i] !== "(" && str[i] !== ")")
                    continue;
                const cand = str.slice(0, i) + str.slice(i + 1);
                if (seen.has(cand))
                    continue;
                seen.add(cand);
                if (isValid(cand)) {
                    result.add(cand);
                }
                else {
                    next.push(cand);
                }
            }
        }
        if (result.size > 0)
            return [...result];
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
            if (value === target)
                out.push(expr);
            return;
        }
        for (let len = 1; len <= digits.length - idx; len++) {
            const sub = digits.slice(idx, idx + len);
            if (sub.length > 1 && sub[0] === "0")
                break; // no leading zero
            const num = Number(sub);
            if (idx === 0) {
                recurse(idx + len, sub, num, num);
            }
            else {
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
        }
        else if (code >= 97 && code <= 122) {
            // lowercase
            out += String.fromCharCode(((code - 97 + shift) % 26 + 26) % 26 + 97);
        }
        else {
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
        }
        else {
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
        }
        else {
            enc[i] = 0;
        }
    }
    // Subsection parity: XOR of indices where enc bit is set.
    let parityNumber = 0;
    for (let i = 0; i < enc.length; i++) {
        if (enc[i])
            parityNumber ^= i;
    }
    // Set the parity bits at powers of 2, LSB first.
    const parityArray = parityNumber.toString(2).split("").reverse().map(Number);
    for (let i = 0; i < parityArray.length; i++) {
        enc[2 ** i] = parityArray[i] ? 1 : 0;
    }
    // Overall parity (at position 0).
    let ones = 0;
    for (let i = 0; i < enc.length; i++)
        if (enc[i])
            ones++;
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
        if (bits[i])
            err ^= i;
    }
    if (err)
        bits[err] = bits[err] ? 0 : 1;
    let ans = "";
    for (let i = 1; i < bits.length; i++) {
        if ((i & (i - 1)) !== 0)
            ans += bits[i];
    }
    return parseInt(ans, 2);
}
// --- compression -----------------------------------------------------------
// "Compression I: RLE Compression": encode a string as
// <count><char> pairs. If a char appears 10+ times in a row,
// split into multiple <9><char> blocks. Empty string returns "".
function rleCompress(s) {
    if (s.length === 0)
        return "";
    let out = "";
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        let count = 1;
        while (i + count < s.length && s[i + count] === ch && count < 9)
            count++;
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
    for (let i = 0; i < compr.length;) {
        const literal_length = compr.charCodeAt(i) - 0x30;
        if (literal_length < 0 || literal_length > 9 || i + 1 + literal_length > compr.length)
            return "";
        plain += compr.substring(i + 1, i + 1 + literal_length);
        i += 1 + literal_length;
        if (i >= compr.length)
            break;
        const backref_length = compr.charCodeAt(i) - 0x30;
        if (backref_length < 0 || backref_length > 9)
            return "";
        if (backref_length === 0) {
            i++;
            continue;
        }
        if (i + 1 >= compr.length)
            return "";
        const backref_offset = compr.charCodeAt(i + 1) - 0x30;
        if (backref_length > 0 && (backref_offset < 1 || backref_offset > 9))
            return "";
        if (backref_offset > plain.length)
            return "";
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
    if (plain.length === 0)
        return "";
    // cur_state[i][j] = best encoding for prefix up to current
    // position, ending with a chunk of type i and length j.
    let cur = Array.from({ length: 10 }, () => new Array(10).fill(null));
    let next = Array.from({ length: 10 }, () => new Array(10).fill(null));
    function set(state, i, j, str) {
        const cur = state[i][j];
        if (cur === null || str.length < cur.length)
            state[i][j] = str;
        else if (str.length === cur.length && Math.random() < 0.5)
            state[i][j] = str;
    }
    // Initial: literal chunk of length 1 covering 0 chars (will
    // pick up the first char on the first iteration).
    cur[0][1] = "";
    for (let i = 1; i < plain.length; i++) {
        // Clear next
        for (let r = 0; r < 10; r++)
            next[r].fill(null);
        const c = plain[i];
        // Literal states
        for (let len = 1; len <= 9; len++) {
            const s = cur[0][len];
            if (s === null)
                continue;
            if (len < 9) {
                set(next, 0, len + 1, s);
            }
            else {
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
                if (s === null)
                    continue;
                if (plain[i - off] === c) {
                    if (len < 9) {
                        set(next, off, len + 1, s);
                    }
                    else {
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
        if (s === null)
            continue;
        s += String(len) + plain.substring(plain.length - len, plain.length);
        if (result === null || s.length < result.length)
            result = s;
    }
    for (let off = 1; off <= 9; off++) {
        for (let len = 1; len <= 9; len++) {
            let s = cur[off][len];
            if (s === null)
                continue;
            s += String(len) + String(off);
            if (result === null || s.length < result.length)
                result = s;
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
        if (color[start] !== -1)
            continue;
        color[start] = 0;
        const queue = [start];
        while (queue.length > 0) {
            const u = queue.shift();
            for (const v of adj[u]) {
                if (color[v] === -1) {
                    color[v] = 1 - color[u];
                    queue.push(v);
                }
                else if (color[v] === color[u]) {
                    return []; // not 2-colorable
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
        if (prices[i] > prices[i - 1])
            profit += prices[i] - prices[i - 1];
    }
    return profit;
}
// "Algorithmic Stock Trader III": at most 2 transactions. The
// O(n) solution: track the best profit for one transaction
// ending at or before each day (left[i]), and the best profit
// for one transaction starting at or after each day
// (right[i]). Then max(left[i] + right[i+1]) is the answer.
function stockTraderIII(prices) {
    if (prices.length < 2)
        return 0;
    const n = prices.length;
    const left = new Array(n).fill(0);
    const right = new Array(n).fill(0);
    let min = prices[0];
    for (let i = 1; i < n; i++) {
        left[i] = Math.max(left[i - 1], prices[i] - min);
        if (prices[i] < min)
            min = prices[i];
    }
    let max = prices[n - 1];
    for (let i = n - 2; i >= 0; i--) {
        right[i] = Math.max(right[i + 1], max - prices[i]);
        if (prices[i] > max)
            max = prices[i];
    }
    let best = left[n - 1]; // single transaction
    for (let i = 0; i < n - 1; i++) {
        if (left[i] + right[i + 1] > best)
            best = left[i] + right[i + 1];
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
    if (len < 2 || k === 0)
        return 0;
    if (k > len / 2) {
        let res = 0;
        for (let i = 1; i < len; i++)
            res += Math.max(prices[i] - prices[i - 1], 0);
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
    if (n < 0n)
        throw "sqrt of negative";
    if (n < 2n)
        return n;
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
    "Find Largest Prime Factor": (n) => largestPrimeFactor(Number(n)),
    "Subarray with Maximum Sum": (arr) => maxSubarraySum(arr),
    "Total Ways to Sum": (n) => totalWaysToSum(Number(n)),
    "Total Ways to Sum II": ([n, summands]) => totalWaysToSumII(n, summands),
    "Spiralize Matrix": (m) => spiralizeMatrix(m),
    "Array Jumping Game": (arr) => arrayJumpingGame(arr),
    "Array Jumping Game II": (arr) => arrayJumpingGameII(arr),
    "Merge Overlapping Intervals": (intervals) => mergeIntervals(intervals),
    "Generate IP Addresses": (s) => generateIPAddresses(s),
    "Algorithmic Stock Trader I": (prices) => stockTraderI(prices),
    "Algorithmic Stock Trader II": (prices) => stockTraderII(prices),
    "Algorithmic Stock Trader III": (prices) => stockTraderIII(prices),
    "Algorithmic Stock Trader IV": ([k, prices]) => stockTraderIV(k, prices),
    "Minimum Path Sum in a Triangle": (tri) => minPathTriangle(tri),
    "Unique Paths in a Grid I": ([m, n]) => uniquePathsI(m, n),
    "Unique Paths in a Grid II": (grid) => uniquePathsII(grid),
    "Shortest Path in a Grid": (grid) => shortestPathGrid(grid),
    "Sanitize Parentheses in Expression": (s) => sanitizeParentheses(s),
    "Find All Valid Math Expressions": ([digits, target]) => findAllValidMathExpressions(digits, target),
    "HammingCodes: Integer to Encoded Binary": (n) => hammingEncode(Number(n)),
    "HammingCodes: Encoded Binary to Integer": (s) => hammingDecode(s),
    "Proper 2-Coloring of a Graph": ([n, edges]) => twoColorGraph(n, edges),
    "Compression I: RLE Compression": (s) => rleCompress(s),
    "Compression II: LZ Decompression": (s) => lzDecompress(s),
    "Compression III: LZ Compression": (s) => lzCompress(s),
    "Encryption I: Caesar Cipher": ([text, shift]) => caesarCipher(text, shift),
    "Encryption II: Vigenère Cipher": ([text, key]) => vigenereCipher(text, key),
    "Square Root": (n) => bigintSqrt(BigInt(n)).toString(),
    "Total Number of Primes": ([lo, hi]) => countPrimes(lo, hi),
    "Largest Rectangle in a Matrix": (grid) => largestRectangleMatrix(grid),
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2N0LXNvbHZlcnMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvbGliL2NjdC1zb2x2ZXJzLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDhEQUE4RDtBQUM5RCxFQUFFO0FBQ0YsNkRBQTZEO0FBQzdELGtFQUFrRTtBQUNsRSwrQ0FBK0M7QUFDL0MsZ0VBQWdFO0FBQ2hFLDZEQUE2RDtBQUM3RCxnRUFBZ0U7QUFDaEUsNkRBQTZEO0FBQzdELCtEQUErRDtBQUMvRCxpRUFBaUU7QUFDakUsK0RBQStEO0FBQy9ELHFDQUFxQztBQUNyQyxFQUFFO0FBQ0Ysa0VBQWtFO0FBQ2xFLDZEQUE2RDtBQUM3RCxrRUFBa0U7QUFDbEUsK0RBQStEO0FBQy9ELGlFQUFpRTtBQUNqRSwwQ0FBMEM7QUFDMUMsRUFBRTtBQUNGLCtEQUErRDtBQUMvRCxnRUFBZ0U7QUFDaEUsaUJBQWlCO0FBQ2pCLEVBQUU7QUFDRiwyREFBMkQ7QUFDM0QsK0RBQStEO0FBQy9ELHFEQUFxRDtBQUNyRCxnRUFBZ0U7QUFDaEUsZ0VBQWdFO0FBRWhFLDhFQUE4RTtBQUU5RSxTQUFTLGtCQUFrQixDQUFDLENBQUM7SUFDM0IsSUFBSSxNQUFNLEdBQUcsQ0FBQyxDQUFDO0lBQ2YsSUFBSSxPQUFPLEdBQUcsQ0FBQyxDQUFDO0lBQ2hCLE9BQU8sTUFBTSxHQUFHLE1BQU0sSUFBSSxDQUFDLEVBQUU7UUFDM0IsSUFBSSxDQUFDLEdBQUcsTUFBTSxLQUFLLENBQUMsRUFBRTtZQUNwQixPQUFPLEdBQUcsTUFBTSxDQUFDO1lBQ2pCLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDO1NBQ2hCO2FBQU07WUFDTCxNQUFNLEVBQUUsQ0FBQztTQUNWO0tBQ0Y7SUFDRCw4REFBOEQ7SUFDOUQsMkRBQTJEO0lBQzNELDhEQUE4RDtJQUM5RCw2REFBNkQ7SUFDN0QsSUFBSSxDQUFDLEdBQUcsQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDLENBQUM7SUFDdkIsT0FBTyxPQUFP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LE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDeEIsTUFBTSxJQUFJLEdBQUcsSUFBSSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xDLE1BQU0sS0FBSyxHQUFHLElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNuQyxJQUFJLEdBQUcsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDcEIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRTtRQUMxQixJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQztRQUNqRCxJQUFJLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHO1lBQUUsR0FBRyxHQUFHLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztLQUN0QztJQUNELElBQUksR0FBRyxHQUFHLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDeEIsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUU7UUFDL0IsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxHQUFHLEdBQUcsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkQsSUFBSSxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRztZQUFFLEdBQUcsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7S0FDdEM7SUFDRCxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FB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QUFDLENBQUMsRUFBRSxLQUFLLENBQUM7SUFDcEYsZ0NBQWdDLEVBQWEsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7SUFDbEUsa0NBQWtDLEVBQVcsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7SUFDbkUsaUNBQWlDLEVBQVksQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7SUFDakUsNkJBQTZCLEVBQWdCLENBQUMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLEVBQUUsRUFBRSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDO0lBQ3pGLGdDQUFnQyxFQUFhLENBQUMsQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRSxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDO0lBQ3ZGLGFBQWEsRUFBZ0MsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUU7SUFDcEYsd0JBQXdCLEVBQXFCLENBQUMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDO0lBQzlFLCtCQUErQixFQUFjLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUM7Q0FDcEYsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIFNvbHZlcnMgZm9yIGV2ZXJ5IENvZGluZyBDb250cmFjdCB0eXBlIGluIEJpdGJ1cm5lciAodjMueCkuXG4vL1xuLy8gRWFjaCBlbnRyeSBpcyBrZXllZCBieSB0aGUgRVhBQ1QgY29udHJhY3QgdHlwZSBzdHJpbmcgdGhhdFxuLy8gbnMuY29kaW5nY29udHJhY3QuZ2V0Q29udHJhY3RUeXBlKCkgcmV0dXJucyAodGhlIGh1bWFuLXJlYWRhYmxlXG4vLyBmb3JtLCBlLmcuIFwiRmluZCBMYXJnZXN0IFByaW1lIEZhY3RvclwiIOKAlCBzZWVcbi8vIENvZGluZ0NvbnRyYWN0TmFtZUVudW1UeXBlIGluIE5ldHNjcmlwdERlZmluaXRpb25zLmQudHMpLiBUaGVcbi8vIHZhbHVlIGlzIGEgZnVuY3Rpb24gKGRhdGEpID0+IGFuc3dlci4gVGhlIGZ1bmN0aW9uIHNob3VsZDpcbi8vICAgLSByZXR1cm4gdGhlIGFuc3dlciBpbiB0aGUgZm9ybWF0IHRoZSBnYW1lIGV4cGVjdHMgZm9yIHRoYXRcbi8vICAgICBjb250cmFjdCB0eXBlIChudW1iZXIsIHN0cmluZywgYXJyYXksIGV0Yy4pLiBUaGUgLmQudHNcbi8vICAgICBzaWduYXR1cmUgbWFwIENvZGluZ0NvbnRyYWN0U2lnbmF0dXJlcyBpcyBhdXRob3JpdGF0aXZlLlxuLy8gICAtIHRocm93IGEgc3RyaW5nIGVycm9yIChOT1QgYW4gRXJyb3Igb2JqZWN0KSBpZiB0aGUgY29udHJhY3Rcbi8vICAgICBpcyB1bnNvbHZhYmxlIC8gdW5yZWNvZ25pemVkIC8gaGFzIGJhZCBkYXRhLiBUaGUgc2Nhbm5lclxuLy8gICAgIGNhdGNoZXMgdGhlIHRocm93IGFuZCBsb2dzIGl0LlxuLy9cbi8vIFdoeSBhIHNlcGFyYXRlIG1vZHVsZTogdGhlIHNvbHZlciBsaXN0IGlzIGxhcmdlICh+MjkgdHlwZXMpIGFuZFxuLy8gZ3Jvd3Mgb3ZlciB0aW1lLiBLZWVwaW5nIHRoZW0gb3V0IG9mIHRoZSBzY2FubmVyIGtlZXBzIHRoZVxuLy8gc2Nhbm5lcidzIGxvZ2ljIChzZXJ2ZXIgd2FsayArIHN1Ym1pdCBsb29wKSBzaG9ydCBhbmQgcmVhZGFibGUuXG4vLyBUaGUgc2Nhbm5lciBpbXBvcnRzIHRoaXMgbW9kdWxlIHZpYSBgaW1wb3J0IHsgU09MVkVSUyB9IGZyb21cbi8vIFwiL2xpYi9jY3Qtc29sdmVycy5qc1wiYDsgd2l0aCB0c2MgKyB0aGUgZmlsZXN5bmMgbW9kZWwsIGxpYi8gaXNcbi8vIHN5bmNlZCB0byBkaXN0L2xpYi8gYWxvbmdzaWRlIHRoZSByZXN0LlxuLy9cbi8vIFRoZSAyOSBjb250cmFjdCB0eXBlcyBhcyBvZiBCaXRidXJuZXIgMy4wLjAuIElmIGEgbmV3IG9uZSBpc1xuLy8gYWRkZWQsIGRyb3AgYSBuZXcgZW50cnkgaW4gdGhpcyBtYXAg4oCUIHRoZSBzY2FubmVyIHBpY2tzIGl0IHVwXG4vLyBhdXRvbWF0aWNhbGx5LlxuLy9cbi8vIEFsZ29yaXRobSBzb3VyY2VzOiB0aGlzIGlzIHRoZSBzYW1lIHNldCBvZiBzb2x1dGlvbnMgdGhlXG4vLyBjb21tdW5pdHkgaGFzIGNvbnNvbGlkYXRlZCBvdmVyIHRoZSB5ZWFycyAoc2VlIHRoZSBCaXRidXJuZXJcbi8vIERpc2NvcmQgI2NvZGluZy1jb250cmFjdHMgY2hhbm5lbCBhbmQgdGhlIG9yaWdpbmFsXG4vLyBgaW1wb3J0LWZyb20tYml0YnVybmVyYCByZXBvKS4gSSByZXdyb3RlIHRoZW0gaW4gcGxhaW4gSlMgZm9yXG4vLyBwb3J0YWJpbGl0eSBhbmQgdG8gbWF0Y2ggdGhlIHByb2plY3QncyBuby1kZXBlbmRlbmNpZXMgc3R5bGUuXG5cbi8vIC0tLSBudW1iZXIgdGhlb3J5IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBsYXJnZXN0UHJpbWVGYWN0b3Iobikge1xuICBsZXQgZmFjdG9yID0gMjtcbiAgbGV0IGxhcmdlc3QgPSAxO1xuICB3aGlsZSAoZmFjdG9yICogZmFjdG9yIDw9IG4pIHtcbiAgICBpZiAobiAlIGZhY3RvciA9PT0gMCkge1xuICAgICAgbGFyZ2VzdCA9IGZhY3RvcjtcbiAgICAgIG4gPSBuIC8gZmFjdG9yO1xuICAgIH0gZWxzZSB7XG4gICAgICBmYWN0b3IrKztcbiAgICB9XG4gIH1cbiAgLy8gV2hhdGV2ZXIncyBsZWZ0IG9mIG4gYWZ0ZXIgdGhlIGxvb3AgaXMgYWxzbyBhIHByaW1lIGZhY3Rvci5cbiAgLy8gKEVpdGhlciBuIGlzIDEsIG1lYW5pbmcgdGhlIGlucHV0IHdhcyAxIGFuZCB0aGVyZSBhcmUgbm9cbiAgLy8gcHJpbWUgZmFjdG9ycyDigJQgdGhlIGdhbWUgd29uJ3QgZ2VuZXJhdGUgdGhhdCwgYnV0IGJlIHNhZmUg4oCUXG4gIC8vIG9yIG4gaXRzZWxmIGlzIHRoZSBsYXJnZXN0IHByaW1lIGZhY3RvciA+IHNxcnQob3JpZ2luYWwpLilcbiAgaWYgKG4gPiAxKSBsYXJnZXN0ID0gbjtcbiAgcmV0dXJuIGxhcmdlc3Q7XG59XG5cbmZ1bmN0aW9uIGlzUHJpbWUobikge1xuICBpZiAobiA8IDIpIHJldHVybiBmYWxzZTtcbiAgaWYgKG4gPCA0KSByZXR1cm4gdHJ1ZTsgIC8vIDIsIDNcbiAgaWYgKG4gJSAyID09PSAwKSByZXR1cm4gZmFsc2U7XG4gIGZvciAobGV0IGkgPSAzOyBpICogaSA8PSBuOyBpICs9IDIpIHtcbiAgICBpZiAobiAlIGkgPT09IDApIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY291bnRQcmltZXMobG93LCBoaWdoKSB7XG4gIC8vIENvdW50IHByaW1lcyBpbiBbbG93LCBoaWdoXSBpbmNsdXNpdmUuIFRoZSBnYW1lIGdlbmVyYXRlc1xuICAvLyByYW5nZXMgdGhhdCBhcmUgdHJhY3RhYmxlIGZvciBhIG5haXZlIHNxcnQgc2lldmUgYXQgdGhpc1xuICAvLyBzY2FsZTsgaWYgcmFuZ2VzIGdldCBiaWdnZXIgdGhhbiB+MTBeNiB3ZSBjYW4gc3dhcCBpbiBhIHRydWVcbiAgLy8gc2lldmUgYnV0IEkgaGF2ZW4ndCBzZWVuIG9uZSBpbiBwcmFjdGljZS5cbiAgbGV0IGNvdW50ID0gMDtcbiAgZm9yIChsZXQgaSA9IGxvdzsgaSA8PSBoaWdoOyBpKyspIGlmIChpc1ByaW1lKGkpKSBjb3VudCsrO1xuICByZXR1cm4gY291bnQ7XG59XG5cbi8vIC0tLSBhcnJheSAvIERQIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vLyBcIlN1YmFycmF5IHdpdGggTWF4aW11bSBTdW1cIjogZ2l2ZW4gYW4gYXJyYXkgb2YgbnVtYmVycyAod2hpY2hcbi8vIG1heSBpbmNsdWRlIG5lZ2F0aXZlcyksIGZpbmQgdGhlIGNvbnRpZ3VvdXMgc3ViYXJyYXkgd2l0aCB0aGVcbi8vIGxhcmdlc3Qgc3VtLiBDbGFzc2ljIEthZGFuZSdzIGFsZ29yaXRobS5cbmZ1bmN0aW9uIG1heFN1YmFycmF5U3VtKGFycikge1xuICBpZiAoYXJyLmxlbmd0aCA9PT0gMCkgcmV0dXJuIDA7XG4gIGxldCBiZXN0ID0gYXJyWzBdO1xuICBsZXQgY3VycmVudCA9IGFyclswXTtcbiAgZm9yIChsZXQgaSA9IDE7IGkgPCBhcnIubGVuZ3RoOyBpKyspIHtcbiAgICBjdXJyZW50ID0gTWF0aC5tYXgoYXJyW2ldLCBjdXJyZW50ICsgYXJyW2ldKTtcbiAgICBiZXN0ID0gTWF0aC5tYXgoYmVzdCwgY3VycmVudCk7XG4gIH1cbiAgcmV0dXJuIGJlc3Q7XG59XG5cbi8vIFwiQXJyYXkgSnVtcGluZyBHYW1lXCI6IGdpdmVuIGFuIGFycmF5IG9mIHBvc2l0aXZlIGludGVnZXJzLCBjYW5cbi8vIHlvdSBzdGFydCBhdCBpbmRleCAwIGFuZCByZWFjaCAob3IgcGFzcykgdGhlIGxhc3QgaW5kZXg/IEVhY2hcbi8vIGVsZW1lbnQgYVtpXSBpcyB0aGUgbWF4IGp1bXAgbGVuZ3RoIGZyb20gaS4gUmV0dXJuIDEgaWYgeWVzLFxuLy8gMCBpZiBuby4gVmVyYmF0aW0gZnJvbSBiaXRidXJuZXItc3JjIGdldEFuc3dlcihJKTogdGhlIGxvb3Bcbi8vIGV4aXRzIGF0IGluZGV4IGkgd2hlcmUgaSA+IHJlYWNoIChvciBpID09IG4pLiBUaGUgY2hlY2tcbi8vIGBpID09PSBuYCBpcyBcInJlYWNoZWQgdGhlIGxhc3QgaW5kZXggZXhhY3RseVwiIOKAlCBpZiBpIDwgbiBidXRcbi8vIGkgPiByZWFjaCwgdGhlIGFuc3dlciBpcyAwLlxuZnVuY3Rpb24gYXJyYXlKdW1waW5nR2FtZShhcnIpIHtcbiAgY29uc3QgbiA9IGFyci5sZW5ndGg7XG4gIGxldCBpID0gMDtcbiAgZm9yIChsZXQgcmVhY2ggPSAwOyBpIDwgbiAmJiBpIDw9IHJlYWNoOyBpKyspIHtcbiAgICByZWFjaCA9IE1hdGgubWF4KGkgKyBhcnJbaV0sIHJlYWNoKTtcbiAgfVxuICByZXR1cm4gaSA9PT0gbiA/IDEgOiAwO1xufVxuXG4vLyBcIkFycmF5IEp1bXBpbmcgR2FtZSBJSVwiOiBzYW1lIGFzIGFib3ZlLCBidXQgcmV0dXJuIHRoZSBNSU5cbi8vIG51bWJlciBvZiBqdW1wcyB0byByZWFjaCB0aGUgbGFzdCBpbmRleC4gMCBpZiB1bnJlYWNoYWJsZS5cbi8vIFZlcmJhdGltIGZyb20gYml0YnVybmVyLXNyYyBnZXRBbnN3ZXIoSUkpOiBhdCBlYWNoIHN0ZXAsIHNjYW5cbi8vIHBvc2l0aW9ucyBpbiAobGFzdEp1bXAsIHJlYWNoXSBhbmQgcGljayB0aGUgb25lIHRoYXQgZXh0ZW5kc1xuLy8gcmVhY2ggZnVydGhlc3QuIFRoaXMgaXMgb3B0aW1hbCBmb3IgdGhlIFwibWluIGp1bXBzXCIgcHJvYmxlbVxuLy8gYmVjYXVzZSB0aGUgY2hvaWNlIG9ubHkgZGVwZW5kcyBvbiB0aGUgZmFydGhlc3QgeW91IGNhbiBnZXRcbi8vIGZyb20gYSB3aW5kb3cuXG5mdW5jdGlvbiBhcnJheUp1bXBpbmdHYW1lSUkoYXJyKSB7XG4gIGNvbnN0IG4gPSBhcnIubGVuZ3RoO1xuICBsZXQgcmVhY2ggPSAwO1xuICBsZXQganVtcHMgPSAwO1xuICBsZXQgbGFzdEp1bXAgPSAtMTtcbiAgd2hpbGUgKHJlYWNoIDwgbiAtIDEpIHtcbiAgICBsZXQganVtcGVkRnJvbSA9IC0xO1xuICAgIGZvciAobGV0IGkgPSByZWFjaDsgaSA+IGxhc3RKdW1wOyBpLS0pIHtcbiAgICAgIGlmIChpICsgYXJyW2ldID4gcmVhY2gpIHtcbiAgICAgICAgcmVhY2ggPSBpICsgYXJyW2ldO1xuICAgICAgICBqdW1wZWRGcm9tID0gaTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGp1bXBlZEZyb20gPT09IC0xKSB7XG4gICAgICBqdW1wcyA9IDA7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgbGFzdEp1bXAgPSBqdW1wZWRGcm9tO1xuICAgIGp1bXBzKys7XG4gIH1cbiAgcmV0dXJuIGp1bXBzO1xufVxuXG4vLyBcIlRvdGFsIFdheXMgdG8gU3VtXCI6IGhvdyBtYW55IHBhcnRpdGlvbnMgb2YgbiBhcyBhIHN1bSBvZlxuLy8gcG9zaXRpdmUgaW50ZWdlcnMgKG9yZGVyIGRvZXNuJ3QgbWF0dGVyKT8gVmVyYmF0aW0gZnJvbVxuLy8gYml0YnVybmVyLXNyYy9zcmMvQ29kaW5nQ29udHJhY3QvY29udHJhY3RzL1RvdGFsV2F5c1RvU3VtLnRzXG4vLyBnZXRBbnN3ZXIoSSkuIHdheXNbMF09MSAoZW1wdHkgc3VtIGlzIG9uZSB3YXkgdG8gc3VtIDApO1xuLy8gZm9yIGkgPSAxLi5uLTEsIGZvciBqID0gaS4ubiwgd2F5c1tqXSArPSB3YXlzW2otaV0uIFJldHVyblxuLy8gd2F5c1tuXSAod2hpY2ggY291bnRzIHBhcnRpdGlvbnMgb2YgbiBXSVRIT1VUIHRoZSB0cml2aWFsXG4vLyBbbl0gcGFydGl0aW9uIOKAlCB0aGUgZ2FtZSdzIGRlc2Mgc2F5cyBcInN1bSBvZiBhdCBsZWFzdCB0d29cbi8vIHBvc2l0aXZlIGludGVnZXJzXCIpLiBUaGUgZ2FtZSB0aGVuIGFza3MgdGhlIHBsYXllciB0b1xuLy8gcHJvZHVjZSB0aGlzIG51bWJlcjsgZ2V0QW5zd2VyIHJldHVybnMgd2F5c1tuXSB3aGljaCB0aGVcbi8vIHZlcmlmaWVyIGFjY2VwdHMuXG5mdW5jdGlvbiB0b3RhbFdheXNUb1N1bShuKSB7XG4gIGNvbnN0IHdheXMgPSBuZXcgQXJyYXkobiArIDEpLmZpbGwoMCk7XG4gIHdheXNbMF0gPSAxO1xuICBmb3IgKGxldCBpID0gMTsgaSA8IG47IGkrKykge1xuICAgIGZvciAobGV0IGogPSBpOyBqIDw9IG47IGorKykgd2F5c1tqXSArPSB3YXlzW2ogLSBpXTtcbiAgfVxuICByZXR1cm4gd2F5c1tuXTtcbn1cblxuLy8gXCJUb3RhbCBXYXlzIHRvIFN1bSBJSVwiOiBsaWtlIGFib3ZlLCBidXQgdXNpbmcgb25seSB0aGUgZ2l2ZW5cbi8vIHN1bW1hbmQgc2V0LiBTdGFuZGFyZCB1bmJvdW5kZWQgY29pbi1jaGFuZ2UgRFAuIFZlcmJhdGltXG4vLyBmcm9tIHRoZSBnYW1lIHNvdXJjZS5cbmZ1bmN0aW9uIHRvdGFsV2F5c1RvU3VtSUkobiwgc3VtbWFuZHMpIHtcbiAgY29uc3Qgd2F5cyA9IG5ldyBBcnJheShuICsgMSkuZmlsbCgwKTtcbiAgd2F5c1swXSA9IDE7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc3VtbWFuZHMubGVuZ3RoOyBpKyspIHtcbiAgICBmb3IgKGxldCBqID0gc3VtbWFuZHNbaV07IGogPD0gbjsgaisrKSB3YXlzW2pdICs9IHdheXNbaiAtIHN1bW1hbmRzW2ldXTtcbiAgfVxuICByZXR1cm4gd2F5c1tuXTtcbn1cblxuLy8gLS0tIGdyaWQgLyBtYXRyaXggLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8vIFwiU3BpcmFsaXplIE1hdHJpeFwiOiByZXR1cm4gdGhlIG1hdHJpeCBpbiBjbG9ja3dpc2Ugc3BpcmFsXG4vLyBvcmRlciwgdG9wIHRvIGJvdHRvbSwgbGVmdCB0byByaWdodC5cbmZ1bmN0aW9uIHNwaXJhbGl6ZU1hdHJpeChtKSB7XG4gIGlmIChtLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xuICBjb25zdCBvdXQgPSBbXTtcbiAgbGV0IHRvcCA9IDAsIGJvdHRvbSA9IG0ubGVuZ3RoIC0gMSwgbGVmdCA9IDAsIHJpZ2h0ID0gbVswXS5sZW5ndGggLSAxO1xuICB3aGlsZSAodG9wIDw9IGJvdHRvbSAmJiBsZWZ0IDw9IHJpZ2h0KSB7XG4gICAgZm9yIChsZXQgYyA9IGxlZnQ7IGMgPD0gcmlnaHQ7IGMrKykgb3V0LnB1c2gobVt0b3BdW2NdKTtcbiAgICB0b3ArKztcbiAgICBmb3IgKGxldCByID0gdG9wOyByIDw9IGJvdHRvbTsgcisrKSBvdXQucHVzaChtW3JdW3JpZ2h0XSk7XG4gICAgcmlnaHQtLTtcbiAgICBpZiAodG9wIDw9IGJvdHRvbSkge1xuICAgICAgZm9yIChsZXQgYyA9IHJpZ2h0OyBjID49IGxlZnQ7IGMtLSkgb3V0LnB1c2gobVtib3R0b21dW2NdKTtcbiAgICAgIGJvdHRvbS0tO1xuICAgIH1cbiAgICBpZiAobGVmdCA8PSByaWdodCkge1xuICAgICAgZm9yIChsZXQgciA9IGJvdHRvbTsgciA+PSB0b3A7IHItLSkgb3V0LnB1c2gobVtyXVtsZWZ0XSk7XG4gICAgICBsZWZ0Kys7XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8vIFwiTWluaW11bSBQYXRoIFN1bSBpbiBhIFRyaWFuZ2xlXCI6IGRhdGEgaXMgYSB0cmlhbmdsZSAoYXJyYXlcbi8vIG9mIGFycmF5cywgcm93IDAgaGFzIDEgZWxlbWVudCwgcm93IDEgaGFzIDIsIGV0Yy4pLiBSZXR1cm4gdGhlXG4vLyBtaW5pbXVtIHN1bSBmcm9tIHRvcCB0byBib3R0b20sIG1vdmluZyBvbmx5IHRvIGFkamFjZW50XG4vLyBlbGVtZW50cyBpbiB0aGUgcm93IGJlbG93LlxuZnVuY3Rpb24gbWluUGF0aFRyaWFuZ2xlKHRyaWFuZ2xlKSB7XG4gIC8vIEJvdHRvbS11cDogYXQgZWFjaCByb3csIHJlcGxhY2UgZWFjaCBjZWxsIHdpdGggdGhlIGNlbGxcbiAgLy8gdmFsdWUgKyB0aGUgc21hbGxlciBvZiBpdHMgdHdvIHBhcmVudHMuIEFmdGVyIHByb2Nlc3NpbmdcbiAgLy8gdGhlIGJvdHRvbSByb3csIHRoZSBhbnN3ZXIgaXMgbWluKHJvdykuXG4gIGNvbnN0IGRwID0gdHJpYW5nbGVbdHJpYW5nbGUubGVuZ3RoIC0gMV0uc2xpY2UoKTtcbiAgZm9yIChsZXQgciA9IHRyaWFuZ2xlLmxlbmd0aCAtIDI7IHIgPj0gMDsgci0tKSB7XG4gICAgZm9yIChsZXQgYyA9IDA7IGMgPCB0cmlhbmdsZVtyXS5sZW5ndGg7IGMrKykge1xuICAgICAgZHBbY10gPSB0cmlhbmdsZVtyXVtjXSArIE1hdGgubWluKGRwW2NdLCBkcFtjICsgMV0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZHBbMF07XG59XG5cbi8vIFwiVW5pcXVlIFBhdGhzIGluIGEgR3JpZCBJXCI6IGZyb20gdG9wLWxlZnQgb2YgYW4gW20sIG5dIGdyaWRcbi8vIHRvIGJvdHRvbS1yaWdodCwgbW92aW5nIG9ubHkgcmlnaHQgb3IgZG93bi4gQ29tYmluYXRvcmlhbFxuLy8gYW5zd2VyOiBDKG0rbi0yLCBtLTEpLiBVc2UgbXVsdGlwbGljYXRpdmUgZm9ybXVsYSB0byBhdm9pZFxuLy8gbGFyZ2UtZmFjdG9yaWFsIG92ZXJmbG93LlxuZnVuY3Rpb24gdW5pcXVlUGF0aHNJKG0sIG4pIHtcbiAgbGV0IHJlc3VsdCA9IDE7XG4gIGZvciAobGV0IGkgPSAxOyBpIDw9IG0gLSAxOyBpKyspIHtcbiAgICByZXN1bHQgPSAocmVzdWx0ICogKG4gLSAxICsgaSkpIC8gaTtcbiAgfVxuICByZXR1cm4gTWF0aC5yb3VuZChyZXN1bHQpO1xufVxuXG4vLyBcIlVuaXF1ZSBQYXRocyBpbiBhIEdyaWQgSUlcIjogc2FtZSBhcyBJIGJ1dCBzb21lIGNlbGxzIGFyZVxuLy8gb2JzdGFjbGVzICgxID0gb2JzdGFjbGUsIDAgPSBmcmVlKS4gRFAgZnJvbSB0b3AtbGVmdC5cbmZ1bmN0aW9uIHVuaXF1ZVBhdGhzSUkoZ3JpZCkge1xuICBpZiAoZ3JpZC5sZW5ndGggPT09IDAgfHwgZ3JpZFswXS5sZW5ndGggPT09IDApIHJldHVybiAwO1xuICBpZiAoZ3JpZFswXVswXSA9PT0gMSkgcmV0dXJuIDA7XG4gIGNvbnN0IG0gPSBncmlkLmxlbmd0aDtcbiAgY29uc3QgbiA9IGdyaWRbMF0ubGVuZ3RoO1xuICBjb25zdCBkcCA9IEFycmF5LmZyb20oeyBsZW5ndGg6IG0gfSwgKCkgPT4gbmV3IEFycmF5KG4pLmZpbGwoMCkpO1xuICBkcFswXVswXSA9IDE7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbTsgaSsrKSB7XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCBuOyBqKyspIHtcbiAgICAgIGlmIChncmlkW2ldW2pdID09PSAxKSB7IGRwW2ldW2pdID0gMDsgY29udGludWU7IH1cbiAgICAgIGlmIChpID4gMCkgZHBbaV1bal0gKz0gZHBbaSAtIDFdW2pdO1xuICAgICAgaWYgKGogPiAwKSBkcFtpXVtqXSArPSBkcFtpXVtqIC0gMV07XG4gICAgfVxuICB9XG4gIHJldHVybiBkcFttIC0gMV1bbiAtIDFdO1xufVxuXG4vLyBcIlNob3J0ZXN0IFBhdGggaW4gYSBHcmlkXCI6IGxpa2UgVW5pcXVlIFBhdGhzIElJLCBidXQgdGhlXG4vLyBhbnN3ZXIgaXMgdGhlIHBhdGggaXRzZWxmIGFzIGEgc3RyaW5nIG9mIFwiVS9EL0wvUlwiIGNoYXJhY3RlcnMuXG4vLyBJZiBubyBwYXRoIGV4aXN0cywgcmV0dXJuIFwiXCIgKGVtcHR5IHN0cmluZykuXG5mdW5jdGlvbiBzaG9ydGVzdFBhdGhHcmlkKGdyaWQpIHtcbiAgaWYgKGdyaWQubGVuZ3RoID09PSAwIHx8IGdyaWRbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gXCJcIjtcbiAgaWYgKGdyaWRbMF1bMF0gPT09IDEpIHJldHVybiBcIlwiO1xuICBjb25zdCBtID0gZ3JpZC5sZW5ndGg7XG4gIGNvbnN0IG4gPSBncmlkWzBdLmxlbmd0aDtcbiAgLy8gQkZTIGZyb20gKDAsMCkuIEVhY2ggY2VsbCByZWNvcmRzIHRoZSBtb3ZlcyB0YWtlbiB0byByZWFjaFxuICAvLyBpdC4gV2UgdXNlIGEgc2luZ2xlICd2aXNpdGVkJyBzZXQga2V5ZWQgYnkgXCJyLGNcIiDigJQgd2VcbiAgLy8gY291bGQgcmVjb3JkIHNob3J0ZXN0IGRpc3RhbmNlcyBidXQgQkZTIGd1YXJhbnRlZXMgdGhlXG4gIC8vIGZpcnN0IHZpc2l0IElTIHRoZSBzaG9ydGVzdCBwYXRoIGZvciB1bndlaWdodGVkIGdyYXBocy5cbiAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQoKTtcbiAgY29uc3QgcXVldWUgPSBbeyByOiAwLCBjOiAwLCBwYXRoOiBcIlwiIH1dO1xuICB2aXNpdGVkLmFkZChcIjAsMFwiKTtcbiAgY29uc3QgZGlycyA9IFtcbiAgICB7IGRyOiAtMSwgZGM6IDAsIGNoOiBcIlVcIiB9LFxuICAgIHsgZHI6IDEsIGRjOiAwLCBjaDogXCJEXCIgfSxcbiAgICB7IGRyOiAwLCBkYzogLTEsIGNoOiBcIkxcIiB9LFxuICAgIHsgZHI6IDAsIGRjOiAxLCBjaDogXCJSXCIgfSxcbiAgXTtcbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBjdXIgPSBxdWV1ZS5zaGlmdCgpO1xuICAgIGlmIChjdXIuciA9PT0gbSAtIDEgJiYgY3VyLmMgPT09IG4gLSAxKSByZXR1cm4gY3VyLnBhdGg7XG4gICAgZm9yIChjb25zdCBkIG9mIGRpcnMpIHtcbiAgICAgIGNvbnN0IG5yID0gY3VyLnIgKyBkLmRyO1xuICAgICAgY29uc3QgbmMgPSBjdXIuYyArIGQuZGM7XG4gICAgICBpZiAobnIgPCAwIHx8IG5yID49IG0gfHwgbmMgPCAwIHx8IG5jID49IG4pIGNvbnRpbnVlO1xuICAgICAgaWYgKGdyaWRbbnJdW25jXSA9PT0gMSkgY29udGludWU7XG4gICAgICBjb25zdCBrZXkgPSBgJHtucn0sJHtuY31gO1xuICAgICAgaWYgKHZpc2l0ZWQuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgdmlzaXRlZC5hZGQoa2V5KTtcbiAgICAgIHF1ZXVlLnB1c2goeyByOiBuciwgYzogbmMsIHBhdGg6IGN1ci5wYXRoICsgZC5jaCB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFwiXCI7XG59XG5cbi8vIFwiTGFyZ2VzdCBSZWN0YW5nbGUgaW4gYSBNYXRyaXhcIjogZGVzcGl0ZSB0aGUgbmFtZSwgdGhpc1xuLy8gY29udHJhY3QgYXNrcyBmb3IgdGhlIGxhcmdlc3QgYWxsLTBzIHJlY3RhbmdsZSAodGhlIGRlc2Ncbi8vIGV4cGxpY2l0bHkgc2F5cyBcImRvZXMgbm90IGNvbnRhaW4gYW55IDFzXCIg4oCUIHNlZVxuLy8gYml0YnVybmVyLXNyYy9zcmMvQ29kaW5nQ29udHJhY3QvY29udHJhY3RzL0xhcmdlc3RSZWN0YW5nbGUudHMpLlxuLy8gUmV0dXJucyBbW3IxLGMxXSxbcjIsYzJdXSBpbiBtYXRyaXggY29vcmRpbmF0ZXMuXG4vL1xuLy8gQWxnb3JpdGhtICh2ZXJiYXRpbSBmcm9tIHRoZSBnYW1lIHNvdXJjZSk6IGJ1aWxkIGFcbi8vIGNvbHVtbi13aXNlIGhpc3RvZ3JhbSBvZiBjb25zZWN1dGl2ZSAwcywgdGhlbiBmb3IgZWFjaCBjZWxsXG4vLyAoaSwgaikgd2l0aCBoaXN0b2dyYW1baV1bal0gPiAwLCBleHBhbmQgbGVmdCBhbmQgcmlnaHQgYXNcbi8vIGxvbmcgYXMgcm93W2ldW2tdID49IHJvd1tpXVtqXS4gVGhhdCBnaXZlcyB0aGUgbGFyZ2VzdCByZWN0XG4vLyBvZiB6ZXJvcyB3aG9zZSBib3R0b20tcmlnaHQgY29ybmVyIGlzIChpLCBqKSBhbmQgd2hvc2Ugcm93XG4vLyByYW5nZSBpcyByb3dbaV1bal0gcm93cyB0YWxsLiBUcmFjayB0aGUgbWF4IGFyZWEuXG5mdW5jdGlvbiBsYXJnZXN0UmVjdGFuZ2xlTWF0cml4KGdyaWQpIHtcbiAgY29uc3QgbnVtUm93cyA9IGdyaWQubGVuZ3RoO1xuICBjb25zdCBudW1Db2xzID0gZ3JpZFswXS5sZW5ndGg7XG4gIC8vIGhpc3RvZ3JhbXNbcl1bY10gPSBudW1iZXIgb2YgY29uc2VjdXRpdmUgMHMgZW5kaW5nIGF0IHJvdyByLFxuICAvLyBjb2x1bW4gYyAoaS5lLiBjb3VudCBvZiAwcyBmcm9tIHJvdyByLWhpc3QrMSAuLiByIGluIGNvbCBjKS5cbiAgY29uc3QgaGlzdG9ncmFtcyA9IEFycmF5LmZyb20oeyBsZW5ndGg6IG51bVJvd3MgfSwgKCkgPT4gbmV3IEFycmF5KG51bUNvbHMpLmZpbGwoMCkpO1xuICBmb3IgKGxldCBjID0gMDsgYyA8IG51bUNvbHM7IGMrKykge1xuICAgIGxldCBjb3VudCA9IDA7XG4gICAgZm9yIChsZXQgciA9IDA7IHIgPCBudW1Sb3dzOyByKyspIHtcbiAgICAgIGlmIChncmlkW3JdW2NdID09PSAwKSBjb3VudCsrO1xuICAgICAgZWxzZSBjb3VudCA9IDA7XG4gICAgICBoaXN0b2dyYW1zW3JdW2NdID0gY291bnQ7XG4gICAgfVxuICB9XG4gIGxldCBtYXhBcmVhID0gMDtcbiAgbGV0IG1heEwgPSAwLCBtYXhSID0gMCwgbWF4VSA9IDAsIG1heEQgPSAwO1xuICBmb3IgKGxldCByID0gMDsgciA8IG51bVJvd3M7IHIrKykge1xuICAgIGNvbnN0IHJvdyA9IGhpc3RvZ3JhbXNbcl07XG4gICAgZm9yIChsZXQgYyA9IDA7IGMgPCBudW1Db2xzOyBjKyspIHtcbiAgICAgIGlmIChyb3dbY10gPT09IDApIGNvbnRpbnVlO1xuICAgICAgbGV0IGxlZnQgPSBjO1xuICAgICAgbGV0IHJpZ2h0ID0gYztcbiAgICAgIHdoaWxlIChyb3dbbGVmdCAtIDFdID49IHJvd1tjXSkgbGVmdC0tO1xuICAgICAgd2hpbGUgKHJvd1tyaWdodCArIDFdID49IHJvd1tjXSkgcmlnaHQrKztcbiAgICAgIGNvbnN0IGFyZWEgPSAocmlnaHQgLSBsZWZ0ICsgMSkgKiByb3dbY107XG4gICAgICBpZiAoYXJlYSA+IG1heEFyZWEpIHtcbiAgICAgICAgbWF4QXJlYSA9IGFyZWE7XG4gICAgICAgIG1heEwgPSBsZWZ0O1xuICAgICAgICBtYXhSID0gcmlnaHQ7XG4gICAgICAgIG1heFUgPSByIC0gcm93W2NdICsgMTtcbiAgICAgICAgbWF4RCA9IHI7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIHJldHVybiBbW21heFUsIG1heExdLCBbbWF4RCwgbWF4Ul1dO1xufVxuXG4vLyAtLS0gc3RyaW5ncyAvIGVuY29kaW5ncyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLy8gXCJNZXJnZSBPdmVybGFwcGluZyBJbnRlcnZhbHNcIjogZGF0YSBpcyBhbiBhcnJheSBvZiBbbG8sIGhpXVxuLy8gcGFpcnMuIFJldHVybiBhIG5ldyBhcnJheSB3aXRoIG92ZXJsYXBwaW5nIGludGVydmFscyBtZXJnZWQsXG4vLyBzb3J0ZWQgYnkgbG8uXG5mdW5jdGlvbiBtZXJnZUludGVydmFscyhpbnRlcnZhbHMpIHtcbiAgaWYgKGludGVydmFscy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgY29uc3Qgc29ydGVkID0gaW50ZXJ2YWxzLnNsaWNlKCkuc29ydCgoYSwgYikgPT4gYVswXSAtIGJbMF0pO1xuICBjb25zdCBvdXQgPSBbc29ydGVkWzBdLnNsaWNlKCldO1xuICBmb3IgKGxldCBpID0gMTsgaSA8IHNvcnRlZC5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRvcCA9IG91dFtvdXQubGVuZ3RoIC0gMV07XG4gICAgaWYgKHNvcnRlZFtpXVswXSA8PSB0b3BbMV0pIHtcbiAgICAgIHRvcFsxXSA9IE1hdGgubWF4KHRvcFsxXSwgc29ydGVkW2ldWzFdKTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0LnB1c2goc29ydGVkW2ldLnNsaWNlKCkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vLyBcIkdlbmVyYXRlIElQIEFkZHJlc3Nlc1wiOiBnaXZlbiBhIHN0cmluZyBvZiBkaWdpdHMsIHJldHVyblxuLy8gZXZlcnkgdmFsaWQgSVB2NCBhZGRyZXNzIHlvdSBjYW4gZm9ybSBieSBpbnNlcnRpbmcgdGhyZWUgZG90cy5cbi8vIEJhY2t0cmFja2luZzogYXQgZWFjaCBzdGVwLCB0YWtlIDEtMyBkaWdpdHM7IGlmIHRoZXkgZm9ybSBhXG4vLyB2YWxpZCBvY3RldCAoMC0yNTUsIG5vIGxlYWRpbmcgemVyb3MgZXhjZXB0IFwiMFwiIGl0c2VsZiksIHJlY3Vyc2UuXG5mdW5jdGlvbiBnZW5lcmF0ZUlQQWRkcmVzc2VzKHMpIHtcbiAgY29uc3Qgb3V0ID0gW107XG4gIGZ1bmN0aW9uIHJlY3Vyc2UocHJlZml4LCByZW1haW5pbmcpIHtcbiAgICBpZiAocHJlZml4Lmxlbmd0aCA9PT0gNCkge1xuICAgICAgaWYgKHJlbWFpbmluZy5sZW5ndGggPT09IDApIG91dC5wdXNoKHByZWZpeC5qb2luKFwiLlwiKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAobGV0IGxlbiA9IDE7IGxlbiA8PSBNYXRoLm1pbigzLCByZW1haW5pbmcubGVuZ3RoKTsgbGVuKyspIHtcbiAgICAgIGNvbnN0IG9jdGV0ID0gcmVtYWluaW5nLnNsaWNlKDAsIGxlbik7XG4gICAgICBpZiAob2N0ZXQubGVuZ3RoID4gMSAmJiBvY3RldFswXSA9PT0gXCIwXCIpIGJyZWFrOyAgLy8gbm8gbGVhZGluZyB6ZXJvXG4gICAgICBjb25zdCB2YWwgPSBOdW1iZXIob2N0ZXQpO1xuICAgICAgaWYgKHZhbCA+IDI1NSkgYnJlYWs7XG4gICAgICBwcmVmaXgucHVzaChvY3RldCk7XG4gICAgICByZWN1cnNlKHByZWZpeCwgcmVtYWluaW5nLnNsaWNlKGxlbikpO1xuICAgICAgcHJlZml4LnBvcCgpO1xuICAgIH1cbiAgfVxuICByZWN1cnNlKFtdLCBzKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLy8gXCJTYW5pdGl6ZSBQYXJlbnRoZXNlcyBpbiBFeHByZXNzaW9uXCI6IGdpdmVuIGEgc3RyaW5nIHRoYXRcbi8vIGNvbnRhaW5zIHBhcmVucyB0aGF0IG1heSBiZSB1bm1hdGNoZWQsIHJlbW92ZSB0aGUgTUlOSU1VTVxuLy8gbnVtYmVyIG9mIGNoYXJhY3RlcnMgdG8gbWFrZSBpdCB2YWxpZC4gUmV0dXJuIEFMTCBzdWNoXG4vLyBzYW5pdGl6ZWQgc3RyaW5ncyAobXVsdGlwbGUgbWF5IGV4aXN0KS4gQkZTIG92ZXIgcmVtb3ZhbFxuLy8gY2hvaWNlcywgdHJhY2tpbmcgd2hpY2ggc3RyaW5ncyBoYXZlIGJlZW4gc2VlbiwgY29sbGVjdGluZ1xuLy8gdmFsaWQgcmVzdWx0cyBhdCB0aGUgZGVwdGggd2hlcmUgd2UgZmlyc3QgZmluZCBhbnkuXG5mdW5jdGlvbiBzYW5pdGl6ZVBhcmVudGhlc2VzKHMpIHtcbiAgLy8gU3RlcCAxOiBmaWd1cmUgb3V0IGhvdyBtYW55IHJlbW92YWxzIGFyZSBuZWVkZWQuXG4gIC8vIFdhbGsgdGhlIHN0cmluZzsgdHJhY2sgYSBjb3VudGVyLiArMSBmb3IgJygnLCAtMSBmb3IgJyknLlxuICAvLyBUaGUgbnVtYmVyIG9mIHVubWF0Y2hlZCAnKScgaXMgdGhlIGNvdW50IG9mIHRpbWVzIHRoZVxuICAvLyBjb3VudGVyIHdlbnQgbmVnYXRpdmUgKHdlJ2xsIHRyYWNrIHRoZXNlKS4gVGhlIG51bWJlciBvZlxuICAvLyB1bm1hdGNoZWQgJygnIGlzIHRoZSBmaW5hbCB2YWx1ZSBvZiB0aGUgY291bnRlci5cbiAgY29uc3Qgc3RhY2sgPSBbXTtcbiAgY29uc3QgcmVzdWx0ID0gbmV3IFNldCgpO1xuICBsZXQgcXVldWUgPSBbc107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0KFtzXSk7XG4gIC8vIFN0YW5kYXJkIEJGUyBhcHByb2FjaCAoY29tbXVuaXR5IHNvbHV0aW9uKS5cbiAgZnVuY3Rpb24gaXNWYWxpZChzdHIpIHtcbiAgICBsZXQgY291bnQgPSAwO1xuICAgIGZvciAoY29uc3QgY2ggb2Ygc3RyKSB7XG4gICAgICBpZiAoY2ggPT09IFwiKFwiKSBjb3VudCsrO1xuICAgICAgZWxzZSBpZiAoY2ggPT09IFwiKVwiKSB7XG4gICAgICAgIGNvdW50LS07XG4gICAgICAgIGlmIChjb3VudCA8IDApIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGNvdW50ID09PSAwO1xuICB9XG4gIC8vIEJGUyBvdmVyIHJlbW92YWwgbGV2ZWxzIHVudGlsIHdlIGZpbmQgYSBsZXZlbCB3aXRoIGF0XG4gIC8vIGxlYXN0IG9uZSB2YWxpZCBzdHJpbmc7IHJldHVybiBhbGwgdmFsaWQgc3RyaW5ncyBhdCB0aGF0XG4gIC8vIGxldmVsLiBJZiB0aGUgaW5wdXQgaXMgYWxyZWFkeSB2YWxpZCwgcmV0dXJuIFtzXS5cbiAgaWYgKGlzVmFsaWQocykpIHJldHVybiBbc107XG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgbmV4dCA9IFtdO1xuICAgIGZvciAoY29uc3Qgc3RyIG9mIHF1ZXVlKSB7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHN0ci5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAoc3RyW2ldICE9PSBcIihcIiAmJiBzdHJbaV0gIT09IFwiKVwiKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgY2FuZCA9IHN0ci5zbGljZSgwLCBpKSArIHN0ci5zbGljZShpICsgMSk7XG4gICAgICAgIGlmIChzZWVuLmhhcyhjYW5kKSkgY29udGludWU7XG4gICAgICAgIHNlZW4uYWRkKGNhbmQpO1xuICAgICAgICBpZiAoaXNWYWxpZChjYW5kKSkge1xuICAgICAgICAgIHJlc3VsdC5hZGQoY2FuZCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbmV4dC5wdXNoKGNhbmQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZXN1bHQuc2l6ZSA+IDApIHJldHVybiBbLi4ucmVzdWx0XTtcbiAgICBxdWV1ZSA9IG5leHQ7XG4gIH1cbiAgcmV0dXJuIFsuLi5yZXN1bHRdO1xufVxuXG4vLyBcIkZpbmQgQWxsIFZhbGlkIE1hdGggRXhwcmVzc2lvbnNcIjogZ2l2ZW4gYSBzdHJpbmcgb2YgZGlnaXRzXG4vLyBhbmQgYSB0YXJnZXQgbnVtYmVyLCByZXR1cm4gYWxsIHZhbGlkIGV4cHJlc3Npb25zIGZvcm1lZCBieVxuLy8gaW5zZXJ0aW5nICcrJywgJy0nLCBvciAnKicgYmV0d2VlbiB0aGUgZGlnaXRzIHRoYXQgZXZhbHVhdGVcbi8vIHRvIHRoZSB0YXJnZXQuIE5vIGxlYWRpbmcgemVyb3MgKGEgc2luZ2xlIFwiMFwiIGlzIE9LKS5cbmZ1bmN0aW9uIGZpbmRBbGxWYWxpZE1hdGhFeHByZXNzaW9ucyhkaWdpdHMsIHRhcmdldCkge1xuICBjb25zdCBvdXQgPSBbXTtcbiAgZnVuY3Rpb24gcmVjdXJzZShpZHgsIGV4cHIsIHZhbHVlLCBsYXN0VGVybSkge1xuICAgIC8vIGxhc3RUZXJtID0gdmFsdWUgb2YgdGhlIHJpZ2h0bW9zdCB0ZXJtICh0aGUgb25lIHdlJ2RcbiAgICAvLyBtdWx0aXBseSBpZiB0aGUgbmV4dCBvcCBpcyAnKicpLiBXZSB0cmFjayBpdCBzZXBhcmF0ZWx5XG4gICAgLy8gc28gdGhhdCAxKzIqMyBldmFsdWF0ZXMgdG8gOSwgbm90ICgxKzIpKjMgPSA5IOKAlCBzYW1lXG4gICAgLy8gaGVyZSwgYnV0IGlmIHdlIGhhZCAxKzItMyB0aGUgYm9va2tlZXBpbmcgZ2V0cyB0cmlja3lcbiAgICAvLyB3aXRoICcqJyBiZWNhdXNlIHdlIG5lZWQgdG8gdW5kbyB0aGUgYWRkaXRpb24gYW5kIGFwcGx5XG4gICAgLy8gdGhlIG11bHRpcGxpY2F0aW9uIGluc3RlYWQuXG4gICAgaWYgKGlkeCA9PT0gZGlnaXRzLmxlbmd0aCkge1xuICAgICAgaWYgKHZhbHVlID09PSB0YXJnZXQpIG91dC5wdXNoKGV4cHIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGxldCBsZW4gPSAxOyBsZW4gPD0gZGlnaXRzLmxlbmd0aCAtIGlkeDsgbGVuKyspIHtcbiAgICAgIGNvbnN0IHN1YiA9IGRpZ2l0cy5zbGljZShpZHgsIGlkeCArIGxlbik7XG4gICAgICBpZiAoc3ViLmxlbmd0aCA+IDEgJiYgc3ViWzBdID09PSBcIjBcIikgYnJlYWs7ICAvLyBubyBsZWFkaW5nIHplcm9cbiAgICAgIGNvbnN0IG51bSA9IE51bWJlcihzdWIpO1xuICAgICAgaWYgKGlkeCA9PT0gMCkge1xuICAgICAgICByZWN1cnNlKGlkeCArIGxlbiwgc3ViLCBudW0sIG51bSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWN1cnNlKGlkeCArIGxlbiwgZXhwciArIFwiK1wiICsgc3ViLCB2YWx1ZSArIG51bSwgbnVtKTtcbiAgICAgICAgcmVjdXJzZShpZHggKyBsZW4sIGV4cHIgKyBcIi1cIiArIHN1YiwgdmFsdWUgLSBudW0sIC1udW0pO1xuICAgICAgICAvLyBGb3IgJyonLCB3ZSB1bmRvIHRoZSBwcmV2aW91cyB0ZXJtIGFuZCByZS1hcHBseSBpdFxuICAgICAgICAvLyBtdWx0aXBsaWVkOiB2YWx1ZSAtIGxhc3RUZXJtICsgKGxhc3RUZXJtICogbnVtKS5cbiAgICAgICAgcmVjdXJzZShpZHggKyBsZW4sIGV4cHIgKyBcIipcIiArIHN1YiwgdmFsdWUgLSBsYXN0VGVybSArIGxhc3RUZXJtICogbnVtLCBsYXN0VGVybSAqIG51bSk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIHJlY3Vyc2UoMCwgXCJcIiwgMCwgMCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8vIFwiRW5jcnlwdGlvbiBJOiBDYWVzYXIgQ2lwaGVyXCI6IHNoaWZ0IGV2ZXJ5IGxldHRlciBieSBuICh3cmFwXG4vLyB3aXRoaW4gJ2EnLSd6JyBvciAnQSctJ1onOyBub24tbGV0dGVycyBwYXNzIHRocm91Z2gpLiBUaGVcbi8vIHNoaWZ0IGlzIHJpZ2h0d2FyZCBieSBuIGluIHRoZSBnYW1lOyB0aGUgaW5wdXQgaXNcbi8vIFtwbGFpbnRleHQsIHNoaWZ0XS4gV2UgZG8gdGhlIHNoaWZ0LCByZXR1cm4gdGhlIGNpcGhlcnRleHQuXG5mdW5jdGlvbiBjYWVzYXJDaXBoZXIocGxhaW50ZXh0LCBzaGlmdCkge1xuICBsZXQgb3V0ID0gXCJcIjtcbiAgZm9yIChjb25zdCBjaCBvZiBwbGFpbnRleHQpIHtcbiAgICBjb25zdCBjb2RlID0gY2guY2hhckNvZGVBdCgwKTtcbiAgICBpZiAoY29kZSA+PSA2NSAmJiBjb2RlIDw9IDkwKSB7XG4gICAgICAvLyB1cHBlcmNhc2VcbiAgICAgIG91dCArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKCgoY29kZSAtIDY1ICsgc2hpZnQpICUgMjYgKyAyNikgJSAyNiArIDY1KTtcbiAgICB9IGVsc2UgaWYgKGNvZGUgPj0gOTcgJiYgY29kZSA8PSAxMjIpIHtcbiAgICAgIC8vIGxvd2VyY2FzZVxuICAgICAgb3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoKChjb2RlIC0gOTcgKyBzaGlmdCkgJSAyNiArIDI2KSAlIDI2ICsgOTcpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXQgKz0gY2g7XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8vIFwiRW5jcnlwdGlvbiBJSTogVmlnZW7DqHJlIENpcGhlclwiOiBkYXRhIGlzIFtwbGFpbnRleHQsIGtleV0uXG4vLyBFYWNoIGxldHRlciBvZiBwbGFpbnRleHQgaXMgc2hpZnRlZCBieSB0aGUgY29ycmVzcG9uZGluZ1xuLy8gbGV0dGVyIG9mIGtleSAoQT0wLCBCPTEsIC4uLiwgWj0yNSkuIE5vbi1sZXR0ZXJzIHBhc3Ncbi8vIHRocm91Z2guIFRoZSBLRVkgQ1lDTEVTIHJlZ2FyZGxlc3Mgb2Ygbm9uLWxldHRlcnMgaW4gdGhlXG4vLyBwbGFpbnRleHQgKHNvIFwiQSBCXCIgd2l0aCBrZXkgXCJCXCIgc2hpZnRzIHRoZSBBIGJ5IDEgYW5kIHRoZSBCXG4vLyBieSAyIOKAlCB0aGUga2V5IGluZGV4IG1vdmVzIGJ5IG9uZSBmb3IgZXZlcnkgcGxhaW50ZXh0IGNoYXIsXG4vLyBsZXR0ZXIgb3Igbm90KS5cbmZ1bmN0aW9uIHZpZ2VuZXJlQ2lwaGVyKHBsYWludGV4dCwga2V5KSB7XG4gIGxldCBvdXQgPSBcIlwiO1xuICBsZXQga2kgPSAwO1xuICBmb3IgKGNvbnN0IGNoIG9mIHBsYWludGV4dCkge1xuICAgIGNvbnN0IGNvZGUgPSBjaC5jaGFyQ29kZUF0KDApO1xuICAgIGNvbnN0IHVwcGVyID0gY29kZSA+PSA2NSAmJiBjb2RlIDw9IDkwO1xuICAgIGNvbnN0IGxvd2VyID0gY29kZSA+PSA5NyAmJiBjb2RlIDw9IDEyMjtcbiAgICBpZiAodXBwZXIgfHwgbG93ZXIpIHtcbiAgICAgIGNvbnN0IGJhc2UgPSB1cHBlciA/IDY1IDogOTc7XG4gICAgICBjb25zdCBrID0ga2V5W2tpICUga2V5Lmxlbmd0aF0udG9Mb3dlckNhc2UoKS5jaGFyQ29kZUF0KDApIC0gOTc7XG4gICAgICBvdXQgKz0gU3RyaW5nLmZyb21DaGFyQ29kZSgoKGNvZGUgLSBiYXNlICsgaykgJSAyNiArIDI2KSAlIDI2ICsgYmFzZSk7XG4gICAgICBraSsrO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXQgKz0gY2g7XG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8vIC0tLSBoYW1taW5nIGNvZGVzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gXCJIYW1taW5nIENvZGVzOiBJbnRlZ2VyIHRvIEVuY29kZWQgQmluYXJ5XCI6IHByb2R1Y2UgdGhlXG4vLyBleHRlbmRlZCBIYW1taW5nIGNvZGUgZm9yIHRoZSBpbnB1dCBpbnRlZ2VyLiBUaGUgZ2FtZSB1c2VzXG4vLyB0aGUgSGVkcmF1dGEtc3R5bGUgZW5jb2Rpbmc6IGRhdGEgYml0cyBhbmQgcGFyaXR5IGJpdHMgYXJlXG4vLyBzdG9yZWQgaW4gdGhlIFNBTUUgaW50ZWdlciBwb3NpdGlvbnMgKDEuLm4pLCB3aXRoIHBhcml0eVxuLy8gYml0cyBhdCBwb3dlcnMgb2YgMi4gQ1JVQ0lBTExZOiBkYXRhIGJpdHMgYXJlIHN0b3JlZCBpblxuLy8gUkVWRVJTRUQgZW5kaWFubmVzcyAoTFNCIGZpcnN0KSwgYW5kIHBhcml0eSBiaXRzIGFyZSBzZXRcbi8vIGZyb20gdGhlIFhPUiBvZiBhbGwgU0VUIEJJVCBQT1NJVElPTlMgKHRoaXMgaXMgdGhlIFwiSGFtbWluZ1xuLy8gcGFyaXR5ID0gaW5kZXggWE9SIHJ1bGVcIiByYXRoZXIgdGhhbiB0aGUgdXN1YWwgXCJjb3VudCBvZiAxc1xuLy8gaW4gc3Vic2V0XCIgcnVsZSkuXG4vL1xuLy8gQ29uY3JldGVseSAodmVyYmF0aW0gZnJvbSBiaXRidXJuZXItc3JjL3NyYy9Db2RpbmdDb250cmFjdC9cbi8vIGNvbnRyYWN0cy9IYW1taW5nQ29kZS50cyBIYW1taW5nRW5jb2RlKTpcbi8vICAgMS4gZW5jWzBdID0gMCAob3ZlcmFsbCBwYXJpdHksIHNldCBsYXN0KS5cbi8vICAgMi4gV2FsayBwb3NpdGlvbnMgMS4u4oieLiBGb3IgZWFjaCBwb3NpdGlvbiBpLCBpZiAoaSAmIChpLTEpKSAhPSAwXG4vLyAgICAgIChOT1QgYSBwb3dlciBvZiAyKSwgaXQncyBhIGRhdGEgcG9zaXRpb24uIFBvcCBkYXRhIGJpdHNcbi8vICAgICAgZnJvbSB0aGUgTFNCIG9mIHRoZSBpbnB1dC5cbi8vICAgMy4gcGFyaXR5TnVtYmVyID0gWE9SIG9mIGFsbCBzZXQgYml0IHBvc2l0aW9ucyBpbiBlbmMuXG4vLyAgICAgIFRoZSBwYXJpdHkgYml0cyAocG9zaXRpb25zIDEsIDIsIDQsIDgsIC4uLikgYXJlIHNldCB0b1xuLy8gICAgICB0aGUgYml0cyBvZiBwYXJpdHlOdW1iZXIgKExTQiBmaXJzdCkuXG4vLyAgIDQuIGVuY1swXSA9IChudW1iZXIgb2YgMSBiaXRzIGluIGVuYykgJSAyLlxuLy8gICA1LiBSZXR1cm4gZW5jIGFzIGEgXCIwXCIvXCIxXCIgc3RyaW5nIG9mIGxlbmd0aCBjZWlsKGxvZzIobikpKzEuXG4vL1xuLy8gVGhlIHJlc3VsdCBzdHJpbmcgaGFzIGxlbmd0aCBtKzEgd2hlcmUgMl4obS0xKSDiiaQgbisxIDwgMl5tLlxuLy8gV2FpdCDigJQgYWN0dWFsbHkgdGhlIHJlc3VsdCBsZW5ndGggaXMgMl5tIHdoZXJlIG0gaXMgdGhlXG4vLyBzbWFsbGVzdCBtIHdpdGggMl4oMl5tIC0gbSAtIDEpID4gZGF0YS4gRm9yIHRoZSBzbWFsbFxuLy8gY2FzZXMgdGhlIGdhbWUgZ2VuZXJhdGVzLCBtIGlzIHR5cGljYWxseSAyIG9yIDMgKHNvIG91dHB1dFxuLy8gaXMgNCBvciA4IGNoYXJzKS5cbmZ1bmN0aW9uIGhhbW1pbmdFbmNvZGUoZGF0YSkge1xuICBjb25zdCBlbmMgPSBbMF07XG4gIGNvbnN0IGRhdGFfYml0cyA9IGRhdGEudG9TdHJpbmcoMikuc3BsaXQoXCJcIikucmV2ZXJzZSgpLm1hcChOdW1iZXIpO1xuICBsZXQgayA9IGRhdGFfYml0cy5sZW5ndGg7XG4gIC8vIFBsYWNlIGRhdGEgYml0cyBhdCBub24tcG93ZXItb2YtMiBwb3NpdGlvbnMsIExTQiBmaXJzdC5cbiAgZm9yIChsZXQgaSA9IDE7IGsgPiAwOyBpKyspIHtcbiAgICBpZiAoKGkgJiAoaSAtIDEpKSAhPT0gMCkge1xuICAgICAgZW5jW2ldID0gZGF0YV9iaXRzWy0ta107XG4gICAgfSBlbHNlIHtcbiAgICAgIGVuY1tpXSA9IDA7XG4gICAgfVxuICB9XG4gIC8vIFN1YnNlY3Rpb24gcGFyaXR5OiBYT1Igb2YgaW5kaWNlcyB3aGVyZSBlbmMgYml0IGlzIHNldC5cbiAgbGV0IHBhcml0eU51bWJlciA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZW5jLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGVuY1tpXSkgcGFyaXR5TnVtYmVyIF49IGk7XG4gIH1cbiAgLy8gU2V0IHRoZSBwYXJpdHkgYml0cyBhdCBwb3dlcnMgb2YgMiwgTFNCIGZpcnN0LlxuICBjb25zdCBwYXJpdHlBcnJheSA9IHBhcml0eU51bWJlci50b1N0cmluZygyKS5zcGxpdChcIlwiKS5yZXZlcnNlKCkubWFwKE51bWJlcik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcGFyaXR5QXJyYXkubGVuZ3RoOyBpKyspIHtcbiAgICBlbmNbMiAqKiBpXSA9IHBhcml0eUFycmF5W2ldID8gMSA6IDA7XG4gIH1cbiAgLy8gT3ZlcmFsbCBwYXJpdHkgKGF0IHBvc2l0aW9uIDApLlxuICBsZXQgb25lcyA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZW5jLmxlbmd0aDsgaSsrKSBpZiAoZW5jW2ldKSBvbmVzKys7XG4gIGVuY1swXSA9IG9uZXMgJSAyID09PSAwID8gMCA6IDE7XG4gIHJldHVybiBlbmMuam9pbihcIlwiKTtcbn1cblxuLy8gXCJIYW1taW5nIENvZGVzOiBFbmNvZGVkIEJpbmFyeSB0byBJbnRlZ2VyXCI6IGludmVyc2UsIHdpdGhcbi8vIHNpbmdsZS1iaXQgZXJyb3IgY29ycmVjdGlvbi4gQWxnb3JpdGhtICh2ZXJiYXRpbSBmcm9tXG4vLyBiaXRidXJuZXItc3JjIEhhbW1pbmdEZWNvZGUpOlxuLy8gICAxLiBTcGxpdCBpbnRvIGJpdHMuIGVyciA9IFhPUiBvZiBhbGwgaW5kaWNlcyBpIHdoZXJlIGJpdCBpXG4vLyAgICAgIGlzIDEuIElmIGVyciAhPSAwLCBmbGlwIGJpdCBlcnIgKGl0J3MgdGhlIGVycm9yZWQgYml0KS5cbi8vICAgMi4gUmVhZCBkYXRhIGJpdHMgZnJvbSBub24tcG93ZXItb2YtMiBwb3NpdGlvbnMsIExTQiBmaXJzdCxcbi8vICAgICAgY29uY2F0ZW5hdGUsIHBhcnNlSW50KF8sIDIpIOKGkiBpbnRlZ2VyLlxuZnVuY3Rpb24gaGFtbWluZ0RlY29kZShlbmNvZGVkKSB7XG4gIGNvbnN0IGJpdHMgPSBlbmNvZGVkLnNwbGl0KFwiXCIpLm1hcChOdW1iZXIpO1xuICBsZXQgZXJyID0gMDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBiaXRzLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGJpdHNbaV0pIGVyciBePSBpO1xuICB9XG4gIGlmIChlcnIpIGJpdHNbZXJyXSA9IGJpdHNbZXJyXSA/IDAgOiAxO1xuICBsZXQgYW5zID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDE7IGkgPCBiaXRzLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKChpICYgKGkgLSAxKSkgIT09IDApIGFucyArPSBiaXRzW2ldO1xuICB9XG4gIHJldHVybiBwYXJzZUludChhbnMsIDIpO1xufVxuXG4vLyAtLS0gY29tcHJlc3Npb24gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLy8gXCJDb21wcmVzc2lvbiBJOiBSTEUgQ29tcHJlc3Npb25cIjogZW5jb2RlIGEgc3RyaW5nIGFzXG4vLyA8Y291bnQ+PGNoYXI+IHBhaXJzLiBJZiBhIGNoYXIgYXBwZWFycyAxMCsgdGltZXMgaW4gYSByb3csXG4vLyBzcGxpdCBpbnRvIG11bHRpcGxlIDw5PjxjaGFyPiBibG9ja3MuIEVtcHR5IHN0cmluZyByZXR1cm5zIFwiXCIuXG5mdW5jdGlvbiBybGVDb21wcmVzcyhzKSB7XG4gIGlmIChzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG4gIGxldCBvdXQgPSBcIlwiO1xuICBsZXQgaSA9IDA7XG4gIHdoaWxlIChpIDwgcy5sZW5ndGgpIHtcbiAgICBjb25zdCBjaCA9IHNbaV07XG4gICAgbGV0IGNvdW50ID0gMTtcbiAgICB3aGlsZSAoaSArIGNvdW50IDwgcy5sZW5ndGggJiYgc1tpICsgY291bnRdID09PSBjaCAmJiBjb3VudCA8IDkpIGNvdW50Kys7XG4gICAgb3V0ICs9IFN0cmluZyhjb3VudCkgKyBjaDtcbiAgICBpICs9IGNvdW50O1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8vIFwiQ29tcHJlc3Npb24gSUk6IExaIERlY29tcHJlc3Npb25cIjogdGhlIGdhbWUncyB2YXJpYW50IG9mXG4vLyBMWjc3LiBGb3JtYXQ6IGNodW5rcyBBTFRFUk5BVEUgYmV0d2VlbiBMSVRFUkFMIGFuZCBCQUNLUkVGXG4vLyAoc3RhcnRpbmcgd2l0aCBsaXRlcmFsKS4gQSBjaHVuayBiZWdpbnMgd2l0aCBhIGxlbmd0aCBMXG4vLyAoQVNDSUkgZGlnaXQgMS05KS4gRm9yIGEgbGl0ZXJhbCBjaHVuaywgdGhlIG5leHQgTCBjaGFycyBhcmVcbi8vIGNvcGllZCB2ZXJiYXRpbS4gRm9yIGEgYmFja3JlZiBjaHVuaywgdGhlIG5leHQgY2hhciBpcyBhblxuLy8gb2Zmc2V0IFggKDEtOSkgYW5kIHRoZSBjaHVuayBvdXRwdXRzIEwgY29waWVzIG9mXG4vLyBwbGFpbltwbGFpbi5sZW5ndGggLSBYXS4gTD0wIGVuZHMgdGhlIGN1cnJlbnQgY2h1bmsgZWFybHk7XG4vLyB0aGUgdmVyeSBuZXh0IGNoYXIgaXMgdGhlbiB0aGUgbGVuZ3RoIG9mIGEgZnJlc2ggY2h1bmtcbi8vIChhbHRlcm5hdGluZyB0eXBlKS4gVGhlIGZpbmFsIGNodW5rIG1heSBiZSBvZiBlaXRoZXIgdHlwZS5cbi8vXG4vLyBFeGFtcGxlcyAocGVyIHRoZSBnYW1lIHNvdXJjZSdzIGNvbXByTFpEZWNvZGUg4oCUIG5vdGU6IHRoZVxuLy8gZGVzYyB0ZXh0IGluIHRoZSBnYW1lJ3MgQ29tcHJlc3Npb24udHMgaGFzIHR5cG9zIGluIHRoZVxuLy8gZXhhbXBsZSB0cmFjZSwgYnV0IHRoZSBjb21wckxaRGVjb2RlIGZ1bmN0aW9uIGl0c2VsZiBpc1xuLy8gYXV0aG9yaXRhdGl2ZSk6XG4vLyAgIFwiNWFhYWJiXCIgICAgICAgICAgICAtPiBcImFhYWJiXCJcbi8vICAgXCI1YWFhYmI0NVwiICAgICAgICAgIC0+IFwiYWFhYmJhYWFhXCIgIChOT1QgXCJhYWFiYmFhYWJcIiBhc1xuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGUgaW4tZ2FtZSBkZXNjIHNheXMpXG4vLyAgIFwiMWE5MTAzMVwiICAgICAgICAgICAtPiBcImFhYWFhYWFhYWFhYVwiICAoM2FhYTkgdGhlbiBiYWNrcmVmXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9mIGxlbmd0aCAxLCBvZmZzZXQgMyxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2FpdCwgZGVjb2RlIGlzOlxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBMPTEsIFwiYVwiIC0+IFwiYVwiOyBiYWNrcmVmXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDksMSAtPiA5ICdhJ3MgLT4gXCJhYWFhYWFhYWFcIjtcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTD0wIGVuZHM7IEw9MywgXCIxXCIgKDE/IGhtbVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhY3R1YWxseSB0aGUgZW5jb2Rpbmdcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgMWE5MTA0MSBtZWFuczogMWEsIDkxMDQsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLiBubyB0aGUgY2h1bmtzXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsdGVybmF0ZS4gU286XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNodW5rMSBsaXRlcmFsIDFhOiBcImFcIlxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjaHVuazIgYmFja3JlZiA5MTogOSAnYSdcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLT4gXCJhYWFhYWFhYWFcIlxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjaHVuazMgbGl0ZXJhbCAwMzogMCBlbmRzXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNodW5rMjsgdGhlbiBjaHVuazMgPSBMPTMsXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiMVwiIOKAlCBidXQgdGhhdCdzIG9ubHkgMVxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjaGFyIGFuZCB3ZSBuZWVkIDNcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2hhcnMuIEhtbS4gVGhpcyBpcyB3aHlcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhlIExaIGRlc2MgaXMgY29uZnVzaW5nLilcbi8vXG4vLyBUaGUgXCJ2ZXJpZmllclwiIGNoZWNrIGlzOiBjb21wckxaRGVjb2RlKGFuc3dlcikgPT09IHBsYWluXG4vLyBBTkQgYW5zd2VyLmxlbmd0aCA8PSBvcHRpbWFsLmxlbmd0aC4gU28gdGhlIGRlY29kZXIgaXMgdGhlXG4vLyBzcGVjIOKAlCB0aGUgZW5jb2RlciBqdXN0IG5lZWRzIHRvIHByb2R1Y2UgYSB2YWxpZCBMWiBzdHJpbmdcbi8vIG9mIGxlbmd0aCDiiaQgdGhlIGdhbWUncyBvcHRpbWFsLlxuZnVuY3Rpb24gbHpEZWNvbXByZXNzKGNvbXByKSB7XG4gIGxldCBwbGFpbiA9IFwiXCI7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY29tcHIubGVuZ3RoOyApIHtcbiAgICBjb25zdCBsaXRlcmFsX2xlbmd0aCA9IGNvbXByLmNoYXJDb2RlQXQoaSkgLSAweDMwO1xuICAgIGlmIChsaXRlcmFsX2xlbmd0aCA8IDAgfHwgbGl0ZXJhbF9sZW5ndGggPiA5IHx8IGkgKyAxICsgbGl0ZXJhbF9sZW5ndGggPiBjb21wci5sZW5ndGgpIHJldHVybiBcIlwiO1xuICAgIHBsYWluICs9IGNvbXByLnN1YnN0cmluZyhpICsgMSwgaSArIDEgKyBsaXRlcmFsX2xlbmd0aCk7XG4gICAgaSArPSAxICsgbGl0ZXJhbF9sZW5ndGg7XG4gICAgaWYgKGkgPj0gY29tcHIubGVuZ3RoKSBicmVhaztcbiAgICBjb25zdCBiYWNrcmVmX2xlbmd0aCA9IGNvbXByLmNoYXJDb2RlQXQoaSkgLSAweDMwO1xuICAgIGlmIChiYWNrcmVmX2xlbmd0aCA8IDAgfHwgYmFja3JlZl9sZW5ndGggPiA5KSByZXR1cm4gXCJcIjtcbiAgICBpZiAoYmFja3JlZl9sZW5ndGggPT09IDApIHsgaSsrOyBjb250aW51ZTsgfVxuICAgIGlmIChpICsgMSA+PSBjb21wci5sZW5ndGgpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IGJhY2tyZWZfb2Zmc2V0ID0gY29tcHIuY2hhckNvZGVBdChpICsgMSkgLSAweDMwO1xuICAgIGlmIChiYWNrcmVmX2xlbmd0aCA+IDAgJiYgKGJhY2tyZWZfb2Zmc2V0IDwgMSB8fCBiYWNrcmVmX29mZnNldCA+IDkpKSByZXR1cm4gXCJcIjtcbiAgICBpZiAoYmFja3JlZl9vZmZzZXQgPiBwbGFpbi5sZW5ndGgpIHJldHVybiBcIlwiO1xuICAgIGZvciAobGV0IGogPSAwOyBqIDwgYmFja3JlZl9sZW5ndGg7IGorKykge1xuICAgICAgcGxhaW4gKz0gcGxhaW5bcGxhaW4ubGVuZ3RoIC0gYmFja3JlZl9vZmZzZXRdO1xuICAgIH1cbiAgICBpICs9IDI7XG4gIH1cbiAgcmV0dXJuIHBsYWluO1xufVxuXG4vLyBcIkNvbXByZXNzaW9uIElJSTogTFogQ29tcHJlc3Npb25cIjogcHJvZHVjZSBhIHZhbGlkIExaXG4vLyBlbmNvZGluZyB3aG9zZSBsZW5ndGggaXMg4omkIHRoZSBnYW1lJ3Mgb3B0aW1hbC4gVGhlIHZlcmlmaWVyXG4vLyBkZWNvZGVzIG91ciBhbnN3ZXIgYW5kIGNoZWNrcyAoYSkgaXQgcm91bmQtdHJpcHMgdG8gdGhlXG4vLyBvcmlnaW5hbCBwbGFpbnRleHQsIChiKSB0aGUgZW5jb2RlZCBsZW5ndGggaXMg4omkIHRoZSBnYW1lJ3Ncbi8vIG9wdGltYWwuIFRoZSBnYW1lJ3Mgb3B0aW1hbCBpcyBjb21wdXRlZCBieSBgY29tcHJMWkVuY29kZWBcbi8vIChhIERQIG92ZXIgc3RhdGVbMC4uOV1bMS4uOV0pLiBXZSB1c2UgdGhlIHNhbWUgRFAgZm9yXG4vLyBjb3JyZWN0bmVzcy5cbi8vXG4vLyBEUCBzdGF0ZSAobWF0Y2hpbmcgYml0YnVybmVyLXNyYydzIGNvbXByTFpFbmNvZGUpOlxuLy8gICBzdGF0ZVtpXVtqXSA9IGJlc3QgKHNob3J0ZXN0KSBlbmNvZGluZyBzdHJpbmcgc28gZmFyXG4vLyAgIGkgPSAwOiBsaXRlcmFsIGNodW5rLCBqID0gY3VycmVudCBsZW5ndGggKDEtOSlcbi8vICAgaSBpbiAxLTk6IGJhY2tyZWYgY2h1bmsgd2l0aCBvZmZzZXQgaSwgaiA9IGN1cnJlbnQgbGVuZ3RoXG4vLyBUcmFuc2l0aW9ucyBhdCBlYWNoIG5ldyBwbGFpbnRleHQgY2hhciBjID0gcGxhaW5baV06XG4vLyAgIC0gRXh0ZW5kIGEgbGl0ZXJhbCBjaHVuazogc3RhdGVbMF1baisxXSAoaWYgajw5KVxuLy8gICAtIEVuZCBsaXRlcmFsIGNodW5rICsgc3RhcnQgbmV3IGxpdGVyYWw6IHN0YXRlWzBdWzFdICs9IFwiOVwiK3ByZXY5Y2hhcnMrXCIwXCJcbi8vICAgLSBFbmQgbGl0ZXJhbCBjaHVuayArIHN0YXJ0IG5ldyBiYWNrcmVmIChvZmZzZXQgZCwgbGVuZ3RoIDEpOlxuLy8gICAgIGlmIHBsYWluW2ktZF0gPT09IGMsIHN0YXRlW2RdWzFdICs9IHByZXZMZW5ndGgrcHJldkNoYXJzXG4vLyAgIC0gRXh0ZW5kIGEgYmFja3JlZiBjaHVuazogc3RhdGVbb2ZmXVtqKzFdIChpZiBqPDksIGFuZCBtYXRjaGVzKVxuLy8gICAtIEVuZCBiYWNrcmVmICsgc3RhcnQgbmV3IGxpdGVyYWw6IHN0YXRlWzBdWzFdICs9IGxlbmd0aCtvZmZzZXRcbi8vICAgLSBFbmQgYmFja3JlZiArIHN0YXJ0IG5ldyBiYWNrcmVmIChvZmZzZXQgZCwgbGVuZ3RoIDEpOlxuLy8gICAgIGlmIHBsYWluW2ktZF0gPT09IGMsIHN0YXRlW2RdWzFdICs9IGxlbmd0aCtvZmZzZXQrXCIwXCJcbi8vIEF0IGVuZCwgYXBwZW5kIHRoZSBmaW5hbCBjaHVuaydzIGxlbmd0aCtwYXlsb2FkIHRvIGVhY2ggc3RhdGUuXG5mdW5jdGlvbiBsekNvbXByZXNzKHBsYWluKSB7XG4gIGlmIChwbGFpbi5sZW5ndGggPT09IDApIHJldHVybiBcIlwiO1xuICAvLyBjdXJfc3RhdGVbaV1bal0gPSBiZXN0IGVuY29kaW5nIGZvciBwcmVmaXggdXAgdG8gY3VycmVudFxuICAvLyBwb3NpdGlvbiwgZW5kaW5nIHdpdGggYSBjaHVuayBvZiB0eXBlIGkgYW5kIGxlbmd0aCBqLlxuICBsZXQgY3VyID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogMTAgfSwgKCkgPT4gbmV3IEFycmF5KDEwKS5maWxsKG51bGwpKTtcbiAgbGV0IG5leHQgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiAxMCB9LCAoKSA9PiBuZXcgQXJyYXkoMTApLmZpbGwobnVsbCkpO1xuICBmdW5jdGlvbiBzZXQoc3RhdGUsIGksIGosIHN0cikge1xuICAgIGNvbnN0IGN1ciA9IHN0YXRlW2ldW2pdO1xuICAgIGlmIChjdXIgPT09IG51bGwgfHwgc3RyLmxlbmd0aCA8IGN1ci5sZW5ndGgpIHN0YXRlW2ldW2pdID0gc3RyO1xuICAgIGVsc2UgaWYgKHN0ci5sZW5ndGggPT09IGN1ci5sZW5ndGggJiYgTWF0aC5yYW5kb20oKSA8IDAuNSkgc3RhdGVbaV1bal0gPSBzdHI7XG4gIH1cbiAgLy8gSW5pdGlhbDogbGl0ZXJhbCBjaHVuayBvZiBsZW5ndGggMSBjb3ZlcmluZyAwIGNoYXJzICh3aWxsXG4gIC8vIHBpY2sgdXAgdGhlIGZpcnN0IGNoYXIgb24gdGhlIGZpcnN0IGl0ZXJhdGlvbikuXG4gIGN1clswXVsxXSA9IFwiXCI7XG4gIGZvciAobGV0IGkgPSAxOyBpIDwgcGxhaW4ubGVuZ3RoOyBpKyspIHtcbiAgICAvLyBDbGVhciBuZXh0XG4gICAgZm9yIChsZXQgciA9IDA7IHIgPCAxMDsgcisrKSBuZXh0W3JdLmZpbGwobnVsbCk7XG4gICAgY29uc3QgYyA9IHBsYWluW2ldO1xuICAgIC8vIExpdGVyYWwgc3RhdGVzXG4gICAgZm9yIChsZXQgbGVuID0gMTsgbGVuIDw9IDk7IGxlbisrKSB7XG4gICAgICBjb25zdCBzID0gY3VyWzBdW2xlbl07XG4gICAgICBpZiAocyA9PT0gbnVsbCkgY29udGludWU7XG4gICAgICBpZiAobGVuIDwgOSkge1xuICAgICAgICBzZXQobmV4dCwgMCwgbGVuICsgMSwgcyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZXQobmV4dCwgMCwgMSwgcyArIFwiOVwiICsgcGxhaW4uc3Vic3RyaW5nKGkgLSA5LCBpKSArIFwiMFwiKTtcbiAgICAgIH1cbiAgICAgIGZvciAobGV0IG9mZiA9IDE7IG9mZiA8PSBNYXRoLm1pbig5LCBpKTsgb2ZmKyspIHtcbiAgICAgICAgaWYgKHBsYWluW2kgLSBvZmZdID09PSBjKSB7XG4gICAgICAgICAgc2V0KG5leHQsIG9mZiwgMSwgcyArIFN0cmluZyhsZW4pICsgcGxhaW4uc3Vic3RyaW5nKGkgLSBsZW4sIGkpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICAvLyBCYWNrcmVmIHN0YXRlc1xuICAgIGZvciAobGV0IG9mZiA9IDE7IG9mZiA8PSA5OyBvZmYrKykge1xuICAgICAgZm9yIChsZXQgbGVuID0gMTsgbGVuIDw9IDk7IGxlbisrKSB7XG4gICAgICAgIGNvbnN0IHMgPSBjdXJbb2ZmXVtsZW5dO1xuICAgICAgICBpZiAocyA9PT0gbnVsbCkgY29udGludWU7XG4gICAgICAgIGlmIChwbGFpbltpIC0gb2ZmXSA9PT0gYykge1xuICAgICAgICAgIGlmIChsZW4gPCA5KSB7XG4gICAgICAgICAgICBzZXQobmV4dCwgb2ZmLCBsZW4gKyAxLCBzKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0KG5leHQsIG9mZiwgMSwgcyArIFwiOVwiICsgU3RyaW5nKG9mZikgKyBcIjBcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIEVuZCBiYWNrcmVmLCBzdGFydCBuZXcgbGl0ZXJhbFxuICAgICAgICBzZXQobmV4dCwgMCwgMSwgcyArIFN0cmluZyhsZW4pICsgU3RyaW5nKG9mZikpO1xuICAgICAgICAvLyBFbmQgYmFja3JlZiwgc3RhcnQgbmV3IGJhY2tyZWZcbiAgICAgICAgZm9yIChsZXQgbmV3T2ZmID0gMTsgbmV3T2ZmIDw9IE1hdGgubWluKDksIGkpOyBuZXdPZmYrKykge1xuICAgICAgICAgIGlmIChwbGFpbltpIC0gbmV3T2ZmXSA9PT0gYykge1xuICAgICAgICAgICAgc2V0KG5leHQsIG5ld09mZiwgMSwgcyArIFN0cmluZyhsZW4pICsgU3RyaW5nKG9mZikgKyBcIjBcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIC8vIFN3YXBcbiAgICBbY3VyLCBuZXh0XSA9IFtuZXh0LCBjdXJdO1xuICB9XG4gIC8vIEZpbmFsaXplOiBhcHBlbmQgdGhlIGZpbmFsIGNodW5rJ3MgbGVuZ3RoK3BheWxvYWRcbiAgbGV0IHJlc3VsdCA9IG51bGw7XG4gIGZvciAobGV0IGxlbiA9IDE7IGxlbiA8PSA5OyBsZW4rKykge1xuICAgIGxldCBzID0gY3VyWzBdW2xlbl07XG4gICAgaWYgKHMgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIHMgKz0gU3RyaW5nKGxlbikgKyBwbGFpbi5zdWJzdHJpbmcocGxhaW4ubGVuZ3RoIC0gbGVuLCBwbGFpbi5sZW5ndGgpO1xuICAgIGlmIChyZXN1bHQgPT09IG51bGwgfHwgcy5sZW5ndGggPCByZXN1bHQubGVuZ3RoKSByZXN1bHQgPSBzO1xuICB9XG4gIGZvciAobGV0IG9mZiA9IDE7IG9mZiA8PSA5OyBvZmYrKykge1xuICAgIGZvciAobGV0IGxlbiA9IDE7IGxlbiA8PSA5OyBsZW4rKykge1xuICAgICAgbGV0IHMgPSBjdXJbb2ZmXVtsZW5dO1xuICAgICAgaWYgKHMgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgICAgcyArPSBTdHJpbmcobGVuKSArIFN0cmluZyhvZmYpO1xuICAgICAgaWYgKHJlc3VsdCA9PT0gbnVsbCB8fCBzLmxlbmd0aCA8IHJlc3VsdC5sZW5ndGgpIHJlc3VsdCA9IHM7XG4gICAgfVxuICB9XG4gIHJldHVybiByZXN1bHQgPz8gXCJcIjtcbn1cblxuLy8gLS0tIGdyYXBocyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8vIFwiUHJvcGVyIDItQ29sb3Jpbmcgb2YgYSBHcmFwaFwiOiBkYXRhID0gW251bVZlcnRpY2VzLFxuLy8gZWRnZXNbXV0gd2hlcmUgZWRnZXMgYXJlIFt1LCB2XSBwYWlycy4gUmV0dXJuIGFuIGFycmF5IG9mIDAvMVxuLy8gY29sb3IgYXNzaWdubWVudHMgKGxlbmd0aCBudW1WZXJ0aWNlcykgc3VjaCB0aGF0IG5vIGVkZ2Vcbi8vIGNvbm5lY3RzIHR3byBzYW1lLWNvbG9yZWQgdmVydGljZXMuIElmIG5vIHZhbGlkIDItY29sb3Jpbmdcbi8vIGV4aXN0cywgcmV0dXJuIFtdIChlbXB0eSBhcnJheSkuIFRoZSBnYW1lIGlucHV0IGlzIGFsd2F5c1xuLy8gMi1jb2xvcmFibGUsIHNvIHdlIGFzc3VtZSBzdWNjZXNzLlxuZnVuY3Rpb24gdHdvQ29sb3JHcmFwaChuLCBlZGdlcykge1xuICBjb25zdCBjb2xvciA9IG5ldyBBcnJheShuKS5maWxsKC0xKTtcbiAgY29uc3QgYWRqID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogbiB9LCAoKSA9PiBbXSk7XG4gIGZvciAoY29uc3QgW3UsIHZdIG9mIGVkZ2VzKSB7XG4gICAgYWRqW3VdLnB1c2godik7XG4gICAgYWRqW3ZdLnB1c2godSk7XG4gIH1cbiAgZm9yIChsZXQgc3RhcnQgPSAwOyBzdGFydCA8IG47IHN0YXJ0KyspIHtcbiAgICBpZiAoY29sb3Jbc3RhcnRdICE9PSAtMSkgY29udGludWU7XG4gICAgY29sb3Jbc3RhcnRdID0gMDtcbiAgICBjb25zdCBxdWV1ZSA9IFtzdGFydF07XG4gICAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHUgPSBxdWV1ZS5zaGlmdCgpO1xuICAgICAgZm9yIChjb25zdCB2IG9mIGFkalt1XSkge1xuICAgICAgICBpZiAoY29sb3Jbdl0gPT09IC0xKSB7XG4gICAgICAgICAgY29sb3Jbdl0gPSAxIC0gY29sb3JbdV07XG4gICAgICAgICAgcXVldWUucHVzaCh2KTtcbiAgICAgICAgfSBlbHNlIGlmIChjb2xvclt2XSA9PT0gY29sb3JbdV0pIHtcbiAgICAgICAgICByZXR1cm4gW107ICAvLyBub3QgMi1jb2xvcmFibGVcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gY29sb3I7XG59XG5cbi8vIC0tLSBzdG9jayB0cmFkZXIgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vLyBcIkFsZ29yaXRobWljIFN0b2NrIFRyYWRlciBJXCI6IG9uZSB0cmFuc2FjdGlvbiwgbWF4IHByb2ZpdC5cbi8vIFZlcmJhdGltIGZyb20gYml0YnVybmVyLXNyYy9zcmMvQ29kaW5nQ29udHJhY3QvY29udHJhY3RzL1xuLy8gQWxnb3JpdGhtaWNTdG9ja1RyYWRlci50cyBnZXRBbnN3ZXIoSSk6IEthZGFuZS1zdHlsZSBvblxuLy8gcHJpY2UgZGVsdGFzLiBFcXVpdmFsZW50IHRvIG1heChwcmljZXNbal0tcHJpY2VzW2ldKSBvdmVyXG4vLyBqPmksIGJ1dCB1c2VzIHRoZSBydW5uaW5nLXN1bSBmb3JtLlxuZnVuY3Rpb24gc3RvY2tUcmFkZXJJKHByaWNlcykge1xuICBsZXQgbWF4Q3VyID0gMDtcbiAgbGV0IG1heFNvRmFyID0gMDtcbiAgZm9yIChsZXQgaSA9IDE7IGkgPCBwcmljZXMubGVuZ3RoOyBpKyspIHtcbiAgICBtYXhDdXIgPSBNYXRoLm1heCgwLCAobWF4Q3VyICs9IHByaWNlc1tpXSAtIHByaWNlc1tpIC0gMV0pKTtcbiAgICBtYXhTb0ZhciA9IE1hdGgubWF4KG1heEN1ciwgbWF4U29GYXIpO1xuICB9XG4gIHJldHVybiBtYXhTb0Zhcjtcbn1cblxuLy8gXCJBbGdvcml0aG1pYyBTdG9jayBUcmFkZXIgSUlcIjogdW5saW1pdGVkIHRyYW5zYWN0aW9ucywgYnV0XG4vLyBubyB0d28gaW4gcGFyYWxsZWwuIFRoZSB0cmljazogYW55IHRpbWUgcHJpY2VzW2krMV0gPlxuLy8gcHJpY2VzW2ldLCB5b3UgbWFrZSBwcmljZXNbaSsxXSAtIHByaWNlc1tpXS4gVGhpcyBpcyB0aGVcbi8vIG1heGltdW0gcHJvZml0IG9mIGFsbCB1cHdhcmQgbW92ZXMuXG5mdW5jdGlvbiBzdG9ja1RyYWRlcklJKHByaWNlcykge1xuICBsZXQgcHJvZml0ID0gMDtcbiAgZm9yIChsZXQgaSA9IDE7IGkgPCBwcmljZXMubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAocHJpY2VzW2ldID4gcHJpY2VzW2kgLSAxXSkgcHJvZml0ICs9IHByaWNlc1tpXSAtIHByaWNlc1tpIC0gMV07XG4gIH1cbiAgcmV0dXJuIHByb2ZpdDtcbn1cblxuLy8gXCJBbGdvcml0aG1pYyBTdG9jayBUcmFkZXIgSUlJXCI6IGF0IG1vc3QgMiB0cmFuc2FjdGlvbnMuIFRoZVxuLy8gTyhuKSBzb2x1dGlvbjogdHJhY2sgdGhlIGJlc3QgcHJvZml0IGZvciBvbmUgdHJhbnNhY3Rpb25cbi8vIGVuZGluZyBhdCBvciBiZWZvcmUgZWFjaCBkYXkgKGxlZnRbaV0pLCBhbmQgdGhlIGJlc3QgcHJvZml0XG4vLyBmb3Igb25lIHRyYW5zYWN0aW9uIHN0YXJ0aW5nIGF0IG9yIGFmdGVyIGVhY2ggZGF5XG4vLyAocmlnaHRbaV0pLiBUaGVuIG1heChsZWZ0W2ldICsgcmlnaHRbaSsxXSkgaXMgdGhlIGFuc3dlci5cbmZ1bmN0aW9uIHN0b2NrVHJhZGVySUlJKHByaWNlcykge1xuICBpZiAocHJpY2VzLmxlbmd0aCA8IDIpIHJldHVybiAwO1xuICBjb25zdCBuID0gcHJpY2VzLmxlbmd0aDtcbiAgY29uc3QgbGVmdCA9IG5ldyBBcnJheShuKS5maWxsKDApO1xuICBjb25zdCByaWdodCA9IG5ldyBBcnJheShuKS5maWxsKDApO1xuICBsZXQgbWluID0gcHJpY2VzWzBdO1xuICBmb3IgKGxldCBpID0gMTsgaSA8IG47IGkrKykge1xuICAgIGxlZnRbaV0gPSBNYXRoLm1heChsZWZ0W2kgLSAxXSwgcHJpY2VzW2ldIC0gbWluKTtcbiAgICBpZiAocHJpY2VzW2ldIDwgbWluKSBtaW4gPSBwcmljZXNbaV07XG4gIH1cbiAgbGV0IG1heCA9IHByaWNlc1tuIC0gMV07XG4gIGZvciAobGV0IGkgPSBuIC0gMjsgaSA+PSAwOyBpLS0pIHtcbiAgICByaWdodFtpXSA9IE1hdGgubWF4KHJpZ2h0W2kgKyAxXSwgbWF4IC0gcHJpY2VzW2ldKTtcbiAgICBpZiAocHJpY2VzW2ldID4gbWF4KSBtYXggPSBwcmljZXNbaV07XG4gIH1cbiAgbGV0IGJlc3QgPSBsZWZ0W24gLSAxXTsgIC8vIHNpbmdsZSB0cmFuc2FjdGlvblxuICBmb3IgKGxldCBpID0gMDsgaSA8IG4gLSAxOyBpKyspIHtcbiAgICBpZiAobGVmdFtpXSArIHJpZ2h0W2kgKyAxXSA+IGJlc3QpIGJlc3QgPSBsZWZ0W2ldICsgcmlnaHRbaSArIDFdO1xuICB9XG4gIHJldHVybiBiZXN0O1xufVxuXG4vLyBcIkFsZ29yaXRobWljIFN0b2NrIFRyYWRlciBJVlwiOiBhdCBtb3N0IGsgdHJhbnNhY3Rpb25zLlxuLy8gZGF0YSA9IFtrLCBwcmljZXNbXV0uIFZlcmJhdGltIGZyb20gYml0YnVybmVyLXNyYyBnZXRBbnN3ZXIoSVYpOlxuLy8gSWYgayA+IG4vMiB0aGUgYW5zd2VyIGlzIFwic3VtIG9mIGFsbCBwb3NpdGl2ZSBkZWx0YXNcIiAoc2FtZVxuLy8gYXMgdW5saW1pdGVkIHRyYW5zYWN0aW9ucykuIE90aGVyd2lzZSBob2xkW2pdL3JlbGVbal0gc3RhdGVcbi8vIHBlciBhY3RpdmUgdHJhbnNhY3Rpb246IHJlbGVbal0gPSBiZXN0IHByb2ZpdCBhZnRlciBqLXRoXG4vLyBjb21wbGV0ZSBzZWxsOyBob2xkW2pdID0gYmVzdCBwcm9maXQgd2hpbGUgaG9sZGluZyB0aGUgai10aFxuLy8gc3RvY2suIFVwZGF0ZSByZWxlW2pdIGJlZm9yZSBob2xkW2pdIGVhY2ggZGF5LCBpdGVyYXRlIGpcbi8vIGRvd253YXJkLlxuZnVuY3Rpb24gc3RvY2tUcmFkZXJJVihrLCBwcmljZXMpIHtcbiAgY29uc3QgbGVuID0gcHJpY2VzLmxlbmd0aDtcbiAgaWYgKGxlbiA8IDIgfHwgayA9PT0gMCkgcmV0dXJuIDA7XG4gIGlmIChrID4gbGVuIC8gMikge1xuICAgIGxldCByZXMgPSAwO1xuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbGVuOyBpKyspIHJlcyArPSBNYXRoLm1heChwcmljZXNbaV0gLSBwcmljZXNbaSAtIDFdLCAwKTtcbiAgICByZXR1cm4gcmVzO1xuICB9XG4gIGNvbnN0IGhvbGQgPSBuZXcgQXJyYXkoayArIDEpLmZpbGwoTnVtYmVyLk1JTl9TQUZFX0lOVEVHRVIpO1xuICBjb25zdCByZWxlID0gbmV3IEFycmF5KGsgKyAxKS5maWxsKDApO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgY29uc3QgY3VyID0gcHJpY2VzW2ldO1xuICAgIGZvciAobGV0IGogPSBrOyBqID4gMDsgai0tKSB7XG4gICAgICByZWxlW2pdID0gTWF0aC5tYXgocmVsZVtqXSwgaG9sZFtqXSArIGN1cik7XG4gICAgICBob2xkW2pdID0gTWF0aC5tYXgoaG9sZFtqXSwgcmVsZVtqIC0gMV0gLSBjdXIpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVsZVtrXTtcbn1cblxuLy8gLS0tIHNxdWFyZSByb290IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8vIFwiU3F1YXJlIFJvb3RcIjogZ2l2ZW4gYSBiaWdpbnQsIHJldHVybiBmbG9vcihzcXJ0KG4pKS4gTmV3dG9uJ3Ncbi8vIG1ldGhvZCBvbiBiaWdpbnRzLiBUaGUgZ2FtZSBhbHdheXMgcGFzc2VzIGEgbm9uLW5lZ2F0aXZlXG4vLyBudW1iZXI7IGZvciBuPTAgd2UgcmV0dXJuIDBuLlxuZnVuY3Rpb24gYmlnaW50U3FydChuKSB7XG4gIGlmIChuIDwgMG4pIHRocm93IFwic3FydCBvZiBuZWdhdGl2ZVwiO1xuICBpZiAobiA8IDJuKSByZXR1cm4gbjtcbiAgLy8gSW5pdGlhbCBndWVzczogMSA8PCAoKGJpdC1sZW5ndGggb2YgbikgLyAyICsgMSkuIFRoaXNcbiAgLy8gaXMgYSBnZW5lcm91cyB1cHBlciBib3VuZC5cbiAgbGV0IHggPSBuO1xuICBsZXQgeSA9ICh4ICsgMW4pIC8gMm47XG4gIHdoaWxlICh5IDwgeCkge1xuICAgIHggPSB5O1xuICAgIHkgPSAoeCArIG4gLyB4KSAvIDJuO1xuICB9XG4gIHJldHVybiB4O1xufVxuXG4vLyAtLS0gdGhlIHJlZ2lzdHJ5IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLy8gTWFwIG9mIGNvbnRyYWN0IHR5cGUgKHRoZSBFWEFDVCBzdHJpbmcgcmV0dXJuZWQgYnlcbi8vIGdldENvbnRyYWN0VHlwZSkg4oaSIHNvbHZlciBmdW5jdGlvbi4gVGhlIHNjYW5uZXIgdXNlcyB0aGlzXG4vLyB0byBsb29rIHVwIHRoZSByaWdodCBzb2x2ZXIuIElmIGEgbmV3IGNvbnRyYWN0IHR5cGUgaXNcbi8vIGFkZGVkLCBqdXN0IGRyb3AgaW4gYW4gZW50cnkgaGVyZS5cbmV4cG9ydCBjb25zdCBTT0xWRVJTID0ge1xuICBcIkZpbmQgTGFyZ2VzdCBQcmltZSBGYWN0b3JcIjogICAgICAgICAgICAgICAgIChuKSA9PiBsYXJnZXN0UHJpbWVGYWN0b3IoTnVtYmVyKG4pKSxcbiAgXCJTdWJhcnJheSB3aXRoIE1heGltdW0gU3VtXCI6ICAgICAgICAgICAgICAgICAoYXJyKSA9PiBtYXhTdWJhcnJheVN1bShhcnIpLFxuICBcIlRvdGFsIFdheXMgdG8gU3VtXCI6ICAgICAgICAgICAgICAgICAgICAgICAgIChuKSA9PiB0b3RhbFdheXNUb1N1bShOdW1iZXIobikpLFxuICBcIlRvdGFsIFdheXMgdG8gU3VtIElJXCI6ICAgICAgICAgICAgICAgICAgICAgIChbbiwgc3VtbWFuZHNdKSA9PiB0b3RhbFdheXNUb1N1bUlJKG4sIHN1bW1hbmRzKSxcbiAgXCJTcGlyYWxpemUgTWF0cml4XCI6ICAgICAgICAgICAgICAgICAgICAgICAgICAobSkgPT4gc3BpcmFsaXplTWF0cml4KG0pLFxuICBcIkFycmF5IEp1bXBpbmcgR2FtZVwiOiAgICAgICAgICAgICAgICAgICAgICAgIChhcnIpID0+IGFycmF5SnVtcGluZ0dhbWUoYXJyKSxcbiAgXCJBcnJheSBKdW1waW5nIEdhbWUgSUlcIjogICAgICAgICAgICAgICAgICAgICAoYXJyKSA9PiBhcnJheUp1bXBpbmdHYW1lSUkoYXJyKSxcbiAgXCJNZXJnZSBPdmVybGFwcGluZyBJbnRlcnZhbHNcIjogICAgICAgICAgICAgICAoaW50ZXJ2YWxzKSA9PiBtZXJnZUludGVydmFscyhpbnRlcnZhbHMpLFxuICBcIkdlbmVyYXRlIElQIEFkZHJlc3Nlc1wiOiAgICAgICAgICAgICAgICAgICAgIChzKSA9PiBnZW5lcmF0ZUlQQWRkcmVzc2VzKHMpLFxuICBcIkFsZ29yaXRobWljIFN0b2NrIFRyYWRlciBJXCI6ICAgICAgICAgICAgICAgIChwcmljZXMpID0+IHN0b2NrVHJhZGVySShwcmljZXMpLFxuICBcIkFsZ29yaXRobWljIFN0b2NrIFRyYWRlciBJSVwiOiAgICAgICAgICAgICAgIChwcmljZXMpID0+IHN0b2NrVHJhZGVySUkocHJpY2VzKSxcbiAgXCJBbGdvcml0aG1pYyBTdG9jayBUcmFkZXIgSUlJXCI6ICAgICAgICAgICAgICAocHJpY2VzKSA9PiBzdG9ja1RyYWRlcklJSShwcmljZXMpLFxuICBcIkFsZ29yaXRobWljIFN0b2NrIFRyYWRlciBJVlwiOiAgICAgICAgICAgICAgIChbaywgcHJpY2VzXSkgPT4gc3RvY2tUcmFkZXJJVihrLCBwcmljZXMpLFxuICBcIk1pbmltdW0gUGF0aCBTdW0gaW4gYSBUcmlhbmdsZVwiOiAgICAgICAgICAgICh0cmkpID0+IG1pblBhdGhUcmlhbmdsZSh0cmkpLFxuICBcIlVuaXF1ZSBQYXRocyBpbiBhIEdyaWQgSVwiOiAgICAgICAgICAgICAgICAgIChbbSwgbl0pID0+IHVuaXF1ZVBhdGhzSShtLCBuKSxcbiAgXCJVbmlxdWUgUGF0aHMgaW4gYSBHcmlkIElJXCI6ICAgICAgICAgICAgICAgICAoZ3JpZCkgPT4gdW5pcXVlUGF0aHNJSShncmlkKSxcbiAgXCJTaG9ydGVzdCBQYXRoIGluIGEgR3JpZFwiOiAgICAgICAgICAgICAgICAgICAoZ3JpZCkgPT4gc2hvcnRlc3RQYXRoR3JpZChncmlkKSxcbiAgXCJTYW5pdGl6ZSBQYXJlbnRoZXNlcyBpbiBFeHByZXNzaW9uXCI6ICAgICAgICAocykgPT4gc2FuaXRpemVQYXJlbnRoZXNlcyhzKSxcbiAgXCJGaW5kIEFsbCBWYWxpZCBNYXRoIEV4cHJlc3Npb25zXCI6ICAgICAgICAgICAoW2RpZ2l0cywgdGFyZ2V0XSkgPT4gZmluZEFsbFZhbGlkTWF0aEV4cHJlc3Npb25zKGRpZ2l0cywgdGFyZ2V0KSxcbiAgXCJIYW1taW5nQ29kZXM6IEludGVnZXIgdG8gRW5jb2RlZCBCaW5hcnlcIjogICAobikgPT4gaGFtbWluZ0VuY29kZShOdW1iZXIobikpLFxuICBcIkhhbW1pbmdDb2RlczogRW5jb2RlZCBCaW5hcnkgdG8gSW50ZWdlclwiOiAgIChzKSA9PiBoYW1taW5nRGVjb2RlKHMpLFxuICBcIlByb3BlciAyLUNvbG9yaW5nIG9mIGEgR3JhcGhcIjogICAgICAgICAgICAgIChbbiwgZWRnZXNdKSA9PiB0d29Db2xvckdyYXBoKG4sIGVkZ2VzKSxcbiAgXCJDb21wcmVzc2lvbiBJOiBSTEUgQ29tcHJlc3Npb25cIjogICAgICAgICAgICAocykgPT4gcmxlQ29tcHJlc3MocyksXG4gIFwiQ29tcHJlc3Npb24gSUk6IExaIERlY29tcHJlc3Npb25cIjogICAgICAgICAgKHMpID0+IGx6RGVjb21wcmVzcyhzKSxcbiAgXCJDb21wcmVzc2lvbiBJSUk6IExaIENvbXByZXNzaW9uXCI6ICAgICAgICAgICAocykgPT4gbHpDb21wcmVzcyhzKSxcbiAgXCJFbmNyeXB0aW9uIEk6IENhZXNhciBDaXBoZXJcIjogICAgICAgICAgICAgICAoW3RleHQsIHNoaWZ0XSkgPT4gY2Flc2FyQ2lwaGVyKHRleHQsIHNoaWZ0KSxcbiAgXCJFbmNyeXB0aW9uIElJOiBWaWdlbsOocmUgQ2lwaGVyXCI6ICAgICAgICAgICAgKFt0ZXh0LCBrZXldKSA9PiB2aWdlbmVyZUNpcGhlcih0ZXh0LCBrZXkpLFxuICBcIlNxdWFyZSBSb290XCI6ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChuKSA9PiBiaWdpbnRTcXJ0KEJpZ0ludChuKSkudG9TdHJpbmcoKSxcbiAgXCJUb3RhbCBOdW1iZXIgb2YgUHJpbWVzXCI6ICAgICAgICAgICAgICAgICAgICAoW2xvLCBoaV0pID0+IGNvdW50UHJpbWVzKGxvLCBoaSksXG4gIFwiTGFyZ2VzdCBSZWN0YW5nbGUgaW4gYSBNYXRyaXhcIjogICAgICAgICAgICAgKGdyaWQpID0+IGxhcmdlc3RSZWN0YW5nbGVNYXRyaXgoZ3JpZCksXG59O1xuIl19