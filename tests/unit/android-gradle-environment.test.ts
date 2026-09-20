import { describe, expect, it } from 'vitest';

import {
  configureAndroidSdkEnvironment,
  configureJavaEnvironment,
  listAndroidSdkCandidates,
  resolveJavaHome,
  resolveAndroidSdk
} from '../../apps/android/android-environment.mjs';

describe('Android Gradle SDK environment', () => {
  it('finds the Windows default SDK location without requiring a repository path', () => {
    expect(listAndroidSdkCandidates({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      homeDir: 'C:\\Users\\tester'
    })).toContain('C:\\Users\\tester\\AppData\\Local\\Android\\Sdk');
  });

  it('prefers a configured SDK whose platform-tools directory exists', () => {
    const existing = new Set(['C:\\android\\platform-tools']);
    expect(resolveAndroidSdk({
      platform: 'win32',
      env: { ANDROID_HOME: 'C:\\android', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      homeDir: 'C:\\Users\\tester',
      exists: (path) => existing.has(path)
    })).toBe('C:\\android');
  });

  it('falls back to the standard location when configured variables are stale', () => {
    const existing = new Set(['C:\\Users\\tester\\AppData\\Local\\Android\\Sdk\\platform-tools']);
    expect(resolveAndroidSdk({
      platform: 'win32',
      env: { ANDROID_HOME: 'C:\\missing', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      homeDir: 'C:\\Users\\tester',
      exists: (path) => existing.has(path)
    })).toBe('C:\\Users\\tester\\AppData\\Local\\Android\\Sdk');
  });

  it('sets both Gradle SDK variables only when neither is already configured', () => {
    const env: Record<string, string> = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' };
    configureAndroidSdkEnvironment(env, {
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      exists: (path) => path === 'C:\\Users\\tester\\AppData\\Local\\Android\\Sdk\\platform-tools'
    });
    expect(env).toMatchObject({
      ANDROID_HOME: 'C:\\Users\\tester\\AppData\\Local\\Android\\Sdk',
      ANDROID_SDK_ROOT: 'C:\\Users\\tester\\AppData\\Local\\Android\\Sdk'
    });
  });

  it('replaces a stale SDK variable with the standard SDK location', () => {
    const env: Record<string, string> = {
      ANDROID_HOME: 'C:\\missing',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
    };
    configureAndroidSdkEnvironment(env, {
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      exists: (path) => path === 'C:\\Users\\tester\\AppData\\Local\\Android\\Sdk\\platform-tools'
    });
    expect(env).toMatchObject({
      ANDROID_HOME: 'C:\\Users\\tester\\AppData\\Local\\Android\\Sdk',
      ANDROID_SDK_ROOT: 'C:\\Users\\tester\\AppData\\Local\\Android\\Sdk'
    });
  });

  it('chooses a Java 21 home when the existing Java home is an older runtime', () => {
    expect(resolveJavaHome({
      candidates: ['C:\\jdk-17', 'C:\\toolchains\\jdk-21'],
      exists: (path) => path.endsWith('\\bin\\java.exe'),
      runJava: (path) => path.startsWith('C:\\toolchains\\jdk-21')
    })).toBe('C:\\toolchains\\jdk-21');
  });

  it('replaces a stale JAVA_HOME with the detected Java 21 home', () => {
    const env: Record<string, string> = { JAVA_HOME: 'C:\\jdk-17' };
    configureJavaEnvironment(env, {
      candidates: ['C:\\jdk-17', 'C:\\toolchains\\jdk-21'],
      exists: (path) => path.endsWith('\\bin\\java.exe'),
      runJava: (path) => path.startsWith('C:\\toolchains\\jdk-21')
    });
    expect(env.JAVA_HOME).toBe('C:\\toolchains\\jdk-21');
  });
});
