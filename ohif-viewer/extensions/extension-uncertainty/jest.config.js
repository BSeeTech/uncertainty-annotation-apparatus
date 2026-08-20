/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.(ts|tsx)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  moduleNameMapper: {
    '^@cornerstonejs/core$': '<rootDir>/src/__tests__/mocks/cornerstone.ts',
    '^@cornerstonejs/tools$': '<rootDir>/src/__tests__/mocks/cornerstone-tools.ts',
    '^@kitware/vtk.js/(.*)$': '<rootDir>/src/__tests__/mocks/vtk.ts',
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['babel-jest', {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        ['@babel/preset-react', { runtime: 'automatic' }],
        '@babel/preset-typescript',
      ],
    }],
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/__tests__/**',
  ],
};
