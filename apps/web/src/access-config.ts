export type AccessConfig = {
  teamDomain: string;
  audience: string;
};

export type AccessConfigSource = {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
};

export function readAccessConfig(env: AccessConfigSource): AccessConfig | null {
  const audience = env.ACCESS_AUD.trim();
  const rawDomain = env.ACCESS_TEAM_DOMAIN.trim();
  if (
    audience === ''
    || audience.startsWith('REPLACE_WITH_')
    || !/^[a-zA-Z0-9_-]{16,256}$/u.test(audience)
    || rawDomain.includes('REPLACE_WITH_')
  ) {
    return null;
  }

  try {
    const url = new URL(rawDomain);
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
      || !url.hostname.endsWith('.cloudflareaccess.com')
    ) {
      return null;
    }
    return { teamDomain: url.origin, audience };
  } catch {
    return null;
  }
}
