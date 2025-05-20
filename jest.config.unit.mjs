import config from './jest.config.mjs';

export default {
  ...config,
  testRegex: ".*\\.test\\.ts$",
}; 