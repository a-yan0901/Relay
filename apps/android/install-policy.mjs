const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

export const parseSha256sum = (output) => {
  const match = String(output).trim().match(/^([0-9a-f]{64})(?:\s+.*)?$/imu);
  return match?.[1]?.toLowerCase() ?? null;
};

export const shouldInstallDebugApk = (localSha256, remoteSha256) => {
  if (typeof localSha256 !== 'string' || !SHA256_PATTERN.test(localSha256)) return true;
  if (typeof remoteSha256 !== 'string' || !SHA256_PATTERN.test(remoteSha256)) return true;
  return localSha256.toLowerCase() !== remoteSha256.toLowerCase();
};
