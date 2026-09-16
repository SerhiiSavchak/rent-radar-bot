const SECRET_PATTERNS: Array<{ id: string; re: RegExp; replace: string }> = [
  { id: "api_key", re: /api_key=[^&\s"']+/gi, replace: "api_key=redacted" },
  { id: "bearer", re: /Bearer\s+[A-Za-z0-9._-]+/gi, replace: "Bearer [redacted]" },
  { id: "pem_block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: "[redacted-private-key]" },
  { id: "ssh_priv_path_content", re: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g, replace: "[redacted-openssh-private-key]" },
  { id: "ocid_user_keyish", re: /ocid1\.tenancy\.oc1\.\.[a-z0-9]+/gi, replace: "ocid1.tenancy.oc1..[redacted]" },
  { id: "password_url", re: /:\/\/[^/@\s]+:[^/@\s]+@/g, replace: "://[redacted]@" },
];

/** Strip secrets / private key material from evidence strings. */
export function sanitizeSoakText(input: string, maxLen = 400): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.re, pattern.replace);
  }
  // Drop long listing titles/bodies that look like private contact dumps
  out = out.replace(/tel:\+?\d[\d\s\-()]{6,}/gi, "tel:[redacted]");
  out = out.replace(/\b\d{10,16}\b/g, "[redacted-digits]");
  return out.slice(0, maxLen);
}

export function sanitizeSoakNotes(notes: string[] | undefined): string[] | undefined {
  if (!notes) {
    return undefined;
  }
  return notes.map((note) => sanitizeSoakText(note, 240));
}

export function assertNoSecretMaterial(payload: string): string[] {
  const hits: string[] = [];
  if (/BEGIN (RSA |OPENSSH )?PRIVATE KEY/i.test(payload)) {
    hits.push("private_key_block");
  }
  if (/api_key=[^r\s][^&\s]{8,}/i.test(payload) && !/api_key=redacted/i.test(payload)) {
    hits.push("api_key");
  }
  return hits;
}
