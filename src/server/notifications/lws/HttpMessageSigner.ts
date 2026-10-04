/* eslint-disable @typescript-eslint/naming-convention */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import type { JwkGenerator } from '../../../identity/configuration/JwkGenerator';

/**
 * The components covered by the signature, as required by the LWS Webhook notification suite.
 */
export const SIGNATURE_COMPONENTS = [ '@method', '@scheme', '@authority', '@path', 'content-type', 'content-digest' ];

/**
 * Computes the `Content-Digest` header value of the given body, as defined in RFC 9530, using SHA-256.
 */
export function createContentDigest(body: string): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

/**
 * Creates HTTP Message Signatures (RFC 9421) for POST requests,
 * covering the components required by the LWS Webhook notification suite.
 * Only ES256 keys are supported.
 */
export class HttpMessageSigner {
  private readonly jwkGenerator: JwkGenerator;

  public constructor(jwkGenerator: JwkGenerator) {
    this.jwkGenerator = jwkGenerator;
  }

  /**
   * Returns the public key used to verify the signatures.
   */
  public async getPublicKey(): Promise<Record<string, unknown>> {
    return { ...await this.jwkGenerator.getPublicKey() };
  }

  /**
   * Generates the headers needed to sign a POST request with the given body.
   *
   * @param url - The target URL of the request.
   * @param contentType - The content type of the body.
   * @param body - The body of the request.
   * @param keyId - The `keyid` parameter of the signature.
   */
  public async sign(url: string, contentType: string, body: string, keyId: string): Promise<Record<string, string>> {
    const target = new URL(url);
    const contentDigest = createContentDigest(body);
    const created = Math.floor(Date.now() / 1000);
    const parameters = `(${SIGNATURE_COMPONENTS.map((component): string => `"${component}"`).join(' ')})` +
      `;created=${created};keyid="${keyId}";alg="ecdsa-p256-sha256"`;
    const values: Record<string, string> = {
      '@method': 'POST',
      '@scheme': target.protocol.slice(0, -1),
      '@authority': target.host,
      '@path': target.pathname,
      'content-type': contentType,
      'content-digest': contentDigest,
    };
    const signatureBase = [
      ...SIGNATURE_COMPONENTS.map((component): string => `"${component}": ${values[component]}`),
      `"@signature-params": ${parameters}`,
    ].join('\n');

    const privateKey = createPrivateKey({ key: { ...await this.jwkGenerator.getPrivateKey() }, format: 'jwk' });
    const signature = sign('sha256', Buffer.from(signatureBase), { key: privateKey, dsaEncoding: 'ieee-p1363' });

    return {
      'content-type': contentType,
      'content-digest': contentDigest,
      'signature-input': `sig1=${parameters}`,
      signature: `sig1=:${signature.toString('base64')}:`,
    };
  }
}
