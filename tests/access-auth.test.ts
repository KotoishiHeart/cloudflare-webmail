import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifyAccessToken } from '../apps/web/src/access-auth.js';
import { readAccessConfig } from '../apps/web/src/access-config.js';

const CONFIG = {
  teamDomain: 'https://team.cloudflareaccess.com',
  audience: 'audience_1234567890',
};

describe('Cloudflare Access authentication', () => {
  it('accepts only a configured Cloudflare Access team domain and audience', () => {
    expect(readAccessConfig({
      ACCESS_TEAM_DOMAIN: `${CONFIG.teamDomain}/`,
      ACCESS_AUD: CONFIG.audience,
    })).toEqual(CONFIG);
    expect(readAccessConfig({
      ACCESS_TEAM_DOMAIN: 'https://REPLACE_WITH_TEAM.cloudflareaccess.com',
      ACCESS_AUD: 'REPLACE_WITH_ACCESS_AUD',
    })).toBeNull();
    expect(readAccessConfig({
      ACCESS_TEAM_DOMAIN: 'https://cloudflareaccess.com.attacker.example',
      ACCESS_AUD: CONFIG.audience,
    })).toBeNull();
  });

  it('verifies the RS256 signature, issuer, audience, and identity claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const keys: JWTVerifyGetKey = async () => publicKey;
    const token = await accessToken(privateKey);

    await expect(verifyAccessToken(token, CONFIG, keys)).resolves.toEqual({
      issuer: CONFIG.teamDomain,
      subject: 'access-user-subject',
      email: 'owner@example.com',
    });
    await expect(verifyAccessToken(
      token,
      { ...CONFIG, audience: 'different_audience' },
      keys,
    )).rejects.toThrow();
  });

  it('does not treat a service token as an interactive webmail identity', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const keys: JWTVerifyGetKey = async () => publicKey;
    const token = await accessToken(privateKey, { subject: '' });

    await expect(verifyAccessToken(token, CONFIG, keys)).resolves.toBeNull();
  });
});

async function accessToken(
  privateKey: CryptoKey,
  identity: { subject: string; email?: string } = {
    subject: 'access-user-subject',
    email: 'Owner@Example.com',
  },
): Promise<string> {
  return new SignJWT({ type: 'app', email: identity.email })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(CONFIG.teamDomain)
    .setAudience(CONFIG.audience)
    .setSubject(identity.subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
