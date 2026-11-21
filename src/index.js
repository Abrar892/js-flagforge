'use strict';

const { evaluateAll, evaluateFlag, validateFlag } = require('./engine');
const { FlagStore } = require('./store');
const { createServer, startServer } = require('./server');

module.exports = {
  evaluateAll,
  evaluateFlag,
  validateFlag,
  FlagStore,
  createServer,
  startServer,
};
