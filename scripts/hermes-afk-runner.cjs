#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function parseArgs(argv) {
  const out = {
    promptFile: 'rpg-master-prompt.txt',
    logFile: 'hermes-afk.log',
    autoContinue: false,
    continueToken: 'continue',
    maxContinues: 0,
    doneMarker: '',
    continuePattern: 'type\\s+["\\\']?continue["\\\']?|ask\\s+for\\s+["\\\']?continue["\\\']?|wait\\s+for\\s+["\\\']?continue["\\\']?',
    minOutputBeforeContinue: 500,
    preset: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--prompt-file' && next) {
      out.promptFile = next;
      i += 1;
    } else if (arg === '--log-file' && next) {
      out.logFile = next;
      i += 1;
    } else if (arg === '--continue-token' && next) {
      out.continueToken = next;
      i += 1;
    } else if (arg === '--max-continues' && next) {
      out.maxContinues = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--done-marker' && next) {
      out.doneMarker = next;
      i += 1;
    } else if (arg === '--continue-pattern' && next) {
      out.continuePattern = next;
      i += 1;
    } else if (arg === '--min-output-before-continue' && next) {
      out.minOutputBeforeContinue = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--auto-continue') {
      out.autoContinue = true;
    } else if (arg === '--preset' && next) {
      out.preset = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }

  if (out.preset.toLowerCase() === 'rpg') {
    out.autoContinue = true;
    out.maxContinues = out.maxContinues > 0 ? out.maxContinues : 20;
    out.doneMarker = out.doneMarker || 'RPG_PLAN_COMPLETE';
    out.logFile = out.logFile === 'hermes-afk.log' ? 'hermes-rpg-afk.log' : out.logFile;
  }

  if (Number.isNaN(out.maxContinues) || out.maxContinues < 0) {
    throw new Error('Invalid --max-continues value. Use a non-negative integer.');
  }

  if (Number.isNaN(out.minOutputBeforeContinue) || out.minOutputBeforeContinue < 0) {
    throw new Error('Invalid --min-output-before-continue value. Use a non-negative integer.');
  }

  return out;
}

function printHelp() {
  const lines = [
    'Usage: node scripts/hermes-afk-runner.cjs [options]',
    '',
    'Options:',
    '  --preset rpg                      Enable RPG defaults (auto-continue, done marker)',
    '  --prompt-file <path>              Prompt file to send first (default: rpg-master-prompt.txt)',
    '  --log-file <path>                 Log file path (default: hermes-afk.log)',
    '  --auto-continue                   Enable automatic continue injection',
    '  --continue-token <text>           Text to send when continue prompt is detected',
    '  --max-continues <n>               Max auto-continues to send (default: 0 unless preset)',
    '  --done-marker <text>              End marker that closes stdin when detected',
    '  --continue-pattern <regex>        Regex used to detect continue prompts',
    '  --min-output-before-continue <n>  Wait for output bytes before auto-continue',
    '  --help                            Show this help',
    '',
    'This tool is opt-in only. It does not modify Hermes defaults or regular project behavior.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const promptPath = path.resolve(opts.promptFile);
  const logPath = path.resolve(opts.logFile);

  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }

  const prompt = fs.readFileSync(promptPath, 'utf8');
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const continueRegex = new RegExp(opts.continuePattern, 'i');

  const child = spawn('hermes', [], {
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let totalOutputChars = 0;
  let recentOutput = '';
  let continueCount = 0;
  let doneSeen = false;
  let lastContinueAtChars = -1;

  const appendOutput = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    logStream.write(text);

    totalOutputChars += text.length;
    recentOutput = (recentOutput + text).slice(-16000);

    if (opts.doneMarker && !doneSeen && recentOutput.includes(opts.doneMarker)) {
      doneSeen = true;
      process.stderr.write(`\n[hermes-afk-runner] Done marker detected: ${opts.doneMarker}\n`);
      child.stdin.end();
      return;
    }

    if (!opts.autoContinue) {
      return;
    }

    if (opts.maxContinues > 0 && continueCount >= opts.maxContinues) {
      return;
    }

    if (totalOutputChars < opts.minOutputBeforeContinue) {
      return;
    }

    const shouldContinue = continueRegex.test(recentOutput);
    const minGap = 80;

    if (shouldContinue && (lastContinueAtChars < 0 || (totalOutputChars - lastContinueAtChars) > minGap)) {
      continueCount += 1;
      lastContinueAtChars = totalOutputChars;
      const token = `${opts.continueToken}\n`;
      child.stdin.write(token);
      process.stderr.write(`[hermes-afk-runner] auto-continue ${continueCount}`);
      process.stderr.write('\n');
      logStream.write(`\n[hermes-afk-runner] auto-continue ${continueCount}\n`);
    }
  };

  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  child.on('error', (err) => {
    logStream.end();
    throw err;
  });

  child.on('close', (code) => {
    logStream.end();
    const summary = `[hermes-afk-runner] exit=${code} autoContinues=${continueCount} log=${logPath}`;
    process.stderr.write(`${summary}\n`);
    if (code && code !== 0) {
      process.exit(code);
    }
  });

  child.stdin.write(`${prompt}\n`);
}

try {
  main();
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`hermes-afk-runner error: ${message}\n`);
  process.exit(1);
}
