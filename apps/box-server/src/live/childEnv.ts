/**
 * The environment of the helper programs the live feature starts (ffmpeg, MediaMTX): a bare one. Nothing of the box's
 * own variables (the kiosk token, the leave secret) is passed on; only what a program needs to find its libraries and
 * its temp folder.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'SSL_CERT_FILE']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}
