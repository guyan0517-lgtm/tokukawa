(function(global) {
"use strict";
/**
 * pdf-encrypt-lite - Ultra-lightweight PDF encryption library
 * Powers PDFSmaller.com's PDF encryption tool
 *
 * @author PDFSmaller.com (https://pdfsmaller.com)
 * @license MIT
 * @see https://pdfsmaller.com/protect-pdf - Try it online!
 *
 * This minimal cryptographic implementation was built to solve the "impossible"
 * problem of real PDF encryption within Cloudflare Workers' 1MB limit.
 * Total size: ~7KB for complete PDF encryption!
 */

// Minimal cryptographic functions for PDF encryption
// Implements only what's needed for PDF Standard Security Handler

/**
 * Minimal MD5 implementation
 * Based on the MD5 algorithm - only what's needed for PDF encryption
 * Part of PDFSmaller.com's ultra-lightweight encryption engine
 */
function md5(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

  // Initialize MD5 constants
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  const K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ]);

  // Initialize hash values
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  // Pre-processing
  const msgLen = bytes.length;
  const msgBitLen = msgLen * 8;
  const msgLenPadded = ((msgLen + 9 + 63) & ~63);
  const msg = new Uint8Array(msgLenPadded);
  msg.set(bytes);
  msg[msgLen] = 0x80;

  // Append length in bits
  const dataView = new DataView(msg.buffer);
  dataView.setUint32(msgLenPadded - 8, msgBitLen, true);
  dataView.setUint32(msgLenPadded - 4, 0, true);

  // Process message in 512-bit chunks
  for (let offset = 0; offset < msgLenPadded; offset += 64) {
    const chunk = new Uint32Array(msg.buffer, offset, 16);

    let a = a0, b = b0, c = c0, d = d0;

    for (let i = 0; i < 64; i++) {
      let f, g;

      if (i < 16) {
        f = (b & c) | ((~b) & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | ((~d) & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | (~d));
        g = (7 * i) % 16;
      }

      f = (f + a + K[i] + chunk[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((f << S[i]) | (f >>> (32 - S[i])))) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  // Produce the final hash value
  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  view.setUint32(0, a0, true);
  view.setUint32(4, b0, true);
  view.setUint32(8, c0, true);
  view.setUint32(12, d0, true);

  return result;
}

/**
 * RC4 encryption/decryption
 * RC4 is symmetric, so encryption and decryption are the same operation
 * Part of PDFSmaller.com's ultra-lightweight encryption engine
 */
class RC4 {
  constructor(key) {
    this.s = new Uint8Array(256);
    this.i = 0;
    this.j = 0;

    // Key scheduling algorithm (KSA)
    for (let i = 0; i < 256; i++) {
      this.s[i] = i;
    }

    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + this.s[i] + key[i % key.length]) & 0xFF;
      // Swap
      [this.s[i], this.s[j]] = [this.s[j], this.s[i]];
    }
  }

  /**
   * Encrypt/decrypt data
   * @param {Uint8Array} data - Data to encrypt or decrypt
   * @returns {Uint8Array} - Encrypted/decrypted data
   */
  process(data) {
    const result = new Uint8Array(data.length);

    for (let k = 0; k < data.length; k++) {
      this.i = (this.i + 1) & 0xFF;
      this.j = (this.j + this.s[this.i]) & 0xFF;

      // Swap
      [this.s[this.i], this.s[this.j]] = [this.s[this.j], this.s[this.i]];

      const t = (this.s[this.i] + this.s[this.j]) & 0xFF;
      result[k] = data[k] ^ this.s[t];
    }

    return result;
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}



/**
 * AES-256 cryptographic utilities for PDF decryption (R=6)
 * Uses Web Crypto API — works in browsers, Cloudflare Workers, Deno, Node 18+
 *
 * @author PDFSmaller.com (https://pdfsmaller.com)
 * @license MIT
 *
 * Includes encrypt-side functions (needed for Algorithm 2.B's AES-128-CBC encrypt step)
 * plus decrypt functions for AES-256-CBC/ECB used in PDF object decryption.
 *
 * Implements Algorithm 2.B from ISO 32000-2:2020
 * Verified against mozilla/pdf.js (the reference implementation)
 */

/**
 * Concatenate multiple Uint8Arrays
 */
function concat(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ========== SHA Hash Functions (Web Crypto) ==========

async function sha256(data) {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

async function sha384(data) {
  const hash = await crypto.subtle.digest('SHA-384', data);
  return new Uint8Array(hash);
}

async function sha512(data) {
  const hash = await crypto.subtle.digest('SHA-512', data);
  return new Uint8Array(hash);
}

// ========== AES Encryption (Web Crypto) ==========
// These encrypt functions are needed because Algorithm 2.B uses aes128CbcEncrypt
// even during the decryption password validation flow.

/**
 * AES-128-CBC encrypt (for Algorithm 2.B intermediate step)
 * Strips PKCS#7 padding since input is always block-aligned
 */
async function aes128CbcEncrypt(data, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  // Strip PKCS#7 padding block (data is always block-aligned in Algorithm 2.B)
  return new Uint8Array(encrypted).slice(0, data.byteLength);
}

// ========== AES Decryption (Web Crypto) ==========

/**
 * AES-256-CBC decrypt with PKCS#7 padding removal (for per-object decryption)
 * Standard Web Crypto decrypt — handles padding automatically.
 *
 * @param {Uint8Array} data - Ciphertext (must be multiple of 16 bytes)
 * @param {Uint8Array} key - 32-byte AES-256 key
 * @param {Uint8Array} iv - 16-byte initialization vector
 * @returns {Promise<Uint8Array>} - Decrypted plaintext
 */
async function aes256CbcDecrypt(data, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(decrypted);
}

/**
 * AES-256-CBC decrypt without padding (for UE/OE — exactly 32 bytes, no PKCS#7)
 *
 * Web Crypto mandates PKCS#7 padding and has no "no-padding" option.
 * We use a forged padding block trick:
 *
 * 1. Take the last ciphertext block C_last
 * 2. XOR it with [0x10 * 16] (the PKCS#7 padding for a full block)
 * 3. AES-ECB encrypt the result: C_fake = AES_ENC_K(C_last XOR [0x10*16])
 * 4. Append C_fake to the ciphertext
 * 5. Web Crypto decrypts all blocks and finds valid PKCS#7 padding in C_fake
 * 6. Result = correctly decrypted original bytes (32 bytes for UE/OE)
 *
 * Why this works:
 *   AES_DEC(C_fake) XOR C_last
 *   = AES_DEC(AES_ENC(C_last XOR [0x10*16])) XOR C_last
 *   = (C_last XOR [0x10*16]) XOR C_last
 *   = [0x10*16]  ← valid PKCS#7 padding!
 *
 * @param {Uint8Array} ciphertext - Ciphertext (32 bytes for UE/OE)
 * @param {Uint8Array} key - 32-byte AES-256 key
 * @param {Uint8Array} iv - 16-byte initialization vector
 * @returns {Promise<Uint8Array>} - Decrypted plaintext (same length as ciphertext)
 */
async function aes256CbcDecryptNoPad(ciphertext, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt']);

  // Get the last ciphertext block
  const lastBlock = ciphertext.slice(ciphertext.length - 16);

  // XOR with PKCS#7 full-block padding value (0x10 = 16)
  const xored = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    xored[i] = lastBlock[i] ^ 0x10;
  }

  // AES-ECB encrypt the XORed block (CBC with zero IV = ECB for single block)
  const zeroIV = new Uint8Array(16);
  const encResult = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, cryptoKey, xored);
  const cFake = new Uint8Array(encResult).slice(0, 16);

  // Append forged block to ciphertext
  const extended = concat(ciphertext, cFake);

  // Decrypt — Web Crypto will find valid PKCS#7 padding and strip it
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, extended);
  return new Uint8Array(decrypted).slice(0, ciphertext.length);
}

/**
 * AES-256-ECB decrypt a single 16-byte block (for Perms verification)
 * Uses the same forged padding block trick as aes256CbcDecryptNoPad.
 *
 * @param {Uint8Array} block - 16-byte ciphertext block
 * @param {Uint8Array} key - 32-byte AES-256 key
 * @returns {Promise<Uint8Array>} - 16-byte decrypted block
 */
async function aes256EcbDecryptBlock(block, key) {
  const zeroIV = new Uint8Array(16);
  return aes256CbcDecryptNoPad(block, key, zeroIV);
}

/**
 * Import an AES-256 key for reuse across multiple decrypt operations
 *
 * @param {Uint8Array} key - 32-byte AES-256 key
 * @returns {Promise<CryptoKey>} - Imported CryptoKey for decryption
 */
async function importAES256DecryptKey(key) {
  return await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt']);
}

/**
 * AES-256-CBC decrypt using a pre-imported CryptoKey (for per-object bulk decryption)
 * Handles PKCS#7 padding removal automatically.
 *
 * @param {Uint8Array} data - Ciphertext (must be multiple of 16 bytes)
 * @param {CryptoKey} cryptoKey - Pre-imported AES-256 CryptoKey
 * @param {Uint8Array} iv - 16-byte initialization vector
 * @returns {Promise<Uint8Array>} - Decrypted plaintext
 */
async function aes256CbcDecryptWithKey(data, cryptoKey, iv) {
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(decrypted);
}

// ========== Algorithm 2.B (ISO 32000-2:2020) ==========

/**
 * Algorithm 2.B — Computing a hash for R=6
 *
 * This is the hardened key derivation function used by PDF 2.0 (AES-256).
 * Iterates SHA-256/384/512 + AES-128-CBC for at least 64 rounds.
 *
 * Note: Algorithm 2.B uses AES-128-CBC *encrypt* (not decrypt) even during
 * the decryption/validation flow. This is by design per the PDF spec.
 *
 * Verified against mozilla/pdf.js (PDF20._hash)
 *
 * @param {Uint8Array} password - UTF-8 password bytes (max 127)
 * @param {Uint8Array} salt - 8-byte salt
 * @param {Uint8Array} userKey - 48-byte U value (for owner ops) or empty
 * @returns {Promise<Uint8Array>} - 32-byte hash
 */
async function computeHash2B(password, salt, userKey) {
  // Step 1: Initial SHA-256 hash
  const input = concat(password, salt, userKey);
  let K = await sha256(input);

  // Step 2: Iterative loop (minimum 64 rounds)
  let i = 0;
  let E;

  while (true) {
    // Step 2a: K1 = (password + K + userKey) repeated 64 times
    const block = concat(password, K, userKey);
    const K1 = new Uint8Array(block.length * 64);
    for (let j = 0; j < 64; j++) {
      K1.set(block, j * block.length);
    }

    // Step 2b: AES-128-CBC encrypt K1
    // Key = K[0..15], IV = K[16..31]
    const aesKey = K.slice(0, 16);
    const aesIV = K.slice(16, 32);
    E = await aes128CbcEncrypt(K1, aesKey, aesIV);

    // Step 2c: Hash function selection
    // Sum first 16 bytes of E mod 3 (equivalent to 128-bit big-endian mod 3)
    let byteSum = 0;
    for (let j = 0; j < 16; j++) {
      byteSum += E[j];
    }
    const hashSelect = byteSum % 3;

    // Step 2d: Hash E with selected function
    if (hashSelect === 0) {
      K = await sha256(E);
    } else if (hashSelect === 1) {
      K = await sha384(E);
    } else {
      K = await sha512(E);
    }

    // Step 2e: Termination (per pdf.js: while i < 64 || E[-1] > i - 32)
    i++;
    if (i >= 64 && E[E.length - 1] <= i - 32) {
      break;
    }
  }

  return K.slice(0, 32);
}



/**
 * @pdfsmaller/pdf-decrypt — PDF decryption with AES-256 and RC4 support
 * Powers PDFSmaller.com's Unlock PDF tool
 *
 * @author PDFSmaller.com (https://pdfsmaller.com)
 * @license MIT
 * @see https://pdfsmaller.com/unlock-pdf - Try it online!
 *
 * Implements:
 *   - AES-256 (V=5, R=6) per ISO 32000-2:2020 — Algorithms 2.A, 2.B, 11, 12, 13
 *   - RC4 128-bit (V=2, R=3) per ISO 32000-1:2008 — Algorithms 2, 4, 5, 7
 *   - RC4 40-bit (V=1, R=2) per ISO 32000-1:2008
 *
 * Companion to @pdfsmaller/pdf-encrypt
 * Verified against mozilla/pdf.js and Adobe Acrobat
 */

const { PDFDocument, PDFName, PDFHexString, PDFString, PDFDict, PDFArray, PDFRawStream, PDFNumber, PDFRef } = (typeof window !== 'undefined' && window.PDFLib) || (typeof global !== 'undefined' && global.PDFLib) || (typeof PDFLib !== 'undefined' ? PDFLib : {});



// ========== Constants ==========

// Standard PDF padding string (from PDF specification)
const PADDING = new Uint8Array([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
  0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

// Batch size for parallel AES-256 decryption
const BATCH_SIZE = 100;

// ========== Helper Functions ==========

/**
 * Compare two Uint8Arrays for equality
 */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Extract bytes from a PDF string value (handles both hex and literal strings)
 */
function extractBytes(pdfObj) {
  if (!pdfObj) return null;

  if (pdfObj instanceof PDFHexString) {
    return hexToBytes(pdfObj.asString());
  }

  if (pdfObj instanceof PDFString) {
    return pdfObj.asBytes();
  }

  // Handle raw string representation (fallback)
  const str = pdfObj.toString();
  if (str.startsWith('<') && str.endsWith('>')) {
    return hexToBytes(str.slice(1, -1));
  }

  return null;
}

/**
 * Truncate password to 127 bytes (UTF-8) per PDF 2.0 spec
 */
function saslPrepPassword(password) {
  const bytes = new TextEncoder().encode(password);
  return bytes.length > 127 ? bytes.slice(0, 127) : bytes;
}

// ========== Encryption Parameter Reading ==========

/**
 * Read the encryption parameters from a PDF's trailer
 * Supports V=1-2 (RC4) and V=5 (AES-256)
 */
function readEncryptParams(context) {
  const trailer = context.trailerInfo;

  // Get /Encrypt reference
  const encryptRef = trailer.Encrypt;
  if (!encryptRef) {
    return null;
  }

  // Resolve the encrypt dictionary
  let encryptDict;
  if (encryptRef instanceof PDFRef) {
    encryptDict = context.lookup(encryptRef);
  } else if (encryptRef instanceof PDFDict) {
    encryptDict = encryptRef;
  } else {
    return null;
  }

  if (!encryptDict || !(encryptDict instanceof PDFDict)) {
    return null;
  }

  // Read basic encryption parameters
  const V = encryptDict.get(PDFName.of('V'));
  const R = encryptDict.get(PDFName.of('R'));
  const Length = encryptDict.get(PDFName.of('Length'));
  const P = encryptDict.get(PDFName.of('P'));
  const O = encryptDict.get(PDFName.of('O'));
  const U = encryptDict.get(PDFName.of('U'));

  const version = V ? (typeof V.asNumber === 'function' ? V.asNumber() : Number(V.toString())) : 0;
  const revision = R ? (typeof R.asNumber === 'function' ? R.asNumber() : Number(R.toString())) : 0;

  // Extract permissions (signed 32-bit integer)
  const permissions = P ? (typeof P.asNumber === 'function' ? P.asNumber() : Number(P.toString())) : 0;

  // Extract O and U values
  const ownerKey = extractBytes(O);
  const userKey = extractBytes(U);

  if (!ownerKey || !userKey) {
    throw new Error('Could not read /O or /U values from encryption dictionary');
  }

  // Extract file ID
  let fileId = new Uint8Array(0);
  const idArray = trailer.ID;

  if (idArray) {
    if (Array.isArray(idArray) && idArray.length > 0) {
      fileId = extractBytes(idArray[0]) || new Uint8Array(0);
    } else if (idArray instanceof PDFArray) {
      const firstId = idArray.lookup(0);
      fileId = extractBytes(firstId) || new Uint8Array(0);
    }
  }

  // Base params (shared by RC4 and AES-256)
  const params = {
    version,
    revision,
    ownerKey,
    userKey,
    permissions,
    fileId,
    encryptRef,
    encryptDict
  };

  // V=5, R=6: AES-256 specific fields
  if (version === 5 && revision === 6) {
    const OE = encryptDict.get(PDFName.of('OE'));
    const UE = encryptDict.get(PDFName.of('UE'));
    const Perms = encryptDict.get(PDFName.of('Perms'));
    const EncryptMetadata = encryptDict.get(PDFName.of('EncryptMetadata'));

    params.ownerEncryptKey = extractBytes(OE);
    params.userEncryptKey = extractBytes(UE);
    params.perms = extractBytes(Perms);

    if (!params.ownerEncryptKey || !params.userEncryptKey || !params.perms) {
      throw new Error('Missing /OE, /UE, or /Perms in AES-256 encryption dictionary');
    }

    // EncryptMetadata defaults to true per spec
    if (EncryptMetadata) {
      const emStr = EncryptMetadata.toString();
      params.encryptMetadata = emStr !== 'false';
    } else {
      params.encryptMetadata = true;
    }

    params.algorithm = 'AES-256';
    params.keyLength = 32;
  } else if (version <= 3 && revision <= 4) {
    // RC4 (V=1-2, R=2-3)
    let keyLengthBits = Length ? (typeof Length.asNumber === 'function' ? Length.asNumber() : Number(Length.toString())) : 40;
    if (revision >= 3 && !Length) keyLengthBits = 128;
    params.keyLength = keyLengthBits / 8;
    params.algorithm = 'RC4';
  } else {
    throw new Error(
      `Unsupported encryption: V=${version}, R=${revision}. ` +
      `pdf-decrypt supports RC4 (V=1-2, R=2-3) and AES-256 (V=5, R=6).`
    );
  }

  return params;
}

// ========== RC4 Password Validation & Decryption ==========

/**
 * Pad or truncate password according to PDF spec (RC4)
 */
function padPassword(password) {
  const pwdBytes = typeof password === 'string' ? new TextEncoder().encode(password) : password;
  const padded = new Uint8Array(32);

  if (pwdBytes.length >= 32) {
    padded.set(pwdBytes.slice(0, 32));
  } else {
    padded.set(pwdBytes);
    padded.set(PADDING.slice(0, 32 - pwdBytes.length), pwdBytes.length);
  }

  return padded;
}

/**
 * Compute encryption key (Algorithm 2 from PDF spec)
 * Works for both Rev 2 (RC4-40) and Rev 3 (RC4-128)
 */
function computeEncryptionKey(password, ownerKey, permissions, fileId, revision, keyLength) {
  const paddedPwd = padPassword(password);

  const hashInput = new Uint8Array(
    paddedPwd.length +
    ownerKey.length +
    4 + // permissions
    fileId.length
  );

  let offset = 0;
  hashInput.set(paddedPwd, offset);
  offset += paddedPwd.length;

  hashInput.set(ownerKey, offset);
  offset += ownerKey.length;

  // Add permissions (low-order byte first)
  hashInput[offset++] = permissions & 0xFF;
  hashInput[offset++] = (permissions >> 8) & 0xFF;
  hashInput[offset++] = (permissions >> 16) & 0xFF;
  hashInput[offset++] = (permissions >> 24) & 0xFF;

  hashInput.set(fileId, offset);

  let hash = md5(hashInput);

  // For Rev 3+, do 50 additional MD5 iterations
  if (revision >= 3) {
    const n = keyLength;
    for (let i = 0; i < 50; i++) {
      hash = md5(hash.slice(0, n));
    }
  }

  return hash.slice(0, keyLength);
}

/**
 * Validate user password — Algorithm 4 (Rev 2) / Algorithm 5 (Rev 3)
 * Returns the encryption key if valid, null if invalid
 */
function validateUserPasswordRC4(password, encryptParams) {
  const { ownerKey, userKey, permissions, fileId, revision, keyLength } = encryptParams;

  const encryptionKey = computeEncryptionKey(password, ownerKey, permissions, fileId, revision, keyLength);

  if (revision === 2) {
    // Algorithm 4: RC4 encrypt the padding with the key, compare to /U
    const rc4 = new RC4(encryptionKey);
    const computed = rc4.process(new Uint8Array(PADDING));

    if (arraysEqual(computed, userKey)) {
      return encryptionKey;
    }
  } else {
    // Algorithm 5 (Rev 3):
    // 1. MD5(PADDING + fileId)
    const hashInput = new Uint8Array(PADDING.length + fileId.length);
    hashInput.set(PADDING);
    hashInput.set(fileId, PADDING.length);
    const hash = md5(hashInput);

    // 2. RC4 encrypt with key, then 19 more iterations with key XOR i
    let result = new RC4(encryptionKey).process(hash);
    for (let i = 1; i <= 19; i++) {
      const iterKey = new Uint8Array(encryptionKey.length);
      for (let j = 0; j < encryptionKey.length; j++) {
        iterKey[j] = encryptionKey[j] ^ i;
      }
      result = new RC4(iterKey).process(result);
    }

    // 3. Compare first 16 bytes with stored /U
    if (arraysEqual(result.slice(0, 16), userKey.slice(0, 16))) {
      return encryptionKey;
    }
  }

  return null;
}

/**
 * Validate owner password — Algorithm 7 (Rev 3) / simplified for Rev 2
 * Recovers the user password from the owner password, then validates as user
 * Returns the encryption key if valid, null if invalid
 */
function validateOwnerPasswordRC4(ownerPassword, encryptParams) {
  const { ownerKey, revision, keyLength } = encryptParams;

  // Step 1: Pad the owner password
  const paddedOwner = padPassword(ownerPassword);

  // Step 2: MD5 hash
  let hash = md5(paddedOwner);

  // Step 3: For Rev 3+, 50 additional MD5 iterations
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) {
      hash = md5(hash);
    }
  }

  const ownerDecryptKey = hash.slice(0, keyLength);

  // Step 4: Decrypt /O to recover user password
  let recoveredUserPwd;

  if (revision === 2) {
    // Simple RC4 decrypt
    const rc4 = new RC4(ownerDecryptKey);
    recoveredUserPwd = rc4.process(new Uint8Array(ownerKey));
  } else {
    // Rev 3: Reverse the 20-iteration RC4 (i = 19 → 0)
    let result = new Uint8Array(ownerKey);
    for (let i = 19; i >= 0; i--) {
      const iterKey = new Uint8Array(ownerDecryptKey.length);
      for (let j = 0; j < ownerDecryptKey.length; j++) {
        iterKey[j] = ownerDecryptKey[j] ^ i;
      }
      result = new RC4(iterKey).process(result);
    }
    recoveredUserPwd = result;
  }

  // Step 5: Use recovered user password to validate
  return validateUserPasswordRC4(recoveredUserPwd, encryptParams);
}

/**
 * Decrypt data for a specific object using RC4
 */
function decryptObjectRC4(data, objectNum, generationNum, encryptionKey) {
  // Create object-specific key
  const keyInput = new Uint8Array(encryptionKey.length + 5);
  keyInput.set(encryptionKey);

  // Add object number (low byte first)
  keyInput[encryptionKey.length] = objectNum & 0xFF;
  keyInput[encryptionKey.length + 1] = (objectNum >> 8) & 0xFF;
  keyInput[encryptionKey.length + 2] = (objectNum >> 16) & 0xFF;

  // Add generation number (low byte first)
  keyInput[encryptionKey.length + 3] = generationNum & 0xFF;
  keyInput[encryptionKey.length + 4] = (generationNum >> 8) & 0xFF;

  // Hash to get object key
  const objectKey = md5(keyInput);

  // Use up to 16 bytes of the hash as the key
  const rc4 = new RC4(objectKey.slice(0, Math.min(encryptionKey.length + 5, 16)));

  return rc4.process(data);
}

/**
 * Recursively decrypt strings in a PDF object (RC4 mode)
 */
function decryptStringsRC4(obj, objectNum, generationNum, encryptionKey) {
  if (!obj) return;

  if (obj instanceof PDFString) {
    const originalBytes = obj.asBytes();
    const decrypted = decryptObjectRC4(originalBytes, objectNum, generationNum, encryptionKey);
    // Convert bytes back to string via charCode (NOT bytesToHex)
    obj.value = Array.from(decrypted).map(b => String.fromCharCode(b)).join('');
  } else if (obj instanceof PDFHexString) {
    const originalBytes = obj.asBytes();
    const decrypted = decryptObjectRC4(originalBytes, objectNum, generationNum, encryptionKey);
    obj.value = bytesToHex(decrypted);
  } else if (obj instanceof PDFDict) {
    const entries = obj.entries();
    for (const [key, value] of entries) {
      const keyName = key.asString();
      // Skip encryption-related entries
      if (keyName !== '/Length' && keyName !== '/Filter' && keyName !== '/DecodeParms') {
        decryptStringsRC4(value, objectNum, generationNum, encryptionKey);
      }
    }
  } else if (obj instanceof PDFArray) {
    const array = obj.asArray();
    for (const element of array) {
      decryptStringsRC4(element, objectNum, generationNum, encryptionKey);
    }
  }
}

// ========== AES-256 Password Validation ==========

/**
 * Validate user password for AES-256 (Algorithm 11 / ISO 32000-2)
 *
 * Steps:
 * 1. hash2B(password, U[32:40], []) → compare with U[0:32]
 * 2. If match: hash2B(password, U[40:48], []) → decrypt UE → file key
 *
 * @returns {Promise<Uint8Array|null>} - 32-byte file key if valid, null if invalid
 */
async function validateUserPasswordAES256(password, encryptParams) {
  const { userKey, userEncryptKey } = encryptParams;

  // U validation salt = U[32:40]
  const validationSalt = userKey.slice(32, 40);
  const hash = await computeHash2B(password, validationSalt, new Uint8Array(0));

  // Compare hash with U[0:32]
  if (!arraysEqual(hash, userKey.slice(0, 32))) {
    return null;
  }

  // Password valid — derive file key from UE
  // Key salt = U[40:48]
  const keySalt = userKey.slice(40, 48);
  const ueKey = await computeHash2B(password, keySalt, new Uint8Array(0));
  const zeroIV = new Uint8Array(16);
  const fileKey = await aes256CbcDecryptNoPad(userEncryptKey, ueKey, zeroIV);

  return fileKey;
}

/**
 * Validate owner password for AES-256 (Algorithm 12 / ISO 32000-2)
 *
 * Steps:
 * 1. hash2B(password, O[32:40], U) → compare with O[0:32]
 * 2. If match: hash2B(password, O[40:48], U) → decrypt OE → file key
 *
 * @returns {Promise<Uint8Array|null>} - 32-byte file key if valid, null if invalid
 */
async function validateOwnerPasswordAES256(password, encryptParams) {
  const { ownerKey, userKey, ownerEncryptKey } = encryptParams;

  // O validation salt = O[32:40], userKey = full 48-byte U value
  const validationSalt = ownerKey.slice(32, 40);
  const hash = await computeHash2B(password, validationSalt, userKey);

  // Compare hash with O[0:32]
  if (!arraysEqual(hash, ownerKey.slice(0, 32))) {
    return null;
  }

  // Password valid — derive file key from OE
  // Key salt = O[40:48]
  const keySalt = ownerKey.slice(40, 48);
  const oeKey = await computeHash2B(password, keySalt, userKey);
  const zeroIV = new Uint8Array(16);
  const fileKey = await aes256CbcDecryptNoPad(ownerEncryptKey, oeKey, zeroIV);

  return fileKey;
}

/**
 * Verify Perms value (Algorithm 13 / ISO 32000-2)
 * Decrypts /Perms with the file key and checks consistency
 *
 * @returns {boolean} - true if Perms is valid
 */
async function verifyPerms(fileKey, encryptParams) {
  const { perms, permissions, encryptMetadata } = encryptParams;

  try {
    const decrypted = await aes256EcbDecryptBlock(perms, fileKey);

    // Bytes 0-3 should match permissions (little-endian)
    const p0 = decrypted[0] | (decrypted[1] << 8) | (decrypted[2] << 16) | (decrypted[3] << 24);
    if ((p0 | 0) !== (permissions | 0)) {
      return false;
    }

    // Byte 8 should be 'T' (0x54) or 'F' (0x46)
    const expectedEM = encryptMetadata ? 0x54 : 0x46;
    if (decrypted[8] !== expectedEM) {
      return false;
    }

    // Bytes 9-11 should be 'a', 'd', 'b'
    if (decrypted[9] !== 0x61 || decrypted[10] !== 0x64 || decrypted[11] !== 0x62) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ========== AES-256 Object Decryption (Batched) ==========

/**
 * Collect all encrypted items from the PDF object tree (synchronous traversal)
 * Returns arrays of items that need AES-256 decryption
 */
function collectEncryptedItems(context, encryptRefNum, encryptMetadata) {
  const streamItems = [];
  const stringItems = [];
  const indirectObjects = context.enumerateIndirectObjects();

  for (const [ref, obj] of indirectObjects) {
    const objectNum = ref.objectNumber;
    const generationNum = ref.generationNumber || 0;

    // Skip the encryption dictionary itself
    if (encryptRefNum !== null && objectNum === encryptRefNum) {
      continue;
    }

    // Skip signature dictionaries — /Contents and /ByteRange must not be decrypted
    // per PDF spec Section 7.6.1 (applies to both stream and non-stream /Sig objects)
    if (obj instanceof PDFDict && !(obj instanceof PDFRawStream)) {
      const type = obj.get(PDFName.of('Type'));
      if (type && type.toString() === '/Sig') continue;
    }

    // Check if this is a stream with a /Type we should skip
    if (obj instanceof PDFRawStream && obj.dict) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type) {
        const typeName = type.toString();
        // XRef streams are never encrypted
        if (typeName === '/XRef') continue;
        // Signature streams must not be decrypted
        if (typeName === '/Sig') continue;
        // Skip metadata streams when EncryptMetadata is false
        if (typeName === '/Metadata' && !encryptMetadata) continue;
      }
    }

    // Collect streams for decryption
    if (obj instanceof PDFRawStream) {
      const streamData = obj.contents;
      // AES-256 streams: IV (16 bytes) + ciphertext
      if (streamData.length >= 16) {
        streamItems.push({ ref, obj, data: streamData, objectNum, generationNum });
      }

      // Collect strings in stream dictionaries
      if (obj.dict) {
        collectStringsFromObject(obj.dict, objectNum, generationNum, stringItems);
      }
    }

    // Collect strings in non-stream objects
    if (!(obj instanceof PDFRawStream)) {
      collectStringsFromObject(obj, objectNum, generationNum, stringItems);
    }
  }

  return { streamItems, stringItems };
}

/**
 * Recursively collect encrypted strings from a PDF object (synchronous)
 */
function collectStringsFromObject(obj, objectNum, generationNum, items) {
  if (!obj) return;

  if (obj instanceof PDFString) {
    const bytes = obj.asBytes();
    if (bytes.length >= 16) {
      items.push({ obj, bytes, type: 'string', objectNum, generationNum });
    }
  } else if (obj instanceof PDFHexString) {
    const bytes = obj.asBytes();
    if (bytes.length >= 16) {
      items.push({ obj, bytes, type: 'hex', objectNum, generationNum });
    }
  } else if (obj instanceof PDFDict) {
    for (const [key, value] of obj.entries()) {
      const keyName = key.asString();
      if (keyName !== '/Length' && keyName !== '/Filter' && keyName !== '/DecodeParms') {
        collectStringsFromObject(value, objectNum, generationNum, items);
      }
    }
  } else if (obj instanceof PDFArray) {
    for (const element of obj.asArray()) {
      collectStringsFromObject(element, objectNum, generationNum, items);
    }
  }
}

/**
 * Decrypt a single AES-256 encrypted blob (IV prepended)
 * Per PDF 2.0: first 16 bytes are the IV, rest is ciphertext
 */
async function decryptAES256Blob(data, cryptoKey) {
  const iv = data.slice(0, 16);
  const ciphertext = data.slice(16);

  // Edge case: empty ciphertext after IV
  if (ciphertext.length === 0) {
    return new Uint8Array(0);
  }

  // Ciphertext must be a multiple of 16 bytes for AES-CBC
  if (ciphertext.length % 16 !== 0) {
    return data; // Return original data if not valid AES-CBC
  }

  try {
    return await aes256CbcDecryptWithKey(ciphertext, cryptoKey, iv);
  } catch {
    // If decryption fails (e.g., invalid padding), return original
    return data;
  }
}

/**
 * Decrypt all collected items in batches using Promise.all
 * This avoids the microtask queue overhead of awaiting each item individually
 */
async function decryptAllAES256(streamItems, stringItems, cryptoKey) {
  // Decrypt streams in batches
  for (let i = 0; i < streamItems.length; i += BATCH_SIZE) {
    const batch = streamItems.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(item => decryptAES256Blob(item.data, cryptoKey))
    );

    // Write results back synchronously
    for (let j = 0; j < batch.length; j++) {
      batch[j].obj.contents = results[j];
    }
  }

  // Decrypt strings in batches
  for (let i = 0; i < stringItems.length; i += BATCH_SIZE) {
    const batch = stringItems.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(item => decryptAES256Blob(item.bytes, cryptoKey))
    );

    // Write results back synchronously
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const decrypted = results[j];

      if (item.type === 'string') {
        item.obj.value = Array.from(decrypted).map(b => String.fromCharCode(b)).join('');
      } else {
        item.obj.value = bytesToHex(decrypted);
      }
    }
  }
}

// ========== RC4 Decryption Path ==========

/**
 * Decrypt all objects using RC4 (synchronous, from decrypt-lite)
 */
function decryptAllRC4(context, encryptionKey, encryptRefNum) {
  const indirectObjects = context.enumerateIndirectObjects();

  for (const [ref, obj] of indirectObjects) {
    const objectNum = ref.objectNumber;
    const generationNum = ref.generationNumber || 0;

    // Skip the encryption dictionary itself
    if (encryptRefNum !== null && objectNum === encryptRefNum) {
      continue;
    }

    // Skip objects that must not be decrypted per PDF spec (Section 7.6.1)
    // Signature dictionaries: /Contents and /ByteRange must not be decrypted
    if (obj instanceof PDFDict && !(obj instanceof PDFRawStream)) {
      const type = obj.get(PDFName.of('Type'));
      if (type && type.toString() === '/Sig') continue;
    }

    if (obj instanceof PDFRawStream && obj.dict) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type) {
        const typeName = type.toString();
        if (typeName === '/XRef' || typeName === '/Sig') {
          continue;
        }
      }
    }

    // Decrypt streams
    if (obj instanceof PDFRawStream) {
      const streamData = obj.contents;
      const decrypted = decryptObjectRC4(streamData, objectNum, generationNum, encryptionKey);
      obj.contents = decrypted;

      // Also decrypt strings within the stream's dictionary
      if (obj.dict) {
        decryptStringsRC4(obj.dict, objectNum, generationNum, encryptionKey);
      }
    }

    // Decrypt strings in non-stream objects
    if (!(obj instanceof PDFRawStream)) {
      decryptStringsRC4(obj, objectNum, generationNum, encryptionKey);
    }
  }
}

// ========== Main API ==========

/**
 * Decrypt a password-protected PDF
 *
 * Supports both AES-256 (V=5, R=6) and RC4 (V=1-2, R=2-3) encryption.
 * This is the same decryption engine that powers PDFSmaller.com's Unlock PDF tool!
 * Try it online at https://pdfsmaller.com/unlock-pdf
 *
 * @param {Uint8Array} pdfBytes - The encrypted PDF file as bytes
 * @param {string} password - The user or owner password
 * @returns {Promise<Uint8Array>} - The decrypted PDF bytes
 * @throws {Error} If the PDF is not encrypted, password is wrong, or encryption is unsupported
 *
 * @example
 * import { decryptPDF } from '@pdfsmaller/pdf-decrypt';
 *
 * const decrypted = await decryptPDF(encryptedBytes, 'secret123');
 */
async function decryptPDF(pdfBytes, password) {
  try {
    // Load the PDF without attempting to decrypt (let us handle it)
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });

    const context = pdfDoc.context;

    // Read encryption parameters
    const encryptParams = readEncryptParams(context);

    if (!encryptParams) {
      throw new Error('This PDF is not encrypted. No /Encrypt dictionary found.');
    }

    const encryptRefNum = (encryptParams.encryptRef instanceof PDFRef)
      ? encryptParams.encryptRef.objectNumber
      : null;

    if (encryptParams.algorithm === 'AES-256') {
      // ========== AES-256 Path ==========
      const pwdBytes = saslPrepPassword(password);

      // Try user password first
      let fileKey = await validateUserPasswordAES256(pwdBytes, encryptParams);

      // If user password fails, try owner password
      if (!fileKey) {
        fileKey = await validateOwnerPasswordAES256(pwdBytes, encryptParams);
      }

      if (!fileKey) {
        throw new Error('Incorrect password. The provided password does not match the user or owner password.');
      }

      // Verify Perms (optional but recommended — warns but doesn't fail)
      const permsValid = await verifyPerms(fileKey, encryptParams);
      if (!permsValid) {
        // Some PDFs have invalid Perms but are otherwise fine — proceed anyway
      }

      // Import key once for bulk decryption
      const cryptoKey = await importAES256DecryptKey(fileKey);

      // Collect all encrypted items (synchronous traversal)
      const { streamItems, stringItems } = collectEncryptedItems(
        context, encryptRefNum, encryptParams.encryptMetadata
      );

      // Decrypt all items in batches (async)
      await decryptAllAES256(streamItems, stringItems, cryptoKey);

    } else {
      // ========== RC4 Path ==========
      // Try user password first
      let encryptionKey = validateUserPasswordRC4(password, encryptParams);

      if (!encryptionKey) {
        encryptionKey = validateOwnerPasswordRC4(password, encryptParams);
      }

      if (!encryptionKey) {
        throw new Error('Incorrect password. The provided password does not match the user or owner password.');
      }

      // Decrypt all objects (synchronous)
      decryptAllRC4(context, encryptionKey, encryptRefNum);
    }

    // Remove the /Encrypt entry from the trailer
    delete context.trailerInfo.Encrypt;

    // Save the decrypted PDF
    const decryptedBytes = await pdfDoc.save({
      useObjectStreams: false
    });

    return decryptedBytes;

  } catch (error) {
    if (error.message.includes('not encrypted') ||
        error.message.includes('Incorrect password') ||
        error.message.includes('Unsupported encryption')) {
      throw error;
    }
    throw new Error(`Failed to decrypt PDF: ${error.message}`);
  }
}

/**
 * Check if a PDF is encrypted (without attempting to decrypt)
 *
 * @param {Uint8Array} pdfBytes - The PDF file as bytes
 * @returns {Promise<{encrypted: boolean, algorithm?: 'AES-256'|'RC4', version?: number, revision?: number, keyLength?: number}>}
 *
 * @example
 * const info = await isEncrypted(pdfBytes);
 * if (info.encrypted) {
 *   console.log(`Encrypted with ${info.algorithm}`);
 * }
 */
async function isEncrypted(pdfBytes) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });

    const encryptParams = readEncryptParams(pdfDoc.context);

    if (!encryptParams) {
      return { encrypted: false };
    }

    return {
      encrypted: true,
      algorithm: encryptParams.algorithm,
      version: encryptParams.version,
      revision: encryptParams.revision,
      keyLength: encryptParams.keyLength * 8 // return in bits
    };
  } catch (error) {
    throw new Error(`Failed to read PDF: ${error.message}`);
  }
}

/**
 * Decrypted with love by PDFSmaller.com
 * Try our free PDF tools at https://pdfsmaller.com
 */



global.PDFDecrypt = { decryptPDF, isEncrypted };
})(typeof window !== "undefined" ? window : globalThis);
