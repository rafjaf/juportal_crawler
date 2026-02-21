import chalk from 'chalk';

export function logInfo(...args) {
  console.log(...args);
}

export function logSuccess(...args) {
  console.log(chalk.green(...args));
}

export function logWarn(...args) {
  console.log(chalk.yellow(...args));
}

export function logError(...args) {
  console.log(chalk.red(...args));
}

export function logFatal(...args) {
  console.error(chalk.bgRed.white.bold(' FATAL '), chalk.red(...args));
}

export function timestamp() {
  return chalk.gray(`[${new Date().toLocaleTimeString()}]`);
}
