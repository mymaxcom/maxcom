// Belt and braces: a test that forgets to name a cloud must not fall back to the MAXCOM production Worker.
// (The real guard is isBlockedUnderTest in src/sync/register.ts.)
process.env.SURAU_CLOUD_URL ??= 'https://cloud.invalid';
