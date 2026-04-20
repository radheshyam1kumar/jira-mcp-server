export function buildBasicAuthHeader(email, apiToken) {
  const token = Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}
