import config from './jest.config.mjs';

export default {
  ...config,
  roots: [
    "<rootDir>/e2e-tests/"
  ],
  testRegex: ".*\\.e2e-test\\.ts$",
  setupFilesAfterEnv: ['<rootDir>/e2e-tests/setup.ts']
};

// import baseConfig from '../../../jest.config.mjs';

// export default {
//   ...baseConfig,
//   roots: [
//     "<rootDir>/src/"
//   ],
//   testRegex: ".*\\.e2e-test\\.ts$",
//   transform: {
//     "^.+\\.tsx?$": ["ts-jest", {
//       tsconfig: '<rootDir>/tsconfig.json'
//     }]
//   },
//   setupFilesAfterEnv: ['<rootDir>/src/setup.ts'],
//   moduleFileExtensions: ['js', 'json', 'ts'],
// };