// Random identifiers and digests.
import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"

/** `n` random bytes from the operating system. */
export const random = (n: number): Uint8Array => {
  const bytes = new Uint8Array(n)
  try {
    crypto.getRandomValues(bytes)
  } catch {
    // A defect, as the Rust's `expect` is: nothing can go on without it.
    throw new Error("operating system RNG is unavailable")
  }
  return bytes
}

/** SHA-256 of `data` (text is hashed as UTF-8). */
export const sha256 = (data: Uint8Array | string): Uint8Array => createHash("sha256").update(data).digest()

/** 32 random bytes, base64url-encoded without padding (43 characters). */
export const token = (): string => Buffer.from(random(32)).toString("base64url")

/** 32 random bytes as lowercase hex (64 characters). */
export const hex64 = (): string => Buffer.from(random(32)).toString("hex")

/** A random RFC 4122 version 4 UUID, lowercase. */
export const uuidV4 = (): string => randomUUID()
