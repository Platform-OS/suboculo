const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const configuredLevel = process.env.SUBOCULO_LOG_LEVEL || 'info';
const activeLevel = levels[configuredLevel] ?? levels.info;

function shouldLog(level) {
  return levels[level] <= activeLevel;
}

function log(level, ...args) {
  if (!shouldLog(level)) return;
  const method = level === 'debug' ? 'log' : level;
  console[method](...args);
}

module.exports = {
  error: (...args) => log('error', ...args),
  warn: (...args) => log('warn', ...args),
  info: (...args) => log('info', ...args),
  debug: (...args) => log('debug', ...args)
};
