import chalk from 'chalk';
import { progress } from './progress.js';

function _log(fn, ...args) {
  progress.clear();
  fn(...args);
  progress.render();
}

export function logInfo(...args) {
  _log(console.log, ...args);
}

export function logSuccess(...args) {
  _log(console.log, chalk.green(...args));
}

export function logWarn(...args) {
  _log(console.log, chalk.yellow(...args));
}

export function logError(...args) {
  _log(console.log, chalk.red(...args));
}

export function logFatal(...args) {
  progress.clear();
  console.error(chalk.bgRed.white.bold(' FATAL '), chalk.red(...args));
  progress.render();
}

export function timestamp() {
  return chalk.gray(`[${new Date().toLocaleTimeString()}]`);
}
