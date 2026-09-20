import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export const listAndroidSdkCandidates = ({
  platform = process.platform,
  env = process.env,
  homeDir = homedir()
} = {}) => {
  const standardPath = platform === 'win32' && nonEmpty(env.LOCALAPPDATA)
    ? join(env.LOCALAPPDATA, 'Android', 'Sdk')
    : platform === 'darwin'
      ? join(homeDir, 'Library', 'Android', 'sdk')
      : join(homeDir, 'Android', 'Sdk');
  return [...new Set([env.ANDROID_HOME, env.ANDROID_SDK_ROOT, standardPath].filter(nonEmpty))];
};

export const resolveAndroidSdk = ({ exists = existsSync, ...options } = {}) => {
  return listAndroidSdkCandidates(options)
    .find((candidate) => exists(join(candidate, 'platform-tools'))) ?? null;
};

export const configureAndroidSdkEnvironment = (env = process.env, options = {}) => {
  const configuredSdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].find(nonEmpty);
  const sdk = resolveAndroidSdk({ ...options, env });
  if (!sdk) return env;
  if (configuredSdk === sdk) return env;
  env.ANDROID_HOME = sdk;
  env.ANDROID_SDK_ROOT = sdk;
  return env;
};

const childDirectories = (root, readDirectory) => {
  if (!nonEmpty(root)) return [];
  try {
    return readDirectory(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /(?:jdk|java|microsoft).*21/iu.test(entry.name))
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
};

export const listJavaHomeCandidates = ({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  readDirectory = readdirSync
} = {}) => {
  const scanRoots = platform === 'win32'
    ? [
        nonEmpty(env.LOCALAPPDATA) ? join(env.LOCALAPPDATA, 'relay-toolchains') : null,
        nonEmpty(env.LOCALAPPDATA) ? join(env.LOCALAPPDATA, 'Programs', 'Microsoft') : null
      ]
    : [join(homeDir, '.jdks'), '/usr/lib/jvm', '/usr/java'];
  return [...new Set([
    env.JAVA_HOME_21_X64,
    env.JAVA_HOME_21,
    env.JDK_HOME,
    env.JAVA_HOME,
    ...scanRoots.flatMap((root) => childDirectories(root, readDirectory))
  ].filter(nonEmpty))];
};

const defaultJava21Check = (executable) => {
  try {
    const result = spawnSync(executable, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return result.status === 0 && /\bversion\s+["']21(?:[.-]|["'])/iu.test(output);
  } catch {
    return false;
  }
};

export const resolveJavaHome = ({
  candidates,
  exists = existsSync,
  runJava = defaultJava21Check,
  platform = process.platform,
  ...options
} = {}) => {
  const javaExecutable = platform === 'win32' ? 'java.exe' : 'java';
  return (candidates ?? listJavaHomeCandidates({ platform, ...options }))
    .find((candidate) => {
      const executable = join(candidate, 'bin', javaExecutable);
      return exists(executable) && runJava(executable);
    }) ?? null;
};

export const configureJavaEnvironment = (env = process.env, options = {}) => {
  const javaHome = resolveJavaHome({ ...options, env });
  if (javaHome) env.JAVA_HOME = javaHome;
  return env;
};
