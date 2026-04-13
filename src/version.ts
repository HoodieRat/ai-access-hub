import * as fs from 'fs';
import * as path from 'path';

function readHubVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // Fall through to the sentinel version below if package.json is unreadable.
  }

  return 'unknown';
}

export const HUB_VERSION = readHubVersion();