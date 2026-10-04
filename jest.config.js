/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|test)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { decoratorMetadata: true, legacyDecorator: true },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@nestjs|@us-man-qa-sim|rxjs|uuid|iterare|tslib|jose)/)',
  ],
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '\\.module\\.ts$', 'main\\.ts$'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
};
