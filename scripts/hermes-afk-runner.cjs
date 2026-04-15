#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_FATAL_PATTERNS = [
  'Empty response from model',
  'Empty response after tool calls',
  'Model returned no content after all retries',
  'No fallback providers configured',
  'Model returned no content',
];

const DEFAULT_TOOL_ERROR_PATTERNS = [
  '\\bpatch\\b.*\\[error\\]',
  '\\bread\\b.*\\[error\\]',
  '\\bread_file\\b.*\\[error\\]',
  '\\bapply_patch\\b.*\\[error\\]',
];

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split('||')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    promptFile: 'rpg-master-prompt.txt',
    prependPromptFile: '',
    recoveryPromptFile: '',
    logFile: 'hermes-afk.log',
    autoContinue: false,
    continueToken: 'continue',
    maxContinues: 0,
    maxRecoveries: 0,
    doneMarker: '',
    continuePattern: 'type\\s+["\\\']?continue["\\\']?|ask\\s+for\\s+["\\\']?continue["\\\']?|wait\\s+for\\s+["\\\']?continue["\\\']?',
    minOutputBeforeContinue: 500,
    fatalPatterns: [...DEFAULT_FATAL_PATTERNS],
    toolErrorPatterns: [...DEFAULT_TOOL_ERROR_PATTERNS],
    toolErrorThreshold: 2,
    stopOnFatal: false,
    recoverOnFatal: false,
    preset: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--prompt-file' && next) {
      out.promptFile = next;
      i += 1;
    } else if (arg === '--prepend-prompt-file' && next) {
      out.prependPromptFile = next;
      i += 1;
    } else if (arg === '--recovery-prompt-file' && next) {
      out.recoveryPromptFile = next;
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
    } else if (arg === '--max-recoveries' && next) {
      out.maxRecoveries = Number.parseInt(next, 10);
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
    } else if (arg === '--fatal-patterns' && next) {
      out.fatalPatterns = parseList(next);
      i += 1;
    } else if (arg === '--tool-error-patterns' && next) {
      out.toolErrorPatterns = parseList(next);
      i += 1;
    } else if (arg === '--tool-error-threshold' && next) {
      out.toolErrorThreshold = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--auto-continue') {
      out.autoContinue = true;
    } else if (arg === '--stop-on-fatal') {
      out.stopOnFatal = true;
    } else if (arg === '--recover-on-fatal') {
      out.recoverOnFatal = true;
    } else if (arg === '--preset' && next) {
      out.preset = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }

  const preset = out.preset.toLowerCase();
  if (preset === 'rpg') {
    out.autoContinue = true;
    out.maxContinues = out.maxContinues > 0 ? out.maxContinues : 20;
    out.doneMarker = out.doneMarker || 'RPG_PLAN_COMPLETE';
    out.logFile = out.logFile === 'hermes-afk.log' ? 'hermes-rpg-afk.log' : out.logFile;
  }

  if (preset === 'caveman') {
    out.autoContinue = true;
    out.stopOnFatal = true;
    out.recoverOnFatal = true;
    out.maxContinues = out.maxContinues > 0 ? out.maxContinues : 12;
    out.maxRecoveries = out.maxRecoveries > 0 ? out.maxRecoveries : 1;
    out.minOutputBeforeContinue = out.minOutputBeforeContinue > 500 ? out.minOutputBeforeContinue : 900;
    out.toolErrorThreshold = out.toolErrorThreshold > 2 ? out.toolErrorThreshold : 2;
    out.doneMarker = out.doneMarker || 'RPG_PLAN_COMPLETE';
    out.logFile = out.logFile === 'hermes-afk.log' ? 'hermes-caveman-afk.log' : out.logFile;
    out.prependPromptFile = out.prependPromptFile || 'prompts/hermes-caveman-system.txt';
    out.recoveryPromptFile = out.recoveryPromptFile || 'prompts/hermes-caveman-recover.txt';
  }

  if (Number.isNaN(out.maxContinues) || out.maxContinues < 0) {
    throw new Error('Invalid --max-continues value. Use a non-negative integer.');
  }

  if (Number.isNaN(out.maxRecoveries) || out.maxRecoveries < 0) {
    throw new Error('Invalid --max-recoveries value. Use a non-negative integer.');
  }

  if (Number.isNaN(out.minOutputBeforeContinue) || out.minOutputBeforeContinue < 0) {
    throw new Error('Invalid --min-output-before-continue value. Use a non-negative integer.');
  }

  if (Number.isNaN(out.toolErrorThreshold) || out.toolErrorThreshold < 1) {
    throw new Error('Invalid --tool-error-threshold value. Use an integer greater than 0.');
  }

  return out;
}

function printHelp() {
  const lines = [
    'Usage: node scripts/hermes-afk-runner.cjs [options]',
    '',
    'Options:',
    '  --preset rpg|caveman             Enable a preset for RPG or conservative recovery runs',
    '  --prompt-file <path>              Prompt file to send first (default: rpg-master-prompt.txt)',
    '  --prepend-prompt-file <path>      Prompt file prepended ahead of the main prompt',
    '  --recovery-prompt-file <path>     Prompt file injected once after a fatal failure',
    '  --log-file <path>                 Log file path (default: hermes-afk.log)',
    '  --auto-continue                   Enable automatic continue injection',
    '  --continue-token <text>           Text to send when continue prompt is detected',
    '  --max-continues <n>               Max auto-continues to send (default: 0 unless preset)',
    '  --max-recoveries <n>              Max recovery prompts to inject after fatal failures',
    '  --done-marker <text>              End marker that closes stdin when detected',
    '  --continue-pattern <regex>        Regex used to detect continue prompts',
    '  --fatal-patterns <a||b>           Fatal transcript substrings (literal matches)',
    '  --tool-error-patterns <a||b>      Regex list used to count tool errors',
    '  --tool-error-threshold <n>        Fatal threshold for tool error matches',
    '  --stop-on-fatal                   Exit after a fatal condition is detected',
    '  --recover-on-fatal                Inject the recovery prompt once after a fatal condition',
    '  --min-output-before-continue <n>  Wait for output bytes before auto-continue',
    '  --help                            Show this help',
    '',
    'This tool is opt-in only. It does not modify Hermes defaults or regular project behavior.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function resolveFileOrEmpty(inputPath) {
  if (!inputPath) {
    return '';
  }

  return path.resolve(inputPath);
}

function readRequiredText(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  return fs.readFileSync(filePath, 'utf8');
}

function summarizeFatalReason(state) {
  if (state.fatalReason) {
    return state.fatalReason;
  }

  if (state.toolErrorCount >= state.toolErrorThreshold) {
    return `tool error threshold reached (${state.toolErrorCount})`;
  }

  return 'unknown fatal condition';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const promptPath = path.resolve(opts.promptFile);
  const prependPromptPath = resolveFileOrEmpty(opts.prependPromptFile);
  const recoveryPromptPath = resolveFileOrEmpty(opts.recoveryPromptFile);
  const logPath = path.resolve(opts.logFile);

  const promptParts = [];
  if (prependPromptPath) {
    promptParts.push(readRequiredText(prependPromptPath).trimEnd());
  }
  promptParts.push(readRequiredText(promptPath).trimEnd());
  const prompt = `${promptParts.join('\n\n')}\n`;
  const recoveryPrompt = recoveryPromptPath ? `${readRequiredText(recoveryPromptPath).trimEnd()}\n` : '';

  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const continueRegex = new RegExp(opts.continuePattern, 'i');
  const toolErrorRegexes = opts.toolErrorPatterns.map((pattern) => new RegExp(pattern, 'i'));

  const state = {
    totalOutputChars: 0,
    recentOutput: '',
    continueCount: 0,
    recoveryCount: 0,
    doneSeen: false,
    fatalSeen: false,
    fatalReason: '',
    toolErrorCount: 0,
    toolErrorThreshold: opts.toolErrorThreshold,
    lastContinueAtChars: -1,
    startTime: new Date(),
  };

  const fatalMatches = [];
  const child = spawn('hermes', [], {
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const sessionHeader = [
    `[hermes-afk-runner] start=${state.startTime.toISOString()}`,
    `[hermes-afk-runner] cwd=${process.cwd()}`,
    `[hermes-afk-runner] promptFile=${promptPath}`,
    `[hermes-afk-runner] prependPromptFile=${prependPromptPath || '-'}`,
    `[hermes-afk-runner] recoveryPromptFile=${recoveryPromptPath || '-'}`,
    `[hermes-afk-runner] preset=${opts.preset || '-'}`,
    `[hermes-afk-runner] autoContinue=${opts.autoContinue}`,
    `[hermes-afk-runner] maxContinues=${opts.maxContinues}`,
    `[hermes-afk-runner] stopOnFatal=${opts.stopOnFatal}`,
    `[hermes-afk-runner] recoverOnFatal=${opts.recoverOnFatal}`,
    `[hermes-afk-runner] maxRecoveries=${opts.maxRecoveries}`,
    `[hermes-afk-runner] doneMarker=${opts.doneMarker || '-'}`,
    '',
  ].join('\n');
  logStream.write(sessionHeader);
  process.stderr.write(`${sessionHeader}`);

  function finishWithSummary(code) {
    const endTime = new Date();
    const summaryLines = [
      '',
      `[hermes-afk-runner] end=${endTime.toISOString()}`,
      `[hermes-afk-runner] durationMs=${endTime.getTime() - state.startTime.getTime()}`,
      `[hermes-afk-runner] exit=${code}`,
      `[hermes-afk-runner] autoContinues=${state.continueCount}`,
      `[hermes-afk-runner] recoveries=${state.recoveryCount}`,
      `[hermes-afk-runner] toolErrors=${state.toolErrorCount}`,
      `[hermes-afk-runner] doneSeen=${state.doneSeen}`,
      `[hermes-afk-runner] fatalSeen=${state.fatalSeen}`,
      `[hermes-afk-runner] fatalReason=${state.fatalSeen ? summarizeFatalReason(state) : '-'}`,
      `[hermes-afk-runner] log=${logPath}`,
    ];

    if (fatalMatches.length > 0) {
      summaryLines.push(`[hermes-afk-runner] fatalMatches=${fatalMatches.join(' | ')}`);
    }

    const summary = `${summaryLines.join('\n')}\n`;
    process.stderr.write(summary);
    logStream.write(summary);
    logStream.end();
    if (code && code !== 0) {
      process.exit(code);
    }
  }

  function markFatal(reason) {
    if (state.fatalSeen) {
      return;
    }

    state.fatalSeen = true;
    state.fatalReason = reason;
    const line = `[hermes-afk-runner] fatal=${reason}`;
    process.stderr.write(`${line}\n`);
    logStream.write(`${line}\n`);
  }

  function handleFatal() {
    if (!state.fatalSeen) {
      return;
    }

    if (opts.recoverOnFatal && recoveryPrompt && state.recoveryCount < opts.maxRecoveries) {
      state.recoveryCount += 1;
      const line = `[hermes-afk-runner] recovery=${state.recoveryCount}`;
      process.stderr.write(`${line}\n`);
      logStream.write(`${line}\n`);
      child.stdin.write(recoveryPrompt);
      return;
    }

    if (opts.stopOnFatal) {
      child.stdin.end();
    }
  }

  const appendOutput = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    logStream.write(text);

    state.totalOutputChars += text.length;
    state.recentOutput = (state.recentOutput + text).slice(-24000);

    if (!state.fatalSeen) {
      for (const pattern of opts.fatalPatterns) {
        if (state.recentOutput.includes(pattern)) {
          fatalMatches.push(pattern);
          markFatal(`matched fatal pattern: ${pattern}`);
          handleFatal();
          break;
        }
      }
    }

    if (!state.fatalSeen) {
      for (const regex of toolErrorRegexes) {
        if (regex.test(text)) {
          state.toolErrorCount += 1;
          const line = `[hermes-afk-runner] toolErrorCount=${state.toolErrorCount}`;
          process.stderr.write(`${line}\n`);
          logStream.write(`${line}\n`);
          if (state.toolErrorCount >= opts.toolErrorThreshold) {
            fatalMatches.push(`tool-error-threshold:${state.toolErrorCount}`);
            markFatal(`tool error threshold reached (${state.toolErrorCount})`);
            handleFatal();
          }
          break;
        }
      }
    }

    if (opts.doneMarker && !state.doneSeen && state.recentOutput.includes(opts.doneMarker)) {
      state.doneSeen = true;
      const line = `[hermes-afk-runner] done=${opts.doneMarker}`;
      process.stderr.write(`${line}\n`);
      logStream.write(`${line}\n`);
      child.stdin.end();
      return;
    }

    if (state.fatalSeen || !opts.autoContinue) {
      return;
    }

    if (opts.maxContinues > 0 && state.continueCount >= opts.maxContinues) {
      return;
    }

    if (state.totalOutputChars < opts.minOutputBeforeContinue) {
      return;
    }

    const shouldContinue = continueRegex.test(state.recentOutput);
    const minGap = 120;

    if (shouldContinue && (state.lastContinueAtChars < 0 || (state.totalOutputChars - state.lastContinueAtChars) > minGap)) {
      state.continueCount += 1;
      state.lastContinueAtChars = state.totalOutputChars;
      const token = `${opts.continueToken}\n`;
      child.stdin.write(token);
      const line = `[hermes-afk-runner] auto-continue ${state.continueCount}`;
      process.stderr.write(`${line}\n`);
      logStream.write(`${line}\n`);
    }
  };

  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  child.on('error', (err) => {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`[hermes-afk-runner] spawn-error=${message}\n`);
    logStream.write(`[hermes-afk-runner] spawn-error=${message}\n`);
    finishWithSummary(1);
  });

  child.on('close', (code) => {
    finishWithSummary(code || 0);
  });

  child.stdin.write(prompt);
}

try {
  main();
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`hermes-afk-runner error: ${message}\n`);
  process.exit(1);
}
